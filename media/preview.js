// Injected into VS Code's built-in Markdown preview via `contributes.markdown.previewScripts`.
//
// There is no webview->extension message channel available here: the built-in preview already
// called acquireVsCodeApi(), and it can only be called once per webview. So instead of messaging,
// we annotate the DOM with `data-vscode-context` and let a `webview/context` menu item carry the
// payload to a normal command in the extension host.
//
// Core's contextmenu handler (workbench webview pre/index.html) reads `data-vscode-context` at
// event time, walking up ancestors with closest() and merging inner-most-first. It is a bubble-
// phase listener on the iframe's window, so our capture-phase listener on `document` is guaranteed
// to run first and can set the attribute live. It bails on `e.defaultPrevented`, so we must never
// preventDefault here.
(function () {
	'use strict';

	const SECTION = 'agentCommentsPreviewTarget';
	// Right-clicking the floating marker (below) acts on every comment on that block — with a
	// quickpick to disambiguate if there's more than one.
	const MARKER_SECTION = 'agentCommentsMarkerTarget';
	// Right-clicking a specific row in the click-to-expand panel acts on just that one comment —
	// no quickpick needed, since exactly one id is ever in scope for this section.
	const ROW_SECTION = 'agentCommentsPanelRowTarget';
	const MAX_SELECTION_CHARS = 200;

	// The preview embeds its own settings, including `source` — the URI of the .md being rendered.
	// This is why the extension host never has to guess which file a preview is showing.
	function readSource() {
		try {
			const meta = document.getElementById('vscode-markdown-preview-data');
			const settings = JSON.parse(meta.getAttribute('data-settings'));
			return typeof settings.source === 'string' ? settings.source : undefined;
		} catch (e) {
			console.error('Agentic Comments: could not read markdown preview settings', e);
			return undefined;
		}
	}

	function lineOf(el) {
		return Number(el.getAttribute('data-line'));
	}

	// Source lines come from the preview's own scroll-sync map: every non-inline markdown-it token
	// with a source map gets `class="code-line" data-line="<zero-based line>"`. Accepts text nodes,
	// since Range boundaries usually are one.
	function findCodeLine(node) {
		const start = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
		if (!start || typeof start.closest !== 'function') {
			return null;
		}
		// closest() gives the *innermost* mapped block, so a nested <li> wins over its <ul>.
		const self = start.closest('.code-line[data-line]');
		if (self) {
			return self;
		}
		// No mapped ancestor (raw HTML blocks, mostly): fall back to the nearest *preceding* mapped
		// element, which is the block this content belongs to. Never guess forwards.
		let el = start;
		while (el) {
			let sib = el.previousElementSibling;
			while (sib) {
				if (sib.matches('.code-line[data-line]')) {
					return sib;
				}
				const inner = sib.querySelectorAll('.code-line[data-line]');
				if (inner.length) {
					return inner[inner.length - 1];
				}
				sib = sib.previousElementSibling;
			}
			el = el.parentElement;
		}
		return null;
	}

	// `data-line` marks where a block *starts*; nothing marks where it ends. Derive the end from the
	// next mapped line anywhere in the document, minus one. Safe because the preview appends a
	// sentinel `data-line="${lineCount}"` div after the body, so even the last block has a "next".
	// Scanning globally rather than walking forward also stays correct if a plugin renders a block
	// out of source order (footnote definitions, say). The extension host trims the blank separator
	// line this leaves on the end.
	function endLineOf(el) {
		const start = lineOf(el);
		if (!Number.isFinite(start)) {
			return start;
		}
		let next = Infinity;
		for (const candidate of document.querySelectorAll('.code-line[data-line]')) {
			const line = lineOf(candidate);
			// Strictly greater: a <ul> and its first <li> share a line, and taking that as "next"
			// would produce an end before the start.
			if (Number.isFinite(line) && line > start && line < next) {
				next = line;
			}
		}
		return next === Infinity ? start : next - 1;
	}

	// The blocks a multi-block text selection spans, or null to fall back to the single block under
	// the cursor. `host` is that block, and doubles as the "did the click land inside the selection?"
	// test: Chromium collapses a selection when you right-click outside it, but not before this
	// event fires, so we can't rely on the selection having been cleared already.
	function selectedBlocks(host) {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			return null;
		}
		// getRangeAt(0) is always normalized start-before-end, so a bottom-to-top drag needs no
		// special handling.
		const range = sel.getRangeAt(0);
		const startEl = findCodeLine(range.startContainer);
		const endEl = findCodeLine(range.endContainer);
		if (!startEl || !endEl) {
			return null;
		}
		const startLine = lineOf(startEl);
		const endLine = lineOf(endEl);
		const hostLine = lineOf(host);
		if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine < startLine) {
			return null;
		}
		if (hostLine < startLine || hostLine > endLine) {
			return null;
		}
		return { startEl, endEl };
	}

	const source = readSource();

	// Only ever one element carries our context at a time — restored on the next right-click so a
	// stale line can't be picked up by a later click on a different block.
	let lastHost = null;
	let lastHostPrevious = null;

	function restoreLastHost() {
		if (!lastHost) {
			return;
		}
		if (lastHostPrevious === null) {
			delete lastHost.dataset.vscodeContext;
		} else {
			lastHost.dataset.vscodeContext = lastHostPrevious;
		}
		lastHost = null;
		lastHostPrevious = null;
	}

	function commentIdsOf(el) {
		return (el.dataset.agentCommentIds || '').split(',').filter(Boolean);
	}

	document.addEventListener(
		'contextmenu',
		function (e) {
			restoreLastHost();
			if (!source) {
				return;
			}

			// A right-click on a specific comment row inside the expand panel (our own UI, not
			// rendered markdown content) acts on that one comment directly — no disambiguation, since
			// exactly one id is ever in scope here.
			const row = e.target.closest('.agent-comment-panel-entry');
			if (row) {
				lastHost = row;
				lastHostPrevious = Object.prototype.hasOwnProperty.call(row.dataset, 'vscodeContext') ? row.dataset.vscodeContext : null;
				row.dataset.vscodeContext = JSON.stringify({
					webviewSection: ROW_SECTION,
					preventDefaultContextMenuItems: false,
					agentCommentsSource: source,
					agentCommentsCommentIds: row.dataset.commentId || '',
					agentCommentsHasUnresolved: row.dataset.commentStatus === 'unresolved' ? 'true' : 'false',
					agentCommentsHasResolved: row.dataset.commentStatus === 'resolved' ? 'true' : 'false',
				});
				return;
			}

			// A right-click on the floating marker (our own UI, appended to <body> — see "Comment
			// markers" below) acts on every comment for that block; the controller disambiguates with
			// a quickpick if there's more than one applicable.
			const marker = e.target.closest('.agent-comment-marker');
			if (marker) {
				lastHost = marker;
				lastHostPrevious = Object.prototype.hasOwnProperty.call(marker.dataset, 'vscodeContext') ? marker.dataset.vscodeContext : null;
				marker.dataset.vscodeContext = JSON.stringify({
					webviewSection: MARKER_SECTION,
					preventDefaultContextMenuItems: false,
					agentCommentsSource: source,
					agentCommentsCommentIds: marker.dataset.agentCommentIds || '',
					agentCommentsHasUnresolved: marker.dataset.agentCommentHasUnresolved || 'false',
					agentCommentsHasResolved: marker.dataset.agentCommentHasResolved || 'false',
				});
				return;
			}

			const host = findCodeLine(e.target);
			if (!host) {
				return;
			}
			const startLine = lineOf(host);
			if (!Number.isFinite(startLine)) {
				return;
			}

			// With a selection, the comment covers every block it touches, start to end — the source
			// map is block-level only, so there's no honest way to anchor to part of a block. Without
			// one, a bare right-click stays a single-line anchor: it's the more durable anchor, since
			// a hash over one line survives edits elsewhere in the same block.
			const blocks = selectedBlocks(host);
			const line = blocks ? lineOf(blocks.startEl) : startLine;
			const endLine = blocks ? Math.max(line, endLineOf(blocks.endEl)) : line;

			const selectedText = String(window.getSelection() || '').trim().slice(0, MAX_SELECTION_CHARS);
			lastHost = host;
			lastHostPrevious = Object.prototype.hasOwnProperty.call(host.dataset, 'vscodeContext')
				? host.dataset.vscodeContext
				: null;
			host.dataset.vscodeContext = JSON.stringify({
				webviewSection: SECTION,
				// Keeping the default Copy/Cut/Paste items — removing them from the user's whole
				// markdown preview would be hostile.
				preventDefaultContextMenuItems: false,
				agentCommentsSource: source,
				agentCommentsLine: line,
				agentCommentsEndLine: endLine,
				agentCommentsSelection: selectedText,
			});
		},
		true
	);

	// Comment markers: a small floating badge for every block that has a comment
	// (`commentsMarkdownItPlugin.ts` marks the block itself with `class="agent-comment-line"` plus
	// `data-agent-comment-*` attributes — that's a query hook only now, carrying no visual styling
	// of its own). The badge is a real element appended to <body> and positioned with
	// getBoundingClientRect(), the same technique the expand panel already used below — deliberately
	// NOT a CSS ::before/absolute-positioned pseudo-element on the block itself: that still visibly
	// distorted table layout in practice (table row/cell positioning has known cross-engine quirks
	// that plain reasoning about the CSS spec didn't predict), so the badge lives entirely outside
	// the table's — or any block's — own DOM subtree, where it categorically cannot affect it.
	let markerRecords = []; // { marker, host, ids }[]

	function clearMarkers() {
		for (const { marker } of markerRecords) {
			marker.remove();
		}
		markerRecords = [];
	}

	function createMarker(host) {
		let entries;
		try {
			entries = JSON.parse(host.dataset.agentCommentsJson || '[]');
		} catch (err) {
			entries = [];
		}
		const authors = [...new Set(entries.map((c) => c.author))].sort();
		const marker = document.createElement('span');
		marker.className = 'agent-comment-marker agent-comment-authors-' + (authors.join('-') || 'user');
		marker.textContent = entries.length > 1 ? String(entries.length) : '';
		const titleAttr = host.getAttribute('title');
		if (titleAttr) {
			marker.title = titleAttr;
		}
		marker.dataset.agentCommentIds = host.dataset.agentCommentIds || '';
		marker.dataset.agentCommentHasUnresolved = host.dataset.agentCommentHasUnresolved || 'false';
		marker.dataset.agentCommentHasResolved = host.dataset.agentCommentHasResolved || 'false';
		positionMarker(marker, host);
		document.body.appendChild(marker);
		return marker;
	}

	// Absolute relative to the document (scrollY/scrollX added in), not fixed to the viewport — it
	// scrolls naturally with the content this way, no scroll-repositioning listener needed.
	function positionMarker(marker, host) {
		const rect = host.getBoundingClientRect();
		marker.style.position = 'absolute';
		marker.style.top = rect.top + window.scrollY - 7 + 'px';
		marker.style.left = rect.left + window.scrollX - 7 + 'px';
	}

	function syncMarkers() {
		clearMarkers();
		for (const host of document.querySelectorAll('.agent-comment-line[data-agent-comment-ids]')) {
			markerRecords.push({ marker: createMarker(host), host, ids: commentIdsOf(host) });
		}
		if (openHost) {
			const record = markerRecords.find((r) => r.host === openHost);
			if (record) {
				record.marker.classList.add('agent-comment-marker-expanded');
			}
		}
	}

	// Click-to-expand: shows comment text directly in the preview, in place, without navigating to
	// the source file. Independent of the real gutter's collapsed/expanded state — this extension
	// doesn't persist that anywhere, and there's no live CommentThread widget to embed in a webview
	// anyway — so this is its own lightweight panel with its own local expand/collapse state.
	//
	// Appended to <body> and positioned over the marker, rather than inserted as a child/sibling of
	// the marked content itself: a marked block can be a <p>, <li>, <td>, or heading, none of which
	// can validly contain (or sit next to, inside their own parent) an arbitrary block-level child —
	// the browser would silently renormalize the DOM in ways that are hard to predict. Only one
	// panel is open at a time.
	//
	// Acting on a comment (edit/resolve/reopen/delete) triggers a full markdown.preview.refresh —
	// every comment changes the store, and any comment's own marker might need to move or vanish, so
	// this extension always re-renders the whole document rather than trying to patch just one line.
	// That replaces every rendered element wholesale, including whichever one the open panel was
	// anchored to — without reconnecting, resolving *one* comment in a multi-comment panel silently
	// closed the whole panel, hiding every other comment in it too, not just the one that changed.
	// `openCommentIds` (not just the host element) is what actually identifies "what's open", so a
	// freshly re-rendered element carrying any of the same ids can be found and the panel reopened
	// there automatically, showing whatever's left, instead of just disappearing.
	let openPanel = null;
	let openHost = null;
	let openCommentIds = null;

	function closePanel() {
		if (openPanel) {
			openPanel.remove();
		}
		const record = markerRecords.find((r) => r.host === openHost);
		if (record) {
			record.marker.classList.remove('agent-comment-marker-expanded');
		}
		openPanel = null;
		openHost = null;
		openCommentIds = null;
	}

	function buildPanel(entries) {
		const panel = document.createElement('div');
		panel.className = 'agent-comment-panel';
		for (const c of entries) {
			const row = document.createElement('div');
			row.className = 'agent-comment-panel-entry agent-comment-authors-' + c.author;
			row.title = 'Right-click for Edit / Resolve / Reopen / Delete';
			row.dataset.commentId = c.id;
			row.dataset.commentStatus = c.status;
			const dot = document.createElement('span');
			dot.className = 'agent-comment-dot';
			const who = document.createElement('span');
			who.className = 'agent-comment-panel-author';
			who.textContent = c.author === 'user' ? 'You' : 'Agent';
			if (c.status === 'resolved') {
				who.textContent += ' · resolved by ' + (c.resolvedBy === 'user' ? 'you' : 'agent');
			}
			const text = document.createElement('span');
			text.className = 'agent-comment-panel-text';
			text.textContent = c.text;
			row.append(dot, who, text);
			panel.appendChild(row);
		}
		return panel;
	}

	function openPanelFor(host) {
		if (openPanel) {
			openPanel.remove();
		}
		if (openHost && openHost !== host) {
			const previous = markerRecords.find((r) => r.host === openHost);
			if (previous) {
				previous.marker.classList.remove('agent-comment-marker-expanded');
			}
		}
		let entries;
		try {
			entries = JSON.parse(host.dataset.agentCommentsJson || '[]');
		} catch (err) {
			entries = [];
		}
		const panel = buildPanel(entries);
		const rect = host.getBoundingClientRect();
		panel.style.position = 'fixed';
		panel.style.left = Math.max(4, rect.left) + 'px';
		panel.style.top = rect.bottom + 'px';
		panel.style.width = Math.max(240, Math.min(rect.width, 480)) + 'px';
		document.body.appendChild(panel);
		const record = markerRecords.find((r) => r.host === host);
		if (record) {
			record.marker.classList.add('agent-comment-marker-expanded');
		}
		openPanel = panel;
		openHost = host;
		openCommentIds = commentIdsOf(host);
	}

	document.addEventListener('click', function (e) {
		const marker = e.target.closest('.agent-comment-marker');
		if (marker) {
			const record = markerRecords.find((r) => r.marker === marker);
			if (!record) {
				return;
			}
			if (openHost === record.host) {
				closePanel();
			} else {
				openPanelFor(record.host);
			}
			return;
		}
		if (e.target.closest('.agent-comment-panel')) {
			return; // interacting with the panel itself shouldn't dismiss it
		}
		closePanel();
	});

	// The one signal previewScripts gives no other way to observe is "the content just got replaced
	// by a refresh" — detected here via mutation rather than instrumenting every call site that can
	// trigger one. Disconnect while re-syncing since syncMarkers()/openPanelFor() mutate <body>
	// themselves (appending markers/the panel), which would otherwise re-trigger this observer.
	let resyncScheduled = false;
	function scheduleResync() {
		if (resyncScheduled) {
			return;
		}
		resyncScheduled = true;
		requestAnimationFrame(function () {
			resyncScheduled = false;
			observer.disconnect();
			syncMarkers();
			if (openHost && !openHost.isConnected) {
				const stillPresentIds = openCommentIds;
				const candidate = markerRecords.find((r) => r.ids.some((id) => stillPresentIds.includes(id)));
				if (candidate) {
					openPanelFor(candidate.host);
				} else {
					closePanel(); // every comment that was open got resolved-and-hidden or deleted
				}
			}
			observer.observe(document.body, { childList: true, subtree: true });
		});
	}

	const observer = new MutationObserver(scheduleResync);
	observer.observe(document.body, { childList: true, subtree: true });
	window.addEventListener('resize', scheduleResync);
	// The panel is position: fixed (viewport-relative), unlike the markers (document-relative, so
	// they scroll naturally) — close it on scroll rather than let it drift away from its line.
	window.addEventListener('scroll', closePanel, true);
	syncMarkers();
})();
