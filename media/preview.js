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
})();
