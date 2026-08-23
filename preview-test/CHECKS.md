# Markdown Preview Comments — Manual Test Plan

Manual E2E checklist for `agentComments.addCommentFromPreview` (right-click in VS Code's built-in
Markdown preview → **Add Comment**). Throwaway fixtures; delete the whole `preview-test/` folder
when the feature is signed off.

## Setup

1. `npm run compile`, then **F5** to launch the Extension Dev Host.
2. In the dev host, open a folder — this repo is fine. Comments need a workspace or the extension
   bails at activation.
3. Open `preview-test/01-blocks.md`, then **Ctrl+K V** to open the preview to the side. Keep the
   source editor visible next to it — every check compares the two.

## How to read a result

The input box prompt shows `Line N: <text>`. **`N` is the answer.** Compare it to the line number
in the source editor before you even type a comment. Press **Esc** to abort without creating
anything — that makes most of these checks a one-second read rather than a create-and-clean-up
cycle.

Only actually submit a comment where a check says to.

---

## File 1 — `01-blocks.md` (block-type coverage)

Line numbers below are the source lines in that file.

| # | Right-click on | Expect `Line N` | Notes |
|---|---|---|---|
| 1.1 | The `# Preview Test — Block Types` heading | 1 | First line of the file — off-by-one canary. |
| 1.2 | "First paragraph, plain text." | 3 | The baseline case. **Submit this one.** |
| 1.3 | The `## Heading level 2` text | 5 | |
| 1.4 | The **bold text** inside the line-7 paragraph | 7 | Inline element — exercises the `closest()` walk up to the block. |
| 1.5 | The [inline link](https://example.com) in the same paragraph | 7 | Right-click on a link, not plain text. |
| 1.6 | The `inline code` span in the same paragraph | 7 | |
| 1.7 | "Top-level list item" | 11 | |
| 1.8 | "Nested list item" | 13 | Not 11. If it reports the parent list's line, that's a finding. |
| 1.9 | "Deeply nested item" | 15 | Two levels deep. |
| 1.10 | "Ordered item two" | 19 | |
| 1.11 | "Blockquote line two." | 21 | The paragraph inside the quote starts at 21; 21 or 22 both acceptable, anything outside 21–24 is a bug. |
| 1.12 | "Nested blockquote." | 24 | |
| 1.13 | Inside the fenced `ts` code block | 26 | The opening ```` ``` ```` line. A fence is one mapped block, so 26 is correct even if you click line 29's text. |
| 1.14 | The indented code block | 33 | |
| 1.15 | The table header cell "Column A" | 35–38 | **The interesting one.** An old VS Code limitation (#133376) didn't source-map tables; current VS Code maps every non-inline token, so this should resolve. Note the exact N. |
| 1.16 | The table cell "table cell 3" | 35–38 | If per-row mapping exists you'll get 38; if only the table is mapped you'll get 35. Either is acceptable — **landing outside 35–38 is not.** |
| 1.17 | The horizontal rule | 40 | Thin target; may be hard to hit. Skip if you can't land on it. |
| 1.18 | The image | 42 | The image is an inline token, so this resolves via its containing paragraph. |
| 1.19 | "Raw HTML block" (the centred text) | 46 | Raw HTML output carries no attributes of its own, so this resolves through the preceding-sibling fallback. Worth watching. |
| 1.20 | "Task list item checked" | 49 | |
| 1.21 | The checkbox itself on that line | 49 | Clicking the `<input>`, not the text. |
| 1.22 | "Final paragraph — the last line…" | 51 | Last content line — the other off-by-one canary. **Submit this one.** |
| 1.23 | Empty space **below** the final paragraph | *no menu item* | Expected gap in the naive version: nothing resolves, so **Add Comment** should simply not appear. A menu item that appears and then anchors somewhere is a bug; an absent item is the intended behaviour. |

### Then verify what you submitted (1.2 and 1.22)

| # | Check |
|---|---|
| 1.24 | Source editor gutter shows both comments, at lines 3 and 51 exactly. |
| 1.25 | Sidebar (Agentic Comments) lists both under `preview-test/01-blocks.md`. |
| 1.26 | Explorer shows a count badge of 2 on the file. |
| 1.27 | Both render with the **blue** (user) author icon, not red. |
| 1.28 | Both are `exact` — no dimmed icon, no "Anchor: approximate match" label. |
| 1.29 | Ask an agent for `list_unresolved_comments`, or hit the MCP tool directly — both appear, shape-identical to a gutter-created comment. |

### Multi-line selections (snap-and-show)

The rule: **a bare right-click stays single-line; a selection widens to every block it touches.**
The prompt always states the result — `Line N` or `Lines N–M`. Sub-block precision is impossible
(the source map is block-level), so selecting part of a paragraph captures the whole paragraph.

| # | Select, then right-click inside the selection | Expect |
|---|---|---|
| 1.30 | Just the words "plain text" in line 3 | `Line 3` — a one-line block stays one line, and the prompt shows the selected text. |
| 1.31 | From "First paragraph" (3) through the line-7 paragraph | `Lines 3–7`. **Submit this one.** |
| 1.32 | The `## Heading level 2` line into the paragraph below it | `Lines 5–7`. |
| 1.33 | Three list items — "Second item" (12) through "Third item" (16) | `Lines 12–16`. Must include the nested items in between, not skip them. |
| 1.34 | Only the two nested items, "Nested list item" (13) → "Another nested item" (14) | `Lines 13–14`, **not** 11–16. Innermost block wins. |
| 1.35 | Across the whole blockquote (21) into the fenced code block | `Lines 21–31` — the fence's *last* line, not its first. This is the `endLineOf` derivation doing its job. |
| 1.36 | From inside the fenced code block (26) into the indented block (33) | `Lines 26–33`. |
| 1.37 | Across the whole table, header (35) through last row (38) | `Lines 35–38`, not 35–39. Trailing blank line must be trimmed. |
| 1.38 | From the table into the paragraph at 44 | `Lines 35–44`. Spans the `---` and the image. |
| 1.39 | Both task list items (48–49) | `Lines 48–49`. |
| 1.40 | From line 3 all the way to the final paragraph (51) | `Lines 3–51`. Whole-document span. |
| 1.41 | **Drag bottom-to-top**: start at line 51, drag up to line 3 | `Lines 3–51`, identical to 1.40. Backwards drags must normalize. |
| 1.42 | Select text, then right-click on a block **outside** the selection | Falls back to single-line on the block you clicked — the selection is ignored, not blended. |
| 1.43 | Select a very long run (a whole section), right-click | Range is correct and the *preview text* truncates with `…` rather than overflowing the input box. |
| 1.44 | Double-click a word to select it, then right-click it | `Line N` for that block. Double-click selection behaves like any other. |
| 1.45 | Select from a paragraph into the empty space below the final paragraph | Ends at 51, not at the sentinel line 52. |

### Verify the multi-line comment you submitted (1.31)

| # | Check |
|---|---|
| 1.46 | Gutter thread in the source editor spans lines 3–7, not just line 3. |
| 1.47 | Anchor is `exact` — the multi-line `contentHash` matched. |
| 1.48 | Edit a line **inside** the range (say line 5), wait ~1s → anchor degrades to `approximate` and shows the original snippet. Expected: a wider hash is more sensitive than a single-line one. |
| 1.49 | Undo that, then insert two lines **above** line 3 → the comment shifts to 5–9 and stays `exact`. |
| 1.50 | `get_comments` over MCP reports both the start and end line for it. |

### Input box behaviour

| # | Do | Expect |
|---|---|---|
| 1.51 | Right-click → **Add Comment** → press **Esc** | No comment created, nothing in sidebar or gutter. |
| 1.52 | Right-click → **Add Comment** → submit an empty string | No comment created. |
| 1.53 | Right-click → **Add Comment** → submit only spaces | No comment created. |
| 1.54 | Submit a comment containing markdown (`**bold**`) | Stored and displayed without mangling. |

### Stale-context / re-render

| # | Do | Expect |
|---|---|---|
| 1.55 | Right-click line 3's paragraph, press **Esc** to dismiss the menu, then right-click the line 51 paragraph | Prompt says `Line 51`, not 3. This is the attribute-restore path — the single most likely place for a silent wrong-line bug. |
| 1.56 | Right-click line 51, dismiss, right-click line 3 | `Line 3`. Same check in the other direction. |
| 1.57 | Make a **multi-block selection**, dismiss the menu, clear the selection, then right-click a single block | `Line N`, not the stale `Lines N–M`. |
| 1.58 | Type several new paragraphs into the source file so the preview re-renders repeatedly, then right-click a block | Still resolves, and to the **new** line number. |
| 1.59 | Delete a chunk of lines above an existing comment, wait ~1s | Existing comments shift correctly (this is the existing reanchor pipeline, but confirm the preview-created ones behave identically to gutter-created ones). |
| 1.60 | Scroll the preview a long way, then right-click | No dependence on scroll position. |

---

## File 2 — `02-second-file.md` (which file am I commenting on?)

**This is the check I'd run first.** The preview reads its source URI from its own embedded
settings; if an unlocked preview swaps content without regenerating that, a comment lands in the
wrong file.

| # | Do | Expect |
|---|---|---|
| 2.1 | With `01-blocks.md` previewed, open `02-second-file.md` in the source editor so the **same** preview follows to it. Right-click "Another paragraph in the second file." | Prompt says `Line 5`, and the comment lands in **`02-second-file.md`** — check the sidebar grouping, not just the gutter. |
| 2.2 | Switch the active editor back to `01-blocks.md`, right-click "First paragraph" in the preview | Lands in `01-blocks.md` at line 3. Nothing leaks across. |
| 2.3 | Open **two separate previews** side by side (one per file, use "Open Preview" from each file's editor). Right-click in each. | Each targets its own file. |
| 2.4 | **Lock** a preview (`Markdown: Toggle Preview Locking`), switch the active editor to the other file, right-click in the locked preview | Targets the locked file, not the active editor. |
| 2.5 | Comment from the preview on a file whose source editor is **closed** (open preview, close the source tab) | Still resolves — the handler calls `openTextDocument` on the URI itself. |

---

## File 3 — `03-neighbours.md` (don't break other extensions' menus)

Our item must be additive. Nothing here should have disappeared.

| # | Right-click on | Expect |
|---|---|---|
| 3.1 | Anywhere in the preview | Default **Copy / Cut / Paste** still present alongside **Add Comment**. |
| 3.2 | The rendered **frontmatter** block at the top | Built-in **Frontmatter settings** item still present. Our item may or may not appear here; what matters is theirs still works. |
| 3.3 | The **mermaid** diagram | Built-in **Open in Editor** / **Copy Source** (from `mermaid-markdown-features`) still present. |
| 3.4 | The **image** | Built-in **Copy Image** / **Open Image** still present. |
| 3.5 | "Paragraph before the mermaid diagram." | `Line 14`, comment creates normally — a file with frontmatter must not shift the line mapping. |
| 3.6 | Inside the mermaid fence | `Line 16` (the opening fence line), if our item appears there at all alongside mermaid's own. |
| 3.7 | "Final paragraph." | `Line 25`. Confirms frontmatter lines are counted, not stripped. |

---

## Cross-cutting

| # | Do | Expect |
|---|---|---|
| 4.1 | `Markdown: Reopen Editor as Preview` (the preview-as-editor mode, `vscode.markdown.preview.editor`), then right-click | Menu item appears and works. This is a different `webviewId` from the side panel. |
| 4.2 | Convert `01-blocks.md` to **CRLF** (status bar, bottom right), save, comment from the preview | Anchor is `exact`, not `approximate`. Line numbers unchanged. |
| 4.3 | Add a comment from the preview, then **resolve** it from the sidebar | Behaves exactly like a gutter-created comment. |
| 4.4 | Add a comment from the preview, then **edit** it (pencil in the gutter) | Works — nothing about the creation path should make it non-editable. |
| 4.5 | Open a `.md` file from **outside** the workspace folder and comment from its preview | Either works sanely or warns. Must not throw an unhandled error toast. |
| 4.6 | Preview an **untitled** (never-saved) markdown buffer, right-click | Warning about unsaved/virtual documents, no crash. |
| 4.7 | Open the preview's dev tools (`Developer: Open Webview Developer Tools`) and check the console | No errors from `preview.js`, in particular no `An instance of the VS Code API has already been acquired`. |
| 4.8 | Right-click in the preview of a Markdown file with **zero** matching blocks (e.g. an empty `.md`) | No menu item, no error. |
| 4.9 | Comment from the preview on the same line twice | Two independent comments, both anchored to that line. |
| 4.10 | Restart the Extension Dev Host, reopen the file | Preview-created comments reload from storage identically to gutter-created ones. |

---

## Known-and-accepted gaps in this version

Not bugs — confirm they behave as described rather than worse:

- **Block granularity.** markdown-it only source-maps whole blocks, so there is no way to anchor
  to part of one. Selecting three sentences out of a five-line paragraph captures the whole
  paragraph. The prompt says so (`Lines N–M`) rather than hiding it.
- **A bare right-click stays single-line** even on a multi-line block. Deliberate: a one-line
  `contentHash` survives edits elsewhere in the same block, so it reanchors more durably. Only a
  real selection widens the range.
- **No comment rendering in the preview.** Comments appear in the editor gutter and sidebar only,
  by design.
- **Empty space below content resolves to nothing** (check 1.23) — the menu item is absent rather
  than guessing.
