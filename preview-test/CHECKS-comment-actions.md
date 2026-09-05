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

## Markers — presence and non-intrusiveness

The marker is one small circular badge floating just above-left of the block, `position: absolute`
— it must never occupy space in the document's own layout.

| # | Check | Expect |
|---|---|---|
| 2.1 | Look at the paragraph on line 3 in the preview | A small blue badge floats just above the block's top-left corner. Its presence must not shift, indent, or reflow the block's own text at all. |
| 2.2 | Look at the paragraph on line 51 | No badge — resolved comments are hidden by default (`agenticComments.editor.hideResolvedComments: true`). |
| 2.3 | Toggle the setting to `false` (Settings UI), wait for the preview to refresh | A badge now appears on line 51 too. |
| 2.4 | Add a second comment on line 3 as an **agent** (use an MCP tool call, or `add_comments`) | Line 3's badge becomes a **two-tone split** (blue/red) — still one badge, not two. |
| 2.5 | Add a third comment on line 3 (either author) | The badge now shows the digit **3** inside it instead of a plain dot. |
| 2.6 | Hover the badge on line 3 (don't click) | Native browser tooltip shows every comment's author + text, plain text. |
| 2.7 | **Table check — the actual reported bug.** Add a comment on a table row/cell in `01-blocks.md` | The badge floats above the table without changing any column's width, row height, or cell alignment. Compare the table's rendered width/columns before and after adding the comment — they must be identical. |
| 2.8 | Add a comment on a **nested list item** (e.g. line 13 in `01-blocks.md`) via the gutter | The badge appears on the list item itself, not on the whole list — the parent `<ul>`/outer list items stay unmarked. |
| 2.9 | Add a comment via a **multi-block gutter selection** spanning several short blocks (e.g. three consecutive list items, or several table rows) | **Exactly one** badge appears, on the first (topmost) of those blocks — not one badge per block/row/item covered. |
| 2.10 | Edit the source file so a commented line shifts (insert lines above it), save | After the reanchor settles (~1s) and the preview re-renders, the marker follows the comment to its new line — not left behind at the old one. |

## Click-to-expand

| # | Do | Expect |
|---|---|---|
| 3.1 | Click a marked block (single comment) | A small panel appears near the block showing the author, status, and full comment text. |
| 3.2 | Click the same block again | Panel closes (toggle). |
| 3.3 | Click a block with **multiple** comments (from 2.4/2.5) | Panel lists all of them, stacked — not just one. |
| 3.4 | With a panel open, click a **different** marked block | The first panel closes, the new one opens — never two panels at once. |
| 3.5 | With a panel open, click a link or plain text **inside** the marked block, or select some of its text | Panel does not toggle — clicking a link still navigates normally, and text selection isn't interrupted. |
| 3.6 | With a panel open, scroll the preview | Panel closes rather than drifting away from the line it was opened for. |
| 3.7 | Open a panel, then switch the editor theme (light/dark) | Panel colors follow the theme (uses `--vscode-editorHoverWidget-*` variables, not hardcoded colors). |
| 3.8 | Inspect the DOM (webview dev tools) while a panel is open | The panel is a child of `<body>`, not nested inside the `<p>`/`<li>`/`<td>` it's attached to — confirms it isn't producing invalid HTML nesting the browser silently "fixed" for you. |
| 3.9 | Hover a row inside the open panel | Cursor shows a context-menu hint, row highlights, native tooltip reads "Right-click for Edit / Resolve / Reopen / Delete." |

## Right-click actions — row-scoped (primary path)

This is the intended everyday flow: expand the panel, then right-click the *specific comment* you
want, not the block. No picker should ever appear for this path, since exactly one comment is ever
in scope.

| # | Do | Expect |
|---|---|---|
| 4.1 | Expand a block with **two or more** comments (mixed resolved/unresolved, mixed authors if possible), right-click **one specific row** | Menu shows actions for *only that one comment* — Edit/Resolve appear only if that row is unresolved, Reopen only if it's resolved, Delete always. No **Add Comment** item (that only makes sense on real document content, not our own panel chrome). |
| 4.2 | **Edit Comment** from a row | Input box opens prefilled with that comment's current text. Change it, submit → gutter/sidebar/panel all reflect the new text for that one comment only. |
| 4.3 | **Resolve Comment** from a row, panel has other comments still open | Only that row's comment resolves — the others' status is untouched. No quickpick ever appeared. |
| 4.4 | **Delete Comment** from a resolved row | Permanently removed — gone from sidebar/archive, not just hidden. |
| 4.5 | Right-click one row, then immediately right-click a **different** row without closing the panel | The second right-click's menu is scoped to the second row's comment, not stale from the first. |

## Right-click actions — block-scoped (fallback path)

Right-clicking the marked block directly (without expanding first) still works, for when you want
to act without opening the panel — falls back to a picker only when the block has more than one
applicable comment.

| # | Do | Expect |
|---|---|---|
| 5.1 | Right-click a block with **exactly one** unresolved comment (not expanded) | Menu shows **Add Comment**, **Edit Comment**, **Resolve Comment**, **Delete Comment** — acts directly, no picker (only one candidate). |
| 5.2 | Right-click a block with **no** comment | Only **Add Comment** appears. |
| 5.3 | Right-click a block with **two unresolved** comments (not expanded), choose **Resolve Comment** | `showQuickPick` appears listing both (truncated text + author + status); pick one → only that one resolves. |
| 5.4 | Right-click a block whose only comment is already resolved (`hideResolvedComments: false`) | Menu shows **Reopen Comment** and **Delete Comment**, not **Edit Comment** or **Resolve Comment**. |
| 5.5 | Right-click, choose an action, then immediately check the sidebar/gutter without touching the preview again | They update without any manual refresh — confirms the `onDidChangeFile` → `markdown.preview.refresh` path fires from an action taken *in* the preview too, not just from elsewhere. |
| 5.6 | Delete a comment from the **gutter** while its marker is showing in the preview | Preview marker disappears within ~1s (the debounced refresh), with no interaction in the preview itself. |
| 5.7 | Resolve a comment via an **MCP tool call** while its marker shows in the preview (default `hideResolvedComments: true`) | Marker disappears the same way — confirms the live-refresh path isn't gutter/sidebar-specific. |

## Cross-cutting

| # | Do | Expect |
|---|---|---|
| 6.1 | Open the preview for a `.md` file with comments **before** its gutter/sidebar has ever been opened this session (cold cache) | Markers appear shortly after the preview first renders (one extra render pass while the store warms up), not instantly and not never. |
| 6.2 | Two previews open side by side, each on a different commented file | Each shows only its own file's markers — no cross-contamination. |
| 6.3 | Restart the Extension Dev Host, reopen a previewed file with comments | Markers appear correctly on the very first preview render (or after the one warm-up pass from 6.1). |
| 6.4 | Open the webview dev tools console throughout this checklist | No errors from `preview.js`, in particular nothing about the click handler or JSON parsing of `data-agent-comments-json`. |
