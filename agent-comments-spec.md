# Agent Comments — Product & Technical Spec

## 1. Purpose

A VSCode extension that lets a developer leave GitHub-style inline review comments directly on live code (not PRs, not diffs, no git involvement), and exposes those comments to AI coding agents (Copilot, Claude Code, or any MCP-compatible agent) as structured, queryable context — anchored to exact code locations. Agents (including subagents) can also leave comments of their own, creating a shared scratchpad between the developer and multiple agent sessions.

**Core loop:**
1. Developer selects code, leaves a comment (like commenting on a GitHub diff).
2. Agent calls a tool to fetch unresolved comments (per-file or workspace-wide) instead of the developer re-explaining "where" in a chat text box.
3. Agent acts (fixes code, responds in its own chat) and may resolve the comment via a tool call, or leave its own comment for another agent/session to pick up.
4. Developer sees, at a glance, what's resolved, what's not, and whether a resolve came from a human or an agent.

---

## 2. Non-Goals / Hard Constraints

- **Never touches git or the repo folder.** No files written inside the workspace directory, gitignored or otherwise.
- **Never compounds / never causes unbounded memory growth.** Live, in-memory/hot-path data must stay small regardless of project age or comment volume.
- **No in-tool authorization logic.** Permissions are controlled entirely via VSCode's native MCP tool enable/disable picker — not via settings flags or runtime permission checks inside our tools.
- **No reply threads.** A comment is a single message, not a conversation. Agent responses live in the agent's own chat/session or as code changes — never written back into the comment store.

---

## 3. Storage

**Location:** `context.storageUri` — VSCode's built-in, per-workspace, extension-scoped storage directory (e.g. `~/Library/Application Support/Code/User/workspaceStorage/<workspace-hash>/<extension-id>/` on macOS, OS-equivalent elsewhere). It is a plain filesystem folder — `vscode.workspace.fs` read/write, no database, no size quota imposed by VSCode. Created on extension activation if it doesn't exist.

Why this location: it's outside the repo folder by construction (no `.gitignore` reliance), it's resolved natively by VSCode (no custom workspace-hashing logic to maintain), and since the extension itself hosts the MCP server (§5), there's only one consumer of this path — no cross-process path-derivation to keep in sync.

**Known caveat (accepted, not engineered around):** VSCode does not clean up `workspaceStorage` when a workspace folder is renamed, moved, or deleted — this is a long-standing, unresolved VSCode-wide issue affecting every extension, not something specific to us. Our per-comment data stays small (single-digit KB to low-MB even for long-lived, heavily-commented projects), so the practical impact is low; a manual "Clear all comment data for this workspace" command is provided as an escape hatch, but no automated orphan-scanning is built — that's a VSCode-level problem out of scope here.

**Layout:**
```
<storageUri>/
  comments/
    <file-path-hash>.json      # one file per commented source file — live/unresolved + recently resolved
  archive/
    <file-path-hash>.jsonl     # append-only, resolved comments moved out of the live file
```
`<file-path-hash>` = hash of the file's path relative to workspace root (full relative path, not basename — required so same-named files in different folders of a multi-root workspace never collide).

**Per-file JSON schema (`comments/<hash>.json`):**
```json
{
  "filePath": "src/foo.ts",
  "fileStatus": "ok",
  "comments": [
    {
      "id": "c_1a2b3c",
      "anchor": {
        "lineHint": 42,
        "contentHash": "sha1-of-line-content",
        "contextBefore": "previous line text",
        "contextAfter": "next line text",
        "status": "exact"
      },
      "author": { "type": "user" },
      "text": "handle null here",
      "status": "unresolved",
      "resolvedBy": null,
      "createdAt": "2026-07-09T10:00:00Z",
      "updatedAt": "2026-07-09T10:00:00Z"
    }
  ]
}
```

**`author` field:** either `{ "type": "user" }` or `{ "type": "agent" }`. No agent name/session tracking. The *creation path* determines the type — created via the extension's UI → `user`; created via the `add_comment` MCP tool → `agent`. No MCP client-identity parsing or session-ID minting is implemented.

**`fileStatus` field (new):** `"ok"` normally; set to `"file-not-found"` when the extension detects, at read time, that the referenced file no longer exists at that path (see §4.1 — this replaces automatic rename-tracking, which VSCode's APIs cannot reliably support for our case).

### 3.1 In-memory index (architecture addition)

The extension maintains one in-memory index for the whole workspace: `filePath → { unresolvedCount, lastModified, fileStatus }`, built once on activation (a lightweight directory listing of `comments/`, not a full parse of every file) and updated incrementally on every write.

This index exists to satisfy two needs that a naive "only load open files" model doesn't cover:
- **`list_unresolved_comments()` with no file filter** has to answer for the whole workspace — without an index, this would mean re-reading every per-file JSON from disk on every call.
- **Single-writer guarantee.** The extension (not the filesystem) is the authoritative source of truth; both UI-driven writes and MCP tool-driven writes go through the same in-process write path, serialized per-file (a simple per-file write queue). This removes the (rare, but real) risk of a UI comment and an agent's `add_comment` call racing on the same file's JSON and one silently overwriting the other.

Full comment payloads (text, anchors) are still loaded lazily per file when needed — the index itself only holds counts/metadata, keeping it small regardless of workspace size.

### 3.2 Lifecycle / bounded memory

- Only the index (small) plus per-file comment payloads for files currently open/visible are held in memory at once — never the full contents of every file in `comments/`.
- On resolve (via UI or the `resolve_comment` tool), the comment is removed from the live per-file JSON and appended as one line to the matching `archive/<hash>.jsonl`.
- Live per-file JSON is expected to stay in the single-digit-KB range. If unresolved comments on one file exceed ~200, the extension surfaces a warning (not a hard block).
- The archive is never loaded by default — only read if `get_comments` is explicitly called with `includeResolved: true`.

### 3.3 Tool I/O requirement

All four MCP tools (§8) read and write via `vscode.workspace.fs` directly against the file on disk (through the in-memory index/write-queue above) — never through an assumption that the file is open in an editor tab as a live `TextDocument`. Agents very commonly call these tools against files that aren't open in any tab; this must work correctly as the normal case, not a fallback path.

---

## 4. Anchoring

**Problem:** code under a comment changes constantly (agent edits, refactors, manual changes). Anchors must degrade gracefully rather than silently pointing at the wrong code or vanishing.

**Approach: content-hash + surrounding context, three-state confidence.**
- Each comment stores: the original line number (`lineHint`, a hint only), a hash of the commented line(s) content, and the raw text of a line or two immediately before/after for fuzzy matching. Line endings (CRLF vs LF) are normalized before hashing so a pure line-ending change (e.g. from a `.gitattributes` mismatch across machines) never triggers a false anchor downgrade.
- On file change, detected via `vscode.workspace.onDidChangeTextDocument`, debounced (idle-based, not per-keystroke) and scoped only to the file that changed and only when it has live comments loaded. Re-anchoring recomputes a hash only for the changed range, not the whole document, so this stays cheap even on large files.
  - **`exact`** — content hash still matches a line in the file.
  - **`approximate`** — the exact line changed, but surrounding context still matches nearby. Anchor relocated using context, confidence downgraded.
  - **`orphaned`** — neither line nor context found. Anchor is not deleted; the comment remains visible with its original text/context preserved, flagged as orphaned.
- **Comments are never hidden due to anchor status.** All three states are returned by both `list_unresolved_comments` and `get_comments`, with `anchor.status` included, so an agent can decide whether to trust the line number or re-derive location from the comment text/context itself.

This mirrors GitHub's "outdated comment" UX philosophy (never hide, always label confidence) but is not commit/diff-bound — it re-evaluates continuously against the live file and can recover from `approximate` back toward higher confidence, which GitHub's terminal "outdated" state does not attempt.

### 4.1 File-level handling (replaces automatic rename-tracking)

**Important correction from initial design:** VSCode's `onDidRenameFiles` event only fires for renames performed through VSCode's own UI gestures or its `workspace.applyEdit` API — it explicitly does not fire for renames done via `workspace.fs`, by another application, or (the common case for us) by an agent running a shell command (`mv`, `git mv`, a script) in the integrated terminal. Since agent-driven renames are expected to be frequent and typically happen via terminal/tooling rather than VSCode's own rename gesture, this event cannot be relied on to automatically follow a renamed file's comments.

A filesystem-watcher-based heuristic (correlating a delete + a create within a time window as "probably the same file") was considered and rejected — it risks false-positive matches (two unrelated files changing around the same time) and adds real complexity for an uncertain payoff.

**Adopted approach:** no automatic rename-following. Instead:
- When a tool call or UI action references a file whose path no longer resolves on disk, the extension sets that file's `fileStatus` to `"file-not-found"`.
- The comments are **not deleted or hidden** — `list_unresolved_comments` and `get_comments` still return them, with `fileStatus` included, so a human or agent sees "these comments existed, their file is gone" and can decide to manually reconnect (re-comment on the new file) or discard them.
- This is a deliberate, small UX tradeoff (renamed files don't automatically carry comments forward) in exchange for correctness — no fragile guessing, consistent with the same "never hide, always label" principle used for line-level anchoring.

---

## 5. Architecture / Technologies

- **VSCode Extension** (TypeScript), the single component owning:
  - The Comments UI (`vscode.comments.createCommentController`)
  - The comment storage (read/write to `context.storageUri`, via the in-memory index/write-queue in §3.1)
  - The MCP server exposing tools to agents
  - The sidebar TreeView and file decorations (§6)
- **VSCode Comments API** (`vscode.comments` namespace) — native threaded-inline-comment UI, the same API GitHub/GitLab PR extensions use. Configured with:
  - A `commentingRangeProvider` on the `CommentController`, enabling the gutter "+" affordance on any line/range.
  - `CommentThread.canReply = false` — disables the reply box, enforcing the one-comment-per-thread model (§2).
- **MCP server**, registered via `vscode.lm.registerMcpServerDefinitionProvider` (in-process, extension-managed) — not a separate standalone process. This means:
  - Any MCP-compatible agent (Copilot agent mode, Claude Code, others) can use it, not just one vendor's proprietary tool API.
  - It runs in the same process as the extension, sharing direct access to `context.storageUri` with no path-handoff or pointer files needed.
- **`vscode.window.registerFileDecorationProvider`** — for the Explorer file badges in §6 (the same API VSCode's built-in Git extension uses for modified-file indicators).
- **`vscode.window.registerTreeDataProvider`** (via a contributed view in a custom Activity Bar view container) — for the sidebar unresolved-comments list in §6.
- **No SQLite, no database.** Flat JSON per file is sufficient at the expected scale (hundreds, not millions, of comments) and keeps everything human-readable/debuggable.

---

## 6. VSCode UI/UX

**Creating a comment:**
- Gutter "+" icon on hover for single-line comments (native `commentingRangeProvider` behavior).
- Select a multi-line range + "Add Comment" command/keybinding for range comments.
- Both are supported by the same native provider configuration — no extra UI logic needed.

**Visual distinction:**
- **Author:** blue gutter icon/marker for user-created comments, red for agent-created comments (`author.type` drives icon color — no identity system beyond user/agent).
- **Anchor confidence:** layered on top of author color — dimmed/reduced opacity for `approximate`, a warning glyph for `orphaned`, a distinct "file missing" glyph for `fileStatus: "file-not-found"`.
- **Resolved-by tag:** in the sidebar panel, a resolved comment shows a small tag indicating whether it was resolved by the user or by an agent (`resolvedBy.type`), even though status itself is binary (§7).

**Workspace-wide comment visibility:**
- A **custom sidebar panel** (own Activity Bar icon, a `TreeView` via `registerTreeDataProvider`), grouped by file, listing unresolved comments with click-to-jump navigation. This is the primary way to see "everything outstanding" — VSCode does have a built-in Comments panel that any `CommentController` populates automatically, but it wasn't part of the developer's existing mental model and has file-visibility limitations for closed files, so a dedicated panel is used instead.
- A **file decoration** (via `registerFileDecorationProvider`) on files in the Explorer that have unresolved comments — a colored dot/count, same mechanism VSCode's built-in Git integration uses for modified-file badges.

**Status actions:**
- Binary status only: **Resolved / Unresolved.** No intermediate "addressed" state.
- Actions exposed as comment thread title-bar actions via the `comments/commentThread/title` menu contribution point: **Resolve** / **Reopen**.
- A resolved comment displays a `resolvedBy` tag (user or agent) in the sidebar/tooltip.

---

## 7. Status Model

Binary: `unresolved` | `resolved`.

- `resolvedBy: { "type": "user" } | { "type": "agent" } | null` — set when status flips to `resolved`, cleared on reopen. This is metadata riding alongside the binary status, purely for the UI tag described in §6 — not a third state.
- On resolve (from either UI or the `resolve_comment` tool), the comment is moved out of the live JSON into the archive `.jsonl` (§3.2).

**No permission gating inside the tool.** Whether an agent *can* resolve a comment is controlled entirely by whether the `resolve_comment` tool is enabled for that agent/session in VSCode's own MCP tool picker — not by any setting or check inside the extension's code. Same principle applies to `add_comment`: if the tool is available to an agent, it can create comments; if disabled, it can't.

---

## 8. MCP Tool Contract

Four tools total, served by the extension's in-process MCP server.

### `list_unresolved_comments`
**Params:**
```json
{ "file": "src/foo.ts" }  // optional — omit for whole workspace
```
**Response:**
```json
{
  "comments": [
    {
      "id": "c_1a2b3c",
      "file": "src/foo.ts",
      "fileStatus": "ok",
      "line": 42,
      "anchorStatus": "exact",
      "author": { "type": "user" },
      "text": "handle null here",
      "createdAt": "2026-07-09T10:00:00Z"
    }
  ]
}
```

### `get_comments`
**Params:**
```json
{ "file": "src/foo.ts", "includeResolved": false }
```
**Response:** same comment shape as above, plus `status` and `resolvedBy` when `includeResolved: true`. When `includeResolved` is true, resolved entries are read from the archive `.jsonl` for that file in addition to the live JSON.

### `add_comment`
**Params:**
```json
{
  "file": "src/foo.ts",
  "line": 42,
  "endLine": 45,
  "text": "left a TODO — this needs a shared validator"
}
```
(`author` is not supplied by the caller — the extension stamps `{ "type": "agent" }` automatically because this tool is only reachable via MCP.)

**Response:**
```json
{ "id": "c_4d5e6f", "status": "created" }
```

### `resolve_comment`
**Params:**
```json
{ "file": "src/foo.ts", "id": "c_1a2b3c" }
```
**Response:**
```json
{ "id": "c_1a2b3c", "status": "resolved", "resolvedBy": { "type": "agent" } }
```

---

## 9. Known Risks — Prioritized

Assessed by likelihood × impact, not treated as equally weighted edge cases.

**High priority — addressed with architecture decisions above:**
1. **File-level displacement (renames/moves).** High likelihood (agents rename files routinely, usually via terminal commands), high impact if silent (comments simply vanish from tool results). Addressed in §4.1: no auto-follow, `fileStatus: "file-not-found"` flagging instead.
2. **Tool calls against unopened files.** Not an edge case — the normal case. Addressed in §3.3: tools read/write via `vscode.workspace.fs`, never assuming a live editor buffer.
3. **Workspace-wide scans needing to touch every file on disk.** Real gap in a naive "only load open files" design. Addressed in §3.1: in-memory index.
4. **Concurrent writes (UI + agent touching the same file's store near-simultaneously).** Rare as an exact race, but the fix is nearly free once the index/write-queue exists (§3.1), so it's resolved as a byproduct rather than left as an accepted gap.

**Medium — cheap implementation details, not architecture changes:**
- Line-ending (CRLF/LF) drift causing spurious `approximate` anchor status — normalize before hashing (§4).
- Large-file re-anchoring cost — hash only the changed range, not the full document (§4).

**Low — acknowledged, not acted on:**
- Path casing/slash-direction differences across OS, and symlink duplication. Storage is local-machine-only by design already; these only bite in unusual setups and aren't worth spec changes.
- Multi-root workspace filename collisions — already correctly avoided by hashing the full workspace-relative path rather than the basename (§3); no design change needed, just an implementation note not to take a shortcut here.

---

## 10. Summary of Key Decisions (quick reference)

| Area | Decision |
|---|---|
| Storage location | `context.storageUri` (VSCode-native, per-workspace, outside repo) |
| Storage format | One JSON per commented file + append-only archive `.jsonl` on resolve |
| Git safety | Storage lives entirely outside the workspace folder — no `.gitignore` dependency |
| Memory bound | In-memory index (metadata only) + lazily-loaded per-file payloads for open/visible files; resolved comments archived out of the hot path |
| Concurrency | Single in-process writer, per-file write queue — no external DB locking needed |
| Comment model | Single message per anchor, no reply threads |
| Anchoring | Content hash + context lines; three states: `exact` / `approximate` / `orphaned`; never hidden |
| File displacement | No auto-rename-tracking (VSCode API doesn't support it reliably for terminal-driven renames); `fileStatus: "file-not-found"` flag instead |
| Author model | Binary `user` / `agent`, no per-agent/session identity |
| Status model | Binary `resolved` / `unresolved`, with a non-blocking `resolvedBy` tag for UI display |
| Agent permissions | No in-tool checks; controlled entirely via VSCode's MCP tool enable/disable picker |
| MCP hosting | In-process, via `vscode.lm.registerMcpServerDefinitionProvider`, bundled in the extension itself |
| UI creation | Native gutter "+" (single line) + range-select command (multi-line) |
| UI visibility | Custom sidebar TreeView (unresolved, grouped by file) + Explorer file decorations |
| UI author color | Blue = user, Red = agent |
| Tools exposed | `list_unresolved_comments`, `get_comments`, `add_comment`, `resolve_comment` |

---

## 11. Open Items / Deferred to Later Iterations

- Native VSCode Comments panel — deliberately not used in v1 in favor of the custom sidebar; revisit only if the custom TreeView proves insufficient.
- Any richer agent identity (which specific agent/session authored a comment) — explicitly out of scope; `user`/`agent` is sufficient per product decision.
- Cross-machine or cross-clone comment sharing — not addressed; storage is local to the machine via `context.storageUri`, by design (git-safety constraint).
- Manual "reconnect" UX for `file-not-found` comments (e.g. a command to re-point a displaced comment at a new file) — not designed in detail; v1 can simply surface the flag and let the comment be manually discarded/recreated.
