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
	// Right-clicking a specific row in the click-to-expand panel (below) acts on just that one
	// comment — no quickpick needed, since exactly one id is ever in scope for this section.
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

	document.addEventListener(
		'contextmenu',
		function (e) {
			restoreLastHost();
			if (!source) {
				return;
			}

			// A right-click on a specific comment row inside the expand panel (our own UI, not
			// rendered markdown content) acts on that one comment directly — skips the block lookup
			// below entirely, and carries exactly one id, so no disambiguation prompt is needed.
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
				// `commentsMarkdownItPlugin.ts` set these on the same element (it's the same block
				// token core tags with `code-line`/`data-line`) when the block has comments — absent
				// otherwise. Forwarded as-is so the edit/resolve/reopen/delete menu items' `when`
				// clauses can gate on them.
				agentCommentsCommentIds: host.dataset.agentCommentIds || '',
				agentCommentsHasUnresolved: host.dataset.agentCommentHasUnresolved || 'false',
				agentCommentsHasResolved: host.dataset.agentCommentHasResolved || 'false',
			});
		},
		true
	);

	// Click-to-expand: shows comment text directly in the preview, in place, without navigating to
	// the source file. Independent of the real gutter's collapsed/expanded state — this extension
	// doesn't persist that anywhere, and there's no live CommentThread widget to embed in a webview
	// anyway — so this is its own lightweight panel with its own local expand/collapse state.
	//
	// The panel is appended to <body> and positioned over the clicked line, rather than inserted as
	// a child/sibling of the marked element itself: a marked block can be a <p>, <li>, <td>, or
	// heading, none of which can validly contain (or sit next to, inside their own parent) an
	// arbitrary block-level child — the browser would silently renormalize the DOM in ways that are
	// hard to predict. Only one panel is open at a time.
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
		if (openHost) {
			openHost.classList.remove('agent-comment-expanded');
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

	function commentIdsOf(host) {
		return (host.dataset.agentCommentIds || '').split(',').filter(Boolean);
	}

	function openPanelFor(host) {
		if (openPanel) {
			openPanel.remove();
		}
		if (openHost && openHost !== host) {
			openHost.classList.remove('agent-comment-expanded');
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
		host.classList.add('agent-comment-expanded');
		openPanel = panel;
		openHost = host;
		openCommentIds = commentIdsOf(host);
	}

	// Runs only while a panel is open (each call reschedules itself, so it stops the moment
	// closePanel clears openPanel) — the one signal previewScripts gives no other way to observe is
	// "the content just got replaced by a refresh", so this polls for it via the host's own
	// connectedness rather than instrumenting every call site that can trigger a refresh.
	function watchForReconnect() {
		if (!openPanel) {
			return;
		}
		if (openHost && !openHost.isConnected) {
			const stillPresentIds = openCommentIds;
			const candidate = [...document.querySelectorAll('.agent-comment-line[data-agent-comment-ids]')].find((el) =>
				commentIdsOf(el).some((id) => stillPresentIds.includes(id))
			);
			if (candidate) {
				openPanelFor(candidate);
			} else {
				closePanel(); // every comment that was open got resolved-and-hidden or deleted
				return;
			}
		}
		requestAnimationFrame(watchForReconnect);
	}

	document.addEventListener('click', function (e) {
		if (e.target.closest('a')) {
			return; // don't hijack normal link navigation
		}
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed && String(sel).length > 0) {
			return; // the user was selecting text, not asking to expand
		}
		const host = e.target.closest('.agent-comment-line');
		if (!host || host === openHost) {
			closePanel();
			return;
		}
		openPanelFor(host);
		requestAnimationFrame(watchForReconnect);
	});

	// Fixed positioning tracks the viewport, not the scrolled preview content — close on scroll
	// rather than let it drift away from the line it was opened for.
	window.addEventListener('scroll', closePanel, true);
})();
