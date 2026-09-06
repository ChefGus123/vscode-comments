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

The badge is a real `<span>` built by `preview.js`, appended to `<body>`, and positioned over the
commented block via `getBoundingClientRect()` — it is **not** part of the block's own DOM subtree
at all (two earlier attempts styled it onto the block itself via a CSS pseudo-element, first
`display: inline-block` then `position: absolute`; both still visibly distorted table layout in
practice). It must never occupy space in, or otherwise affect, the document's own layout — this
section is entirely about verifying that.

| # | Check | Expect |
|---|---|---|
| 2.1 | Look at the paragraph on line 3 in the preview | A small blue badge floats just above the block's top-left corner. Its presence must not shift, indent, or reflow the block's own text at all. |
| 2.2 | Look at the paragraph on line 51 | No badge — resolved comments are hidden by default (`agenticComments.editor.hideResolvedComments: true`). |
| 2.3 | Toggle the setting to `false` (Settings UI), wait for the preview to refresh | A badge now appears on line 51 too. |
| 2.4 | Add a second comment on line 3 as an **agent** (use an MCP tool call, or `add_comments`) | Line 3's badge becomes a **two-tone split** (blue/red) — still one badge, not two. |
| 2.5 | Add a third comment on line 3 (either author) | The badge now shows the digit **3** inside it instead of a plain dot. |
| 2.6 | Hover the badge on line 3 (don't click) | Native browser tooltip shows every comment's author + text, plain text. |
| 2.7 | **Table check — the actual reported bug, twice.** Add a comment on a table row/cell in `01-blocks.md` | The badge floats near the table without changing any column's width, row height, or cell alignment, or the table's overall rendered width. Compare before/after — they must be pixel-identical. Do this with a wide table (many columns) and a narrow one. |
| 2.8 | Inspect the DOM (webview dev tools) with a table comment's badge visible | The badge (`.agent-comment-marker`) is a child of `<body>`, appearing *nowhere* inside the `<table>`/`<tr>`/`<td>` subtree — confirms it structurally cannot be the table layout algorithm's problem, regardless of which engine renders it. |
| 2.9 | Add a comment on a **nested list item** (e.g. line 13 in `01-blocks.md`) via the gutter | The badge appears over the list item itself, not the whole list — the parent `<ul>`/outer list items stay unmarked. |
| 2.10 | Add a comment via a **multi-block gutter selection** spanning several short blocks (e.g. three consecutive list items, or several table rows) | **Exactly one** badge appears, over the first (topmost) of those blocks — not one badge per block/row/item covered. |
| 2.11 | Edit the source file so a commented line shifts (insert lines above it), save | After the reanchor settles (~1s) and the preview re-renders, the badge follows the comment to its new position — not left behind at the old one. |
| 2.12 | Resize the Extension Dev Host window (or drag the preview pane wider/narrower) while a badge is visible over reflowing content | The badge's position updates to track the block — it shouldn't end up floating over the wrong line after a reflow. |
| 2.13 | Scroll the preview with a badge visible | The badge scrolls naturally with the content, staying over its block — it does not need to be "fixed" and re-shown, unlike the panel (3.6). |

## Click-to-expand

| # | Do | Expect |
|---|---|---|
| 3.1 | Click a badge (single comment) | A small panel appears near the block showing the author, status, and full comment text. The badge gets a focus ring while its panel is open. |
| 3.2 | Click the same badge again | Panel closes (toggle), focus ring removed. |
| 3.3 | Click a badge with **multiple** comments (from 2.4/2.5) | Panel lists all of them, stacked — not just one. |
| 3.4 | With a panel open, click a **different** badge | The first panel closes (its badge's focus ring removed), the new one opens — never two panels at once. |
| 3.5 | With a panel open, click anywhere in the real document content — a link, plain text, inside a table, select some text | Clicking a link still navigates normally, text selection isn't interrupted, and (since real content is no longer a click target for expand/collapse at all) the open panel simply closes, the same as any other click away from it. |
| 3.6 | With a panel open, scroll the preview | Panel closes rather than drifting away from the line it was opened for (badges themselves don't need this — see 2.13). |
| 3.7 | Open a panel, then switch the editor theme (light/dark) | Panel colors follow the theme (uses `--vscode-editorHoverWidget-*` variables, not hardcoded colors). |
| 3.8 | Inspect the DOM (webview dev tools) while a panel is open | Both the panel and the badge it belongs to are children of `<body>` — neither is nested inside the `<p>`/`<li>`/`<td>` the comment is actually about. |
| 3.9 | Hover a row inside the open panel | Cursor shows a context-menu hint, row highlights, native tooltip reads "Right-click for Edit / Resolve / Reopen / Delete." |
| 3.10 | With a panel open, click somewhere *inside the panel itself* that isn't a row (e.g. its padding/background) | Panel stays open — only clicking a badge or clicking away from the panel closes it. |

## Right-click actions — row-scoped (primary path)

This is the intended everyday flow: expand the panel, then right-click the *specific comment* you
want, not the block. No picker should ever appear for this path, since exactly one comment is ever
in scope.

| # | Do | Expect |
|---|---|---|
| 4.1 | Expand a block with **two or more** comments (mixed resolved/unresolved, mixed authors if possible), right-click **one specific row** | Menu shows actions for *only that one comment* — Edit/Resolve appear only if that row is unresolved, Reopen only if it's resolved, Delete always. No **Add Comment** item (that only makes sense on real document content, not our own panel chrome). |
| 4.2 | **Edit Comment** from a row | Input box opens prefilled with that comment's current text. Change it, submit → **the panel stays open** (reconnects across the resulting refresh) and shows the updated text — it must not silently close. |
| 4.3 | **Resolve Comment** from a row, panel has **other** comments still open | Only that row's comment resolves — the others' status is untouched, and **the panel stays open** showing the remaining comments (this was the actual reported bug: the whole panel used to vanish, hiding the untouched ones too). |
| 4.4 | **Delete Comment** from a resolved row, panel has other comments open | That row disappears from the panel; the panel itself stays open with the rest. |
| 4.5 | **Delete** (or resolve-with-`hideResolvedComments:true`) the **last remaining** comment shown in an open panel | The panel closes cleanly — nothing left to reconnect to, so it shouldn't linger showing stale/empty content. |
| 4.6 | With a panel open, change a comment on a **different, unrelated** block via the gutter/sidebar/MCP (not through the panel) | The open panel is unaffected — still showing the same comment(s), doesn't flicker or reset, even though the whole preview just re-rendered underneath it. |
| 4.7 | Right-click one row, then immediately right-click a **different** row without closing the panel | The second right-click's menu is scoped to the second row's comment, not stale from the first. |

## Right-click actions — badge-scoped (fallback path)

Right-clicking the floating badge directly (without expanding the panel first) still works, for
when you want to act without opening the panel — falls back to a picker only when the block has
more than one applicable comment. The badge lives on its own DOM element now (see the Markers
section above), completely separate from the actual document content it's positioned over.

| # | Do | Expect |
|---|---|---|
| 5.1 | Right-click a badge over **exactly one** unresolved comment (not expanded) | Menu shows **Edit Comment**, **Resolve Comment**, **Delete Comment** — acts directly, no picker (only one candidate). No **Add Comment** item — that's for real content, not the badge. |
| 5.2 | Right-click a badge whose block has **two unresolved** comments (not expanded), choose **Resolve Comment** | `showQuickPick` appears listing both (truncated text + author + status); pick one → only that one resolves. |
| 5.3 | Right-click a badge whose only comment is already resolved (`hideResolvedComments: false`) | Menu shows **Reopen Comment** and **Delete Comment**, not **Edit Comment** or **Resolve Comment**. |
| 5.4 | **Right-click the actual commented text/table cell itself, not its badge** | Only **Add Comment** appears — none of the four actions. This is intentional: since the badge moved off the block entirely, acting on an existing comment always goes through the badge or the expand panel, never through right-clicking the content it's attached to. |
| 5.5 | Right-click a block with **no** comment at all | Only **Add Comment** appears (unchanged from before this feature existed). |
| 5.6 | Right-click a badge, choose an action, then immediately check the sidebar/gutter without touching the preview again | They update without any manual refresh — confirms the `onDidChangeFile` → `markdown.preview.refresh` path fires from an action taken *in* the preview too, not just from elsewhere. |
| 5.7 | Delete a comment from the **gutter** while its badge is showing in the preview | Preview badge disappears within ~1s (the debounced refresh), with no interaction in the preview itself. |
| 5.8 | Resolve a comment via an **MCP tool call** while its badge shows in the preview (default `hideResolvedComments: true`) | Badge disappears the same way — confirms the live-refresh path isn't gutter/sidebar-specific. |

## Cross-cutting

| # | Do | Expect |
|---|---|---|
| 6.1 | Open the preview for a `.md` file with comments **before** its gutter/sidebar has ever been opened this session (cold cache) | Markers appear shortly after the preview first renders (one extra render pass while the store warms up), not instantly and not never. |
| 6.2 | Two previews open side by side, each on a different commented file | Each shows only its own file's markers — no cross-contamination. |
| 6.3 | Restart the Extension Dev Host, reopen a previewed file with comments | Markers appear correctly on the very first preview render (or after the one warm-up pass from 6.1). |
| 6.4 | Open the webview dev tools console throughout this checklist | No errors from `preview.js`, in particular nothing about the click handler or JSON parsing of `data-agent-comments-json`. |
| 6.5 | With the webview dev tools **Performance** tab (or just eyeballing responsiveness), scroll and interact with a heavily-commented document for a while | No runaway CPU usage or visible lag — the `MutationObserver` driving marker sync disconnects itself during its own resync, so it should not be retriggering itself in a loop. |
