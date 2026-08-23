# Feature: Leave Comments from the Markdown Preview

## Goal

Let the user right-click text in VSCode's **built-in** Markdown preview and leave a comment, which is stored in the existing Agent Comments store and anchored to the correct line in the **source `.md` file**.

**Scope boundaries — read carefully:**
- Comments do **NOT** need to render inside the preview. The user sees them in the normal editor view (gutter) and in the sidebar panel. Do not build preview-side comment rendering.
- We are **NOT** shipping our own Markdown preview webview. We extend VSCode's built-in preview only. If an approach requires replacing the built-in preview, it is out of scope — pick a fallback instead.
- Anchoring, storage, and the MCP tool contract are **already implemented**. This feature only adds a new *entry point* for creating a comment. It reuses the existing storage/anchoring pipeline unchanged.

---

## 1. Background: what VSCode does and doesn't allow here

### 1.1 You CAN inject a script into the built-in preview

VSCode supports contributing JS and CSS into the built-in Markdown preview:

```json
"contributes": {
  "markdown.previewScripts": ["./media/preview.js"],
  "markdown.previewStyles": ["./media/preview.css"]
}
```

Reference: https://code.visualstudio.com/api/extension-guides/markdown-extension

**Important behavior:** contributed scripts are loaded asynchronously and **reloaded on every content change**. The preview re-renders constantly as the user types. Any DOM annotation the script performs must be idempotent and must re-apply after every re-render (see §4.3).

### 1.2 You CANNOT use `acquireVsCodeApi()` from a preview script

This is the obvious approach and it does not work. `acquireVsCodeApi()` can only be called once per webview, and the built-in markdown extension already calls it. Attempting it from a contributed preview script throws `An instance of the VS Code API has already been acquired`.

- VSCode issue #122961 — closed **as-designed**.
- VSCode issue #174080 (request to expose `postMessage` to preview scripts) — closed **out-of-scope**.

**Do not attempt workarounds for this**, including:
- Re-acquiring or monkey-patching the API object.
- `fetch()` from the preview to a localhost server (the preview webview's CSP will likely block it, and it's fragile).
- `command:` URI links in rendered markdown (blocked in the built-in preview for untrusted content).

The design below deliberately **never needs a webview→extension message channel.**

### 1.3 The route that works: contributed webview context menus

VSCode has a `webview/context` menu contribution point. Menu items are declared in `package.json` and gated by `when` clauses. The webview's own DOM can set those context values via a `data-vscode-context` attribute (or in JS via `element.dataset.vscodeContext`), whose value is a JSON object describing the contexts to apply when the user right-clicks that element.

Relevant context keys (from the implementing PR, microsoft/vscode#154524):
- `webviewId` — the extension-provided id of the webview
- `webviewSection` — arbitrary value set by the DOM via `data-vscode-context`
- `preventDefaultContextMenuItems` — boolean, hides the default Copy/Cut/Paste items

**Why this solves our problem:** the menu item invokes a **normal VSCode command**, which executes in the extension host — not in the webview. So the payload reaches our extension code without any `postMessage`.

### 1.4 The preview already tells you the source line

The built-in preview injects source-mapping attributes used by its scroll-sync feature: block elements get `class="code-line"` and `data-line="<zero-based source line>"`.

**Known limitation (verify against current VSCode):** as of the referenced issue (microsoft/vscode#133376), source maps are only emitted for a subset of block types — `paragraph_open`, `heading_open`, `image`, `code_block`, `fence`, `blockquote_open`, `list_item_open`. Notably **tables were not in that list**. Elements without a `data-line` must be handled by walking up/back to the nearest ancestor or preceding sibling that has one (see §4.2).

---

## 2. Architecture of the feature

```
[ built-in MD preview (webview) ]
    preview.js  ──annotates DOM with data-vscode-context (incl. source line)
          │
          │  user right-clicks → VSCode reads data-vscode-context
          ▼
[ VSCode menu system ]  ── matches "webview/context" when-clause
          │
          │  invokes command with context payload as argument
          ▼
[ extension host ]  agentComments.addCommentFromPreview(context)
          │
          ├─ resolve active preview's source .md document
          ├─ compute anchor (existing pipeline: line + contentHash + context lines)
          └─ write comment via existing storage layer  ← unchanged
```

No new storage, no new schema fields, no new MCP tools. `author.type` is `"user"` (created via UI path).

---

## 3. MANDATORY FIRST STEP: spike before building

Two things in this design are **not guaranteed by documentation** and must be verified empirically before writing the real feature. Build a throwaway minimal extension and test:

### Spike A — does a third-party `webview/context` item appear in the built-in Markdown preview?

The `webview/context` contribution point is documented for webviews an extension owns. It is **not documented** whether a menu item contributed by extension X appears in a webview owned by extension Y (here, the built-in `markdown-language-features`). Test with a `when` clause keyed on `webviewSection` set by our own injected script:

```json
"menus": {
  "webview/context": [
    { "command": "spike.hello", "when": "webviewSection == 'agentCommentsTarget'" }
  ]
}
```

**Pass:** the item shows on right-click in the preview.
**Fail:** go to §6 Fallbacks.

### Spike B — can the payload reflect the live text selection?

`data-vscode-context` is a static DOM attribute. To capture *which text* the user selected, the script must update `dataset.vscodeContext` during the `contextmenu` event, before VSCode reads it. **The ordering here is not documented and may not be guaranteed.**

```js
document.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.code-line');
  if (!el) return;
  el.dataset.vscodeContext = JSON.stringify({
    webviewSection: 'agentCommentsTarget',
    preventDefaultContextMenuItems: false,
    line: Number(el.getAttribute('data-line')),
    selectedText: String(window.getSelection() ?? '').slice(0, 200)
  });
}, true);
```

**Pass:** the command receives the freshly-set `line` and `selectedText`.
**Fail:** fall back to static per-block annotation (§4.2 Mode 1) — still fully usable, just block-granular. This is an acceptable outcome; do not block the feature on it.

**Report both spike results before proceeding.**

---

## 4. Implementation

### 4.1 `package.json` contributions

```json
"contributes": {
  "markdown.previewScripts": ["./media/preview.js"],
  "markdown.previewStyles": ["./media/preview.css"],
  "commands": [
    {
      "command": "agentComments.addCommentFromPreview",
      "title": "Add Comment",
      "category": "Agent Comments"
    }
  ],
  "menus": {
    "webview/context": [
      {
        "command": "agentComments.addCommentFromPreview",
        "when": "webviewSection == 'agentCommentsTarget'"
      }
    ]
  }
}
```

Note: contributing `markdown.previewScripts` causes the extension to be **activated lazily when a Markdown preview is first shown**. Ensure activation logic is safe to run at that point (storage init must already be idempotent).

### 4.2 `media/preview.js`

Two modes; implement Mode 1 unconditionally, layer Mode 2 on top only if Spike B passed.

**Mode 1 — static block annotation (always implement):**

```js
const SECTION = 'agentCommentsTarget';

function annotate() {
  for (const el of document.querySelectorAll('.code-line[data-line]')) {
    if (el.dataset.vscodeContext) continue;         // idempotent
    el.dataset.vscodeContext = JSON.stringify({
      webviewSection: SECTION,
      line: Number(el.getAttribute('data-line'))
    });
  }
}
```

**Mode 2 — selection-aware (only if Spike B passed):** the `contextmenu` handler from §3, using capture phase, overwriting the block's context with `line` + `selectedText` at click time.

**Resolving a line when the clicked element has no `data-line`:** walk up ancestors first (`e.target.closest('.code-line')`); if none, walk backwards through previous siblings/ancestors to find the nearest preceding `.code-line` and use its line. Never send a comment without a resolved line — if resolution fails entirely, omit the context so no menu item appears, rather than anchoring to something wrong.

### 4.3 Surviving re-renders

Contributed scripts reload on every content change, but the DOM is also mutated in place. Do **both**:
1. Run `annotate()` on script load.
2. Attach a `MutationObserver` on `document.body` (`childList: true, subtree: true`), debounced (~100ms), re-running `annotate()`.

`annotate()` must stay cheap and idempotent — it runs often.

### 4.4 The command handler (extension host)

```ts
vscode.commands.registerCommand(
  'agentComments.addCommentFromPreview',
  async (ctx?: { line?: number; selectedText?: string }) => { /* ... */ }
);
```

Steps:
1. **Validate the payload.** If `ctx?.line` is missing or not a finite number, show a warning and abort. Never guess a line.
2. **Resolve the source document.** The command payload does not include the file. Determine which `.md` the active preview is showing:
   - Preferred: track it via `vscode.window.onDidChangeActiveTextEditor` plus the most recently previewed markdown document.
   - Also acceptable: if exactly one `.md` document is open, use it; if ambiguous, prompt with `vscode.window.showQuickPick` over open `.md` documents.
   - **Note:** the built-in preview does not expose "which file is this preview showing" as public API. This resolution is heuristic. Document whatever heuristic you choose in a code comment, and make the ambiguous case prompt the user rather than guessing silently.
3. **Convert line numbering.** `data-line` is **zero-based**; confirm against the existing storage schema's convention (`anchor.lineHint`) and convert if needed. Getting this off by one silently anchors every preview comment one line wrong — add a unit test.
4. **Prompt for comment text** via `vscode.window.showInputBox`. If `ctx.selectedText` is present, use it as the input box's `prompt` or placeholder for context (do not store it as the comment body).
5. **Create the comment through the existing storage layer**, computing the anchor with the existing pipeline (read the source document via `vscode.workspace.fs`, hash the target line with existing line-ending normalization, capture `contextBefore`/`contextAfter`). Do not write a bespoke code path — call the same function the gutter UI calls.
6. `author.type = "user"`.

### 4.5 Optional polish

- `media/preview.css`: a subtle hover affordance (e.g. a faint left border on `.code-line`) so blocks look right-clickable. Keep it unobtrusive — this styles the user's *entire* markdown preview experience, including for files with no comments.
- Consider setting `preventDefaultContextMenuItems: false` (i.e. keep Copy/Paste). Removing the default items from the built-in preview would be hostile to users who expect them.

---

## 5. Testing checklist

- Right-click a paragraph → comment created → appears in gutter at the correct line in the source `.md`, and in the sidebar panel.
- Right-click inside a **list item**, a **blockquote**, a **fenced code block**, and a **heading** — all are source-mapped types and should resolve.
- Right-click inside a **table** — likely *not* source-mapped; must fall back gracefully (nearest preceding line) or show no menu item. Must never anchor wrongly.
- Type in the source file to force several re-renders, then right-click again — annotation still works (MutationObserver path).
- Two `.md` files open, preview one → correct source file is targeted.
- Comment created from preview is returned by `list_unresolved_comments` and is indistinguishable in shape from a gutter-created comment.
- Off-by-one: comment on line 1 and on the last line of a file, verify exact placement.

---

## 6. Fallbacks (in priority order, if Spike A fails)

1. **Command palette + preview scroll position.** Drop the context menu entirely. Provide `Agent Comments: Add Comment at Preview Position`, using the existing preview↔editor scroll sync so the source editor's cursor line is the anchor. Loses right-click; keeps the workflow. **Preferred fallback.**
2. **Editor-side only.** Ship nothing in the preview; instruct users to comment in the source view. Zero work, zero risk.

**Do not** implement a custom Markdown preview webview as a fallback. Explicitly rejected by the product owner.

---

## 7. Summary of decisions

| Question | Decision |
|---|---|
| Extend built-in preview or ship our own? | Extend built-in only. Custom preview is out of scope. |
| Render comments in the preview? | No. Editor gutter + sidebar only. |
| Webview→extension messaging? | Impossible (`acquireVsCodeApi` already taken). Design avoids needing it. |
| How does the payload reach the extension? | `webview/context` menu item → normal command in extension host. |
| Source line source of truth | `data-line` on `.code-line` elements (preview's scroll-sync source map). |
| Selection precision | Best-effort. Block-granular is acceptable; verify via Spike B. |
| Storage / anchoring / MCP tools | Unchanged. This is a new entry point only. |
| Build order | Spike A and B first, report results, then implement. |