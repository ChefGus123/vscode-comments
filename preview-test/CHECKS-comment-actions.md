# Markdown Preview Comment Markers + Actions — Manual Test Plan

Manual E2E checklist for comment presence markers, click-to-expand, and the Edit/Resolve/Reopen/
Delete right-click actions in VS Code's built-in Markdown preview. Builds on `CHECKS.md` (the
add-from-preview flow) — read that first if you haven't. Same throwaway fixtures; delete the whole
`preview-test/` folder when the feature is signed off.

## Setup

1. `npm run compile`, then **F5** to launch the Extension Dev Host.
2. Open this repo as the workspace.
3. Open `preview-test/01-blocks.md` in the editor, add a couple of comments via the gutter "+" (not
   the preview, so this checklist doesn't depend on `CHECKS.md` having been run first) — one on
   line 3 ("First paragraph, plain text.") authored as yourself, and resolve a second one on line
   51 so you have both an unresolved and a resolved comment to work with.
4. **Ctrl+K V** to open the preview to the side.

## Markers

| # | Check | Expect |
|---|---|---|
| 2.1 | Look at the paragraph on line 3 in the preview | A small blue dot appears on/before that block. |
| 2.2 | Look at the paragraph on line 51 | No dot — resolved comments are hidden by default (`agenticComments.editor.hideResolvedComments: true`). |
| 2.3 | Toggle the setting to `false` (Settings UI), wait for the preview to refresh | A dot now appears on line 51 too. |
| 2.4 | Add a second comment on line 3 as an **agent** (use an MCP tool call, or `add_comments`) | Line 3's block now shows **two** dots (blue + red) and a small count badge. |
| 2.5 | Hover the dot on line 3 (don't click) | Native browser tooltip shows both comments' author + text, plain text. |
| 2.6 | Add a comment on a **nested list item** (e.g. line 13 in `01-blocks.md`) via the gutter | The dot appears on the list item itself, not on the whole list — the parent `<ul>`/outer list items stay unmarked. |
| 2.7 | Add a comment via a **multi-block gutter selection** spanning two adjacent top-level blocks with nothing wrapping them (e.g. select from the line-3 paragraph through the line-7 paragraph) | Both blocks' markers appear — this is the "no single containing block" fallback path, not a bug. |
| 2.8 | Edit the source file so a commented line shifts (insert lines above it), save | After the reanchor settles (~1s) and the preview re-renders, the marker follows the comment to its new line — not left behind at the old one. |

## Click-to-expand

| # | Do | Expect |
|---|---|---|
| 3.1 | Click the dot/marked block on line 3 (single comment) | A small panel appears near the block showing the author, status, and full comment text. |
| 3.2 | Click the same block again | Panel closes (toggle). |
| 3.3 | Click a block with **two** comments (from 2.4) | Panel lists both, stacked — not just one. |
| 3.4 | With a panel open, click a **different** marked block | The first panel closes, the new one opens — never two panels at once. |
| 3.5 | With a panel open, click a link or plain text **inside** the marked block, or select some of its text | Panel does not toggle — clicking a link still navigates normally, and text selection isn't interrupted. |
| 3.6 | With a panel open, scroll the preview | Panel closes rather than drifting away from the line it was opened for. |
| 3.7 | Open a panel, then switch the editor theme (light/dark) | Panel colors follow the theme (uses `--vscode-editorHoverWidget-*` variables, not hardcoded colors). |
| 3.8 | Inspect the DOM (webview dev tools) while a panel is open | The panel is a child of `<body>`, not nested inside the `<p>`/`<li>`/`<td>` it's attached to — confirms it isn't producing invalid HTML nesting the browser silently "fixed" for you. |

## Right-click actions

| # | Do | Expect |
|---|---|---|
| 4.1 | Right-click the line-3 marker (one unresolved comment, assuming 2.4's agent comment wasn't added, or after cleaning it up) | Menu shows **Add Comment** *and* **Edit Comment** / **Resolve Comment** / **Delete Comment** — not **Reopen Comment** (nothing resolved there yet). |
| 4.2 | Right-click a block with **no** comment | Only **Add Comment** appears — none of the four new actions. |
| 4.3 | **Edit Comment** on a single-comment block | Input box opens prefilled with the current text (not blank). Change it, submit → gutter and sidebar reflect the new text. |
| 4.4 | **Edit Comment**, then press Esc | No change to the comment's text. |
| 4.5 | Right-click a block with **two unresolved** comments, choose **Resolve Comment** | `showQuickPick` appears listing both (truncated text + author + status); pick one → only that one resolves, the other stays unresolved and its marker/dot persists. |
| 4.6 | Right-click a block whose only comment is already resolved (with `hideResolvedComments: false` so it's visible) | Menu shows **Reopen Comment** and **Delete Comment**, not **Edit Comment** or **Resolve Comment**. |
| 4.7 | **Reopen Comment** on it | Comment becomes unresolved again — gutter/sidebar update; if `hideResolvedComments` is back to `true`, the preview marker for it disappears since resolved is no longer relevant (it's unresolved now) it should still show, just now as unresolved. |
| 4.8 | **Delete Comment** on a resolved comment | Permanently removed — gone from sidebar/archive, not just hidden. |
| 4.9 | Right-click, choose an action, then immediately check the sidebar/gutter without touching the preview again | They update without any manual refresh — confirms the `onDidChangeFile` → `markdown.preview.refresh` path fires from an action taken *in* the preview too, not just from elsewhere. |
| 4.10 | Delete a comment from the **gutter** while its marker is showing in the preview | Preview marker disappears within ~1s (the debounced refresh), with no interaction in the preview itself. |
| 4.11 | Resolve a comment via an **MCP tool call** while its marker shows in the preview (default `hideResolvedComments: true`) | Marker disappears the same way — confirms the live-refresh path isn't gutter/sidebar-specific. |

## Cross-cutting

| # | Do | Expect |
|---|---|---|
| 5.1 | Open the preview for a `.md` file with comments **before** its gutter/sidebar has ever been opened this session (cold cache) | Markers appear shortly after the preview first renders (one extra render pass while the store warms up), not instantly and not never. |
| 5.2 | Two previews open side by side, each on a different commented file | Each shows only its own file's markers — no cross-contamination. |
| 5.3 | Restart the Extension Dev Host, reopen a previewed file with comments | Markers appear correctly on the very first preview render (or after the one warm-up pass from 5.1). |
| 5.4 | Open the webview dev tools console throughout this checklist | No errors from `preview.js`, in particular nothing about the click handler or JSON parsing of `data-agent-comments-json`. |
