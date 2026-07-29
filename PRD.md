# Agentic Comments — Product & Technical PRD

**Status:** Living document. Update this file whenever a design decision, tradeoff, or behavior changes — this is the reference of record, not a historical snapshot.

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [Non-Goals / Hard Constraints](#2-non-goals--hard-constraints)
3. [Storage](#3-storage)
   - 3.1 [In-Memory Index](#31-in-memory-index)
   - 3.2 [Lifecycle / Bounded Memory](#32-lifecycle--bounded-memory)
   - 3.3 [Path Canonicalization](#33-path-canonicalization)
4. [Anchoring](#4-anchoring)
   - 4.1 [File-Level Handling (Displacement)](#41-file-level-handling-displacement)
   - 4.2 [Batch Edit Correctness](#42-batch-edit-correctness)
   - 4.3 [First-Open Reanchor Short-Circuit](#43-first-open-reanchor-short-circuit)
5. [Architecture / Technologies](#5-architecture--technologies)
6. [VSCode UI/UX](#6-vscode-uiux)
7. [Status Model](#7-status-model)
8. [MCP Tool Contract](#8-mcp-tool-contract)
   - 8.1 [`list_unresolved_comments`](#81-list_unresolved_comments)
   - 8.2 [`get_comments`](#82-get_comments)
   - 8.3 [`add_comments`](#83-add_comments)
   - 8.4 [`resolve_comments`](#84-resolve_comments)
   - 8.5 [Response Design Principles](#85-response-design-principles)
   - 8.6 [Transport Security](#86-transport-security)
9. [Commands Reference](#9-commands-reference)
10. [Known Risks — Prioritized](#10-known-risks--prioritized)
11. [Summary of Key Decisions](#11-summary-of-key-decisions)
12. [Open Items / Deferred](#12-open-items--deferred)
13. [Decision Log](#13-decision-log)

---

## 1. Purpose

A VS Code extension that lets a developer leave GitHub-style inline review comments directly on live code (not PRs, not diffs, no git involvement), and exposes those comments to AI coding agents (Copilot, Claude Code, or any MCP-compatible agent) as structured, queryable context — anchored to exact code locations. Agents (including subagents) can also leave comments of their own, creating a shared scratchpad between the developer and multiple agent sessions.

**Core loop:**
1. Developer selects code, leaves a comment (like commenting on a GitHub diff).
2. Agent calls a tool to fetch unresolved comments (per-file or workspace-wide) instead of the developer re-explaining "where" in a chat text box.
3. Agent acts (fixes code, responds in its own chat) and may resolve the comment via a tool call, or leave its own comment for another agent/session to pick up.
4. Developer sees, at a glance, what's resolved, what's not, and whether a resolve came from a human or an agent.

---

## 2. Non-Goals / Hard Constraints

- **Never touches git or the repo folder.** No files written inside the workspace directory, gitignored or otherwise.
- **Never compounds / never causes unbounded memory growth.** Live, in-memory/hot-path data stays small regardless of project age or comment volume. This applies to every long-lived map in the process, not just the obvious ones — see [§10](#10-known-risks--prioritized) for a write-queue leak that was found and fixed under this rule.
- **No in-tool authorization logic.** Permissions are controlled entirely via VS Code's native MCP tool enable/disable picker — not via settings flags or runtime permission checks inside our tools.
- **No reply threads.** A comment is a single message, not a conversation. Agent responses live in the agent's own chat/session or as code changes — never written back into the comment store.

---

## 3. Storage

**Location:** `context.storageUri` — VS Code's built-in, per-workspace, extension-scoped storage directory. Plain filesystem folder via `vscode.workspace.fs`, no database. Created on activation if missing.

**Layout:**
```
<storageUri>/
  comments/
    <hash>.json      # one file per commented source file — live/unresolved comments only
  archive/
    <hash>.jsonl      # append-only, resolved comments moved here on resolve
```
`<hash>` = sha256 (truncated to 32 hex chars) of the canonical workspace-relative path — see [§3.3](#33-path-canonicalization).

**Per-file JSON schema:**
```json
{
  "filePath": "src/foo.ts",
  "fileStatus": "ok",
  "contentHashAtLastCheck": "sha1-of-whole-file-at-last-open-check",
  "comments": [
    {
      "id": "c_1a2b3c",
      "anchor": {
        "lineHint": 42,
        "endLineHint": 42,
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
Resolved comments do **not** stay in this file — on resolve, a comment is removed from the live array and appended (with `filePath` and `archivedAt` added) to `archive/<hash>.jsonl`. If a file's live `comments` array becomes empty, the JSON file itself is deleted and its index entry removed.

**`author` field:** `{ "type": "user" }` or `{ "type": "agent" }`, no session identity. The *creation path* determines it — extension UI → `user`; MCP `add_comments` → always `agent`.

**`fileStatus`:** `"ok"` normally; `"file-not-found"` when the extension detects, at read time, that the referenced file no longer exists at that path.

### 3.1 In-Memory Index

One in-memory index for the whole workspace: `filePath → { unresolvedCount, lastModified, fileStatus }`. Built once on activation from a directory listing + parse of `comments/*.json` (parallelized via `Promise.all`, not sequential), updated incrementally on every write. This is what makes workspace-wide queries (`list_unresolved_comments` with no file filter, the sidebar's file list) cheap — no re-read of every per-file JSON on every call.

A per-file **write queue** serializes mutations (add/resolve/reopen/reanchor) so a UI write and an agent's tool call can never race on the same file's JSON. The queue self-bounds: once a file's chained write settles with nothing else queued behind it, its entry is removed — the map only ever holds files with a write actually in flight, not one entry per file ever touched.

Full comment payloads are cached lazily per file (LRU-capped at 50 entries) — the index itself holds only counts/metadata.

### 3.2 Lifecycle / Bounded Memory

- Only the index (small) plus cached payloads for recently-touched files are held at once.
- On resolve, the comment moves from live JSON to the archive `.jsonl`; the archive is only read when explicitly requested (`includeResolved: true`, or the sidebar's "Show Resolved" toggle).
- Live per-file JSON is expected to stay in the single-digit-KB range. Past ~200 unresolved comments on one file, a warning is surfaced (not a hard block).
- Directory-creation calls (`ensureDir`) happen once at `initialize()`, not on every write — they were redundant per-write overhead once the directories are known to exist.

### 3.3 Path Canonicalization

**This is the single most important correctness rule in the codebase.** Every comment is keyed by a workspace-relative path string, and the UI (editor, sidebar, decorations) and the MCP tools (agent calls) *must* resolve to the exact same string for the exact same file, or a comment silently splits into two buckets — visible to one side, invisible to the other.

- `toWorkspaceRelativePath(uri)` — the UI-side canonical form. Prefixes the workspace folder name only when there's more than one workspace folder (avoids same-named-file collisions across multi-root workspaces); plain path otherwise.
- `resolveWorkspaceRelativePath(relativePath)` — the reverse: resolves a caller-supplied relative path (which may use backslashes, or omit a multi-root prefix) back to an absolute `Uri`.
- `canonicalizeRelativePath(relativePath)` — round-trips a caller-supplied path through both of the above, so an MCP tool caller's path (which may not match the UI's exact string form) is normalized to the one true key before it ever touches the store. Every MCP tool that takes a `file` parameter uses this.

This was a real, shipped bug (an agent's comment on `src/foo.ts` was invisible in the editor because the UI had been keying the same file as `<workspace-folder-name>/src/foo.ts`) — fixed by making the UI's `includeWorkspaceFolder` flag conditional on multi-root instead of always `true`.

---

## 4. Anchoring

**Problem:** code under a comment changes constantly. Anchors must degrade gracefully rather than silently pointing at the wrong code or vanishing.

**Approach:** content-hash + surrounding context, three-state confidence.
- Each comment stores `lineHint`/`endLineHint` (a hint only), a hash of the commented line(s) content (CRLF/LF normalized before hashing), one line of raw context immediately before/after, and the raw original commented-on text itself (`originalContent`) — so once an anchor degrades there's still something human-readable to compare against, not just an opaque hash. `originalContent` is optional on the type: anchors persisted before this field existed simply don't have one, treated as "no snippet available" rather than migrated (§4.5).
- **`exact`** — content hash still matches at (or near) the hinted location.
- **`approximate`** — the exact content changed, but surrounding context still matches nearby. Anchor relocated, confidence downgraded.
- **`orphaned`** — neither content nor context found. Anchor is not deleted; the comment remains visible with its original text/context/snippet preserved, flagged as orphaned. Permanently frozen from this point on — see §4.4.
- **Comments are never hidden due to anchor status.** All three states are returned by every read-facing MCP tool and rendered in the UI (dimmed icon for approximate, warning glyph for orphaned) — an agent or developer can always see the confidence level and decide whether to trust the line number.

Two anchor-construction paths exist: `createAnchor` (from a live `vscode.TextDocument`, used by the UI) and `createAnchorFromContent` (from a raw string, used by MCP's `add_comments` — which prefers a live open/dirty editor buffer over disk content when one exists, so a comment anchors against what's actually on screen rather than the last-saved version).

### 4.1 File-Level Handling (Displacement)

VS Code's `onDidRenameFiles` only fires for renames through VS Code's own UI/`workspace.applyEdit` — not for `workspace.fs`, another application, or (the common case here) an agent running `mv`/`git mv` in a terminal. A filesystem-watcher heuristic (correlate a delete+create as "probably the same file") was considered and rejected — false-positive risk, real complexity, uncertain payoff.

**Adopted approach:** no automatic rename-following. When a file no longer resolves on disk, its `fileStatus` becomes `"file-not-found"`. Comments are **not deleted or hidden** — every read tool and the UI still surface them, flagged, so a human or agent can manually reconnect or discard. Small, deliberate UX tradeoff (renamed files don't auto-carry comments forward) in exchange for never silently guessing wrong.

### 4.2 Batch Edit Correctness

`onDidChangeTextDocument` can deliver multiple simultaneous content changes in one event (e.g. a multi-cursor edit). VS Code gives every change in that batch relative to the document *before any of them were applied* — they are not sequentially re-based against each other.

The line-shifting fast path (`shiftAnchorForChanges`) evaluates every change in a batch against an anchor's one fixed original position and sums the resulting deltas, rather than shifting the anchor after each change and comparing the next change's (still-original-coordinate) range against an already-moved target. The latter double-shifts whenever an earlier change in the array pushes the anchor's position across a later change's original location — this was a real bug, found and fixed via reasoning about VS Code's batch-change contract, not by observed failure.

Only comments whose lines actually overlap a change fall through to the expensive `reanchor()` path (window scan → full-document scan → context match). Comments untouched by an edit are never rehashed, just shifted — an O(1) operation per comment.

### 4.3 First-Open Reanchor Short-Circuit

The first time a file is opened in a session, its comments are re-validated against current content in case the file was edited out-of-band while closed (e.g. an agent's terminal command) — `onDidChangeTextDocument` can't have told us since no editor was watching. Naively, this means re-running the (potentially expensive) per-comment `reanchor()` scan for every comment in the file, every time it's opened, regardless of whether anything actually changed.

Instead, a whole-file content hash (`contentHashAtLastCheck`, stored per file) is compared first. If it matches what was recorded the last time this file was checked, the entire per-comment reanchor pass is skipped — the common case (reopening a file that hasn't changed) becomes one O(file-size) hash comparison instead of O(comments × window-scan).

### 4.4 Orphan Freeze

Early versions kept re-running the full `reanchor()` cascade (hint → window scan → full-document scan → context match) against an already-`orphaned` anchor on every subsequent edit, exactly as for any other status. The context-match step only has one line of before/after context to go on and scans from the top of the file downward, taking the first match — with common patterns (blank lines, a lone `}`, a repeated import) this occasionally produced a spurious match near the top of the file. An orphaned comment could flicker into a wrong `approximate` position there, and if it later failed to match again, *that* wrong position became the new "frozen" baseline — compounding toward line 1 over an edit history. Users reported this as comments "jumping to the start of the page" and becoming impossible to place.

**Fix:** `reanchor()` now short-circuits at the top — once `status === 'orphaned'`, it returns the anchor unchanged, permanently. The line-shifting fast path (`shiftAnchorForChanges`, §4.2) still applies to orphaned anchors, since it's deterministic drift-tracking for edits elsewhere in the file, not a re-guess of *what* the anchor points at; only an edit that directly overlaps the orphaned anchor's own lines falls through to `reanchor()`, which now just no-ops. The rendered `vscode.Range` in `syncThreads` is also defensively clamped to `[0, document.lineCount - 1]`, so a frozen line number that ends up beyond a since-shrunk file's length can never itself trigger unpredictable placement.

### 4.5 Snippet Truncation & Settings

`originalContent` (§4) can be arbitrarily large (a big selection), so both surfaces that render it cap its length:
- **UI** (comment thread body, sidebar tooltip): a fixed constant, `UI_SNIPPET_MAX_CHARS` (800) in `src/anchoring/snippet.ts`. No interactive expand affordance yet — VS Code's Comment/TreeItem markdown has no clean collapsible widget — so a hard cap plus a truncation marker is the whole story for v1 (see §12).
- **MCP**: user-configurable via `agenticComments.mcp.snippetMaxChars` (default 500 chars; 0 omits the snippet entirely).

On the MCP surface, the snippet is useful for more than orphan recovery — an agent that always gets the original code text can skip a round-trip file read. `agenticComments.mcp.alwaysIncludeSnippet` (default `true`, marked experimental) includes `originalContent` on every comment, not just ones with `locationUncertain: true`; turning it off falls back to the original degraded-only behavior. Both settings are read fresh per tool call (`vscode.workspace.getConfiguration`), so changes apply without an extension reload.

---

## 5. Architecture / Technologies

- **VS Code Extension** (TypeScript, bundled with esbuild to a single CJS file) owning: the Comments UI, the comment storage, the MCP server, and the sidebar/decorations.
- **VS Code Comments API** (`vscode.comments` namespace) — native threaded-inline-comment UI. `commentingRangeProvider` covers the whole file (enables the gutter "+" on any line). `CommentThread.canReply = false` on rendered (persisted) threads enforces one-comment-per-thread; a freshly-created draft thread (empty comments array) is left at its default `canReply = true` so its input box appears, then discarded in favor of a real thread once submitted.
- **MCP server**, registered via `vscode.lm.registerMcpServerDefinitionProvider`. Runs in-process as a local HTTP server (`@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`) bound to `127.0.0.1` on an ephemeral port, sharing direct access to the same `CommentStore` instance as the UI — no path-handoff or pointer files.
- **`vscode.window.registerFileDecorationProvider`** — Explorer badges for files with unresolved comments (same mechanism as VS Code's built-in Git modified-file indicators).
- **`vscode.window.registerTreeDataProvider`** — the sidebar's unresolved/resolved comment list.
- **No SQLite, no database.** Flat JSON per file, at the expected scale (hundreds, not millions, of comments).

---

## 6. VSCode UI/UX

**Creating a comment:**
- Gutter "+" on hover (native, from `commentingRangeProvider`).
- Right-click a line or selection → **Add Comment** (`agentComments.addCommentAtSelection`) — VS Code does *not* automatically add a context-menu entry for a registered `commentingRangeProvider` (only the gutter affordance is automatic), so this command drives the same underlying API manually: creates an empty-comments thread and expands it, which hands off to the same input-box/submit flow as the gutter path.

**Visual distinction:**
- Blue author icon = user, red = agent.
- Anchor confidence layered on top: dimmed icon for `approximate`, warning glyph for `orphaned`.
- A resolved comment shows a `resolvedBy` tag (user/agent) in its label.

**Resolved comments in the gutter — `agenticComments.editor.hideResolvedComments` (default `true`).** A resolved comment always moves out of the live JSON into the archive on disk (§3), but what happens to its rendered `CommentThread` depends on this setting:
- **Default (`true`):** the thread is disposed the moment it's resolved — resolved comments don't clutter the gutter. Still fully reachable from the sidebar (Show Resolved) and reopenable from there.
- **`false`:** the thread flips to a "resolved" visual state with a Reopen action and stays visible, sourced from the archive on every re-render (`AgentCommentsController.renderDocument` merges live + archived comments when this is off) — matching the sidebar's own behavior. Toggling the setting re-syncs all open documents immediately, no reopen needed.

Either way, on a fresh session a file's live comments load first as usual; whether resolved ones join them is decided by this setting at render time, not by anything persisted from the prior session.

**Sidebar panel:** dedicated Activity Bar view, grouped by file.
- Default: unresolved only, click-to-jump navigation (which also expands the thread if it was collapsed).
- **Show Resolved / Hide Resolved** toggle in the panel toolbar — when on, also lists files whose *only* comments are archived (fully resolved), and shows resolved entries inline with a checkmark + "resolved by" tag.
- Inline **Resolve**/**Reopen**/**Delete** action on hover, directly from the tree — no need to open the file first.

**Explorer decorations:** colored count badge on files with unresolved comments; a distinct badge for `file-not-found`.

**Status actions:** binary Resolve/Reopen, exposed as comment-thread title-bar actions. **Delete** is a separate, always-available title-bar action (not a status) — see §7.

---

## 7. Status Model

Binary: `unresolved` | `resolved`.

- `resolvedBy: { "type": "user" } | { "type": "agent" } | null` — set on resolve, cleared on reopen. Metadata riding alongside the binary status for the UI tag — not a third state.
- **No permission gating inside the tool.** Whether an agent *can* resolve/create comments is controlled entirely by whether the corresponding tool is enabled in VS Code's own MCP tool picker.

**Delete** is orthogonal to status, not a third value of it: it permanently removes a comment (live or archived) from disk, whereas resolve/reopen just move a comment between the live JSON and the archive `.jsonl` and are fully reversible. UI-only for now (comment-thread title bar + sidebar) — deliberately **not** exposed as an MCP tool, so agents can mark work done (`resolve_comments`) but can't erase review history; that stays a human-only action until there's a concrete reason for agents to need it. Shipped **without a confirmation prompt** — same posture as everything else in this extension that doesn't gate on permission, revisit if it turns out to cause accidental data loss in practice.

**Edit** changes only a comment's `text` — never its anchor, status, or author. Gutter-only, via VS Code's native per-comment `comments/comment/title` (pencil) and `comments/comment/context` (Save/Cancel) menus — not the sidebar, not the Command Palette, and, like Delete, deliberately **not** exposed as an MCP tool, so agents can't rewrite review history either. Available regardless of whether the comment is user- or agent-authored (same "don't opinionate human behavior" posture as Delete), but only on **unresolved** comments — resolved comments live in the archive `.jsonl` and editing them is out of scope for now. A blank/whitespace-only Save is treated as an implicit cancel, matching how a blank reply is already discarded in `createComment`.

`AgentCommentsController` tracks in-progress edits in `editingCommentIds` (a `Set<string>` of comment ids). This exists because every re-render path (`onDidChangeVisibleTextEditors`, `onStoreChanged`, the reanchor debounce) rebuilds an already-tracked comment via `toVscodeComment`, which hardcodes `mode: Preview` — without a guard, any of those firing while a comment sits in `CommentMode.Editing` (e.g. VS Code's own inline edit widget registering as a visible-editor change) snaps it straight back to Preview, which looked like the edit textarea "opening and immediately closing." The check lives in one place — `updateThreadComment` itself skips the rebuild when the comment's id is in `editingCommentIds`, unless called with `{ force: true }`, in which case it clears the guard and rebuilds in the same call — rather than being repeated at each call site, so a future new re-render path can't reintroduce the bug by forgetting to check it, and callers ending an edit can't reintroduce it either by clearing the guard in a separate step from the rebuild it's meant to unblock. `editComment` adds the id; `saveComment`/`cancelComment` end the edit via a single forced `updateThreadComment` call.

**Resolve overrides an in-progress edit rather than deferring to it.** A comment can be resolved (title bar, sidebar, or an agent's `resolve_comments` call) while the user has it open for editing. Since a resolved comment leaves the live JSON for the archive, nothing will ever revisit that thread again to apply a deferred rebuild — so `onStoreChanged`'s resolve branch calls `updateThreadComment` with `{ force: true }`, snapping the textarea back to Preview (showing the resolved state) instead of leaving it stuck open indefinitely. `saveComment` also checks `updateCommentText`'s return value and warns the user if the save landed on a comment that was resolved or deleted out from under it in the same race, instead of silently discarding the edit. `cancelComment` rebuilds only the single affected thread from the store's current state (no full-document re-render, no `openTextDocument` round trip) — if the comment is no longer live by the time Cancel runs, that's a no-op, since the resolve/delete event already handled it (and already cleared the guard).

---

## 8. MCP Tool Contract

Four tools, served by the extension's in-process MCP server. All are **bulk-first by design** — see [§8.5](#85-response-design-principles) for why. `list_unresolved_comments` is naturally unaffected (it was already a bulk read); the other three were redesigned specifically to avoid one-comment-per-tool-call round trips, which cost a full turn each regardless of how many a single logical action (review a file, resolve everything you just fixed) actually needs.

### 8.1 `list_unresolved_comments`

**Params:** `{ file?: string }` — omit for the whole workspace.

**Response:** grouped by file.
```json
{
  "files": {
    "src/foo.ts": {
      "comments": [
        { "id": "c_1a2b3c", "line": 42, "text": "handle null here", "author": "user" }
      ]
    }
  }
}
```
`fileStatus` appears on a file group only when `"file-not-found"`. `locationUncertain: true` appears on a comment only when its anchor isn't `exact`.

### 8.2 `get_comments`

**Params:** `{ files: string[], includeResolved?: boolean }` — one or more files in a single call.

**Response:** same grouped shape as above. Resolved entries (only present when `includeResolved: true`) carry `"status": "resolved"` and `"resolvedBy": "user" | "agent"`; unresolved entries carry neither (the default, so it costs nothing to omit).

### 8.3 `add_comments`

**Params:** grouped by file.
```json
{ "files": { "src/foo.ts": [ { "line": 42, "endLine": 45, "text": "..." } ] } }
```
**Response:** grouped by file; a whole file that fails to resolve/read returns one `error` string for that group (every item in a failed file fails identically — file resolution is the only failure mode, so a per-item error would just repeat the same string).
```json
{ "files": { "src/foo.ts": { "created": [ { "line": 42, "endLine": 45, "id": "c_4d5e6f" } ] } } }
```
Always stamped `author: { "type": "agent" }` — this tool is only reachable via MCP.

### 8.4 `resolve_comments`

**Params:** grouped by file, plain id arrays (no wrapper object needed per item).
```json
{ "files": { "src/foo.ts": [ "c_1a2b3c", "c_4d5e6f" ] } }
```
**Response:** the caller already knows which ids it asked to resolve, so a fully-successful call doesn't echo them back — just a count. Failures (id not found) are itemized, since that *is* new information.
```json
{ "resolved": 2 }
```
```json
{ "resolved": 1, "failed": { "src/foo.ts": [ { "id": "c_4d5e6f", "error": "Comment not found: c_4d5e6f" } ] } }
```
Always stamped `resolvedBy: { "type": "agent" }`.

### 8.5 Response Design Principles

These apply to every tool, present and future, and were arrived at through several rounds of measured revision, not decided upfront:

- **Bulk over one-call-per-item.** A tool call is a full round trip; doing N of them for one logical action (reviewing a file, resolving a batch of fixes) is pure waste even when the calling harness supports multiple tool calls per turn.
- **Group by the thing that repeats.** If ten comments share a file, the file path is written once as a key, not ten times as a field.
- **Hoist facts that belong to the group, not the item.** `fileStatus` is a per-file fact; it lived per-comment before, which meant repeating it once per comment in that file for no reason.
- **Omit the default, state the exception.** A comment with an exact anchor doesn't say so; only `locationUncertain: true` costs anything. A tool description explains the convention once, up front, rather than every response explaining itself.
- **Don't echo what the caller already knows.** `resolve_comments` doesn't confirm every id it was given; it reports what changed (a count) and what didn't (failures, with reasons).
- **Compact JSON, no pretty-printing.** Indentation is pure token waste for a machine-authored, machine-read payload.
- **Tool descriptions are facts, not instructions.** No "always batch this instead of calling it repeatedly" language in a description — that's sent on every single turn regardless of whether the tool is even called, so it's exactly the kind of recurring cost this whole section exists to avoid. Say what the tool does; let the schema and the response shape make the efficient usage the obvious one.

### 8.6 Transport Security

The local HTTP server binds to `127.0.0.1` on an ephemeral port with no query-string or well-known path — but that alone doesn't stop another unrelated local process from finding the port and reading/writing comment data (potentially containing sensitive review notes). A random per-session token is generated at startup and passed to VS Code via `McpHttpServerDefinition`'s `headers` option; every request must carry it back or gets a 401. This is transport-level authentication, not tool-permission logic — it doesn't touch or duplicate VS Code's own MCP tool picker (§2), it just keeps the raw endpoint from being an open door on the machine.

---

## 9. Commands Reference

| Command | Trigger |
|---|---|
| Add Comment | Gutter "+" on hover, or right-click a line/selection |
| Resolve / Reopen | Comment thread title bar; also inline in the sidebar |
| Delete | Comment thread title bar; also inline in the sidebar — permanent, no confirmation prompt, works on both unresolved and resolved comments, UI-only (no MCP tool) |
| Edit / Save / Cancel | Per-comment pencil icon (`comments/comment/title`) and Save/Cancel buttons (`comments/comment/context`) — text only, unresolved comments only, UI-only (no MCP tool) |
| Reveal Comment | Click a comment in the sidebar — jumps to it and expands the thread if collapsed |
| Show Resolved / Hide Resolved | Toolbar icon in the sidebar panel |
| Refresh | Toolbar icon in the sidebar panel |
| Clear All Comment Data for This Workspace | Command Palette — deletes all stored data for the workspace; irreversible |

Commands that require a UI-supplied context object (`addComment`, `resolveComment`, `reopenComment`, `deleteComment`, `editComment`, `saveComment`, `cancelEditComment`, `revealComment`, `resolveCommentInTree`, `reopenCommentInTree`, `deleteCommentInTree`) are hidden from the Command Palette (`when: false`) — invoked without their context argument, they'd fail; this was a real shipped bug (every one of them threw "cannot read properties of undefined" when reachable from the palette) before being excluded.

---

## 10. Known Risks — Prioritized

Resolved during development (kept here as a record of what was checked, not just what's outstanding):

- **Path identity mismatch between UI and MCP** (§3.3) — fixed. Was a shipped bug.
- **Multi-change batch coordinate bug in anchor shifting** (§4.2) — fixed. Found via reasoning about VS Code's batch-change contract, not observed failure; upgraded from "worth a manual test" to confirmed.
- **Unbounded write-queue map** — fixed. Violated the §2 bounded-memory constraint; entries now self-remove once settled.
- **Resolve/Reopen buttons both showing on unresolved threads** — fixed. `when` clause used unanchored regex (`=~ /resolved/`) where `"resolved"` is a substring of `"unresolved"`; changed to exact match.
- **`add_comments` anchoring against stale on-disk content** when a live editor buffer disagreed with disk — fixed, prefers the open buffer.
- **Sequential (not parallelized) workspace-wide reads** — fixed in `initialize()`, `listUnresolved()`, `listArchivedFilePaths()`.
- **Redundant directory-existence checks on every write** — fixed, directories are known to exist after `initialize()`.
- **Abandoned draft comment threads** (right-click → Add Comment → never submit → close tab) — fixed for the tab-close case; click-away-without-closing-the-tab is unverified (would require observing VS Code's own comment-widget behavior live).
- **No test suite.** Fixed — Jest + Babel unit suite added with 100% statement/branch coverage across every file in `src/`. See "Testing" in §11 for the runner/mocking decisions.

Still open / accepted:

- **Path casing/slash-direction differences across OS, symlink duplication.** Low priority — storage is local-machine-only by design already.
- **Cross-machine/cross-clone comment sharing.** Not addressed; storage is local to the machine by design (git-safety constraint).

---

## 11. Summary of Key Decisions

| Area | Decision |
|---|---|
| Storage location | `context.storageUri` — outside the repo folder by construction |
| Storage format | One JSON per commented file (live/unresolved only) + append-only archive `.jsonl` on resolve |
| Path identity | One canonical workspace-relative path, enforced by round-tripping through the same resolve/relativize functions on both the UI and MCP side |
| Memory bound | In-memory index (metadata only) + LRU-capped payload cache + self-bounding write queue |
| Concurrency | Single in-process writer, per-file write queue |
| Comment model | Single message per anchor, no reply threads |
| Anchoring | Content hash + context lines; `exact`/`approximate`/`orphaned`, never hidden; batch-aware shifting; whole-file-hash short-circuit on first open |
| Anchor recall | Original snippet text (`originalContent`) persisted on the anchor and shown wherever anchor status is degraded; truncated per-surface (fixed cap in UI, configurable cap + always-on toggle in MCP) |
| Orphan freeze | Once `orphaned`, `reanchor()` never re-searches — permanently frozen at its last position instead of drifting on later edits |
| File displacement | No auto-rename-tracking; `fileStatus: "file-not-found"` flag instead |
| Author model | Binary `user`/`agent`, no per-agent/session identity |
| Status model | Binary `resolved`/`unresolved`, with a non-blocking `resolvedBy` tag |
| Resolved-thread UX | Stays visible in-editor for the session even though archived on disk |
| Agent permissions | No in-tool checks; entirely via VS Code's MCP tool picker |
| MCP hosting | In-process, local HTTP, token-authenticated |
| MCP tool design | Bulk-first, grouped-by-file, lean/omit-by-default responses |
| UI creation | Native gutter "+" + an explicit right-click command (VS Code doesn't auto-add one) |
| UI visibility | Custom sidebar TreeView (toggle unresolved/all) + Explorer file decorations |
| Testing | Jest + Babel (`@babel/preset-typescript`, transpile-only — `tsc` already owns type-checking); `vscode` mocked by hand in `test/__mocks__/vscode.ts` (in-memory `workspace.fs`, real `Uri`/`Range`/`EventEmitter` semantics) since `@types/vscode` has no runtime module to import; `mcp/server.ts` tested against a real HTTP server + real `@modelcontextprotocol/sdk` client, not mocked, since the wire protocol is the actual surface being verified |

---

## 12. Open Items / Deferred

- Native VS Code Comments panel — not used; the custom sidebar covers this and adds the resolved-toggle/inline-actions the built-in panel doesn't.
- Richer agent identity (which specific agent/session authored a comment) — explicitly out of scope.
- Cross-machine or cross-clone comment sharing — not addressed, by design.
- Manual "reconnect" UX for `file-not-found` comments — not designed in detail; the flag is surfaced, reconnection is currently a manual discard-and-recreate.
- Interactive expand-to-full-snippet UI — deferred; the current UI truncates `originalContent` at a fixed cap with a truncation marker, no expand affordance.
- Auto-focusing the comment input box on right-click "Add Comment" (to match the gutter "+" flow) — investigated and blocked: focusing a `CommentThread`'s input textarea (`focusCommentEditor()`) is a private method on VS Code's own internal comment-widget class, not a registered command and not exposed anywhere on the public `CommentThread`/`CommentController` API surface (confirmed against the installed `@types/vscode` and by inspecting the actual VS Code build). No public API exists for an extension to trigger it. Revisit only if VS Code adds one.

---

## 13. Decision Log

Chronological, most recent last. Add an entry whenever a decision in this doc changes.

- **Storage/anchoring/UI/MCP baseline implemented** per the original design spec (single-comment threads, three-state anchoring, in-process MCP server, sidebar + decorations).
- **Fixed path identity mismatch** between UI (`toWorkspaceRelativePath` always including the multi-root prefix) and MCP tools (raw caller string) — introduced `canonicalizeRelativePath` as the single source of truth for both sides.
- **Added bulk MCP tools** (`add_comments`, `resolve_comments`, multi-file `get_comments`) replacing one-comment-per-call versions — avoids a full round trip per item for what's usually one logical action.
- **Redesigned MCP responses to group by file** and hoist file-level facts (`fileStatus`) out of individual comments; `resolve_comments` further compressed to a bare success count plus itemized failures, since the caller already knows what it asked to resolve.
- **Added transport-level auth token** for the local MCP HTTP endpoint — closes the "any local process that finds the port" gap without touching tool-permission logic.
- **Fixed multi-cursor batch anchor-shifting bug** — changes in one `onDidChangeTextDocument` batch are relative to the pre-batch document, not sequentially re-based; the shifting logic now evaluates every change against one fixed original position.
- **Added whole-file-hash short-circuit** for first-open reanchoring — avoids O(comments × window-scan) on every file open when nothing changed since last checked.
- **Bounded the write-queue map** — entries now self-remove once settled, instead of accumulating for the life of the extension host.
- **Resolved comments stay visible in-editor for the session** despite moving to the archive on disk — reconciles the storage model with the desired UX.
- **Rebranded "Agent Comments" → "Agentic Comments"** across display strings; internal command/controller ids (`agentComments.*`) kept stable.
- **Added a Jest unit test suite** at 100% statement/branch coverage across `src/`. `ts-jest` was tried first and rejected — it crashes against the project's TypeScript ^7 beta (`ConfigSet._resolveTsConfig` throws); switched to `babel-jest` + `@babel/preset-typescript`, which only transpiles (no type-checking, already covered by `npm run typecheck`) and has no TS-version coupling. `vscode` has no real module to require outside the extension host, so `test/__mocks__/vscode.ts` hand-implements the slice of the API `src/` actually uses (in-memory `workspace.fs`, functioning `Uri`/`Range`/`EventEmitter`/`TreeItem`, etc.) rather than pulling in a third-party mock package. `mcp/server.ts` is tested by starting the real HTTP server and driving it with a real `@modelcontextprotocol/sdk` client — the wire protocol and auth-header check are the actual thing worth verifying there. A handful of genuinely defensive branches unreachable through any public code path (e.g. a cache-eviction guard, a zod-defaulted argument) are exercised by direct white-box calls into private members rather than left uncovered.
- **0.3.0 — fixed orphaned-comment recall.** Users reported that once enough lines changed, an orphaned comment became impossible to place — no way to see what code it used to be about, and it sometimes appeared to "jump to the start of the page." Root cause: `reanchor()` kept re-running its full search cascade against already-`orphaned` anchors on every later edit, and the single-line context-match step (scanning from line 0) could spuriously relocate one to a wrong position near the top, which then became the new "frozen" baseline next time it re-orphaned — compounding drift toward line 1 over an edit history. Fixed by short-circuiting `reanchor()` once `status === 'orphaned'` (§4.4) and by persisting the original commented-on text (`originalContent`) on the anchor so degraded comments always show what they were about, in the editor, sidebar, and MCP responses (§4.5). Added a defensive clamp on the rendered `vscode.Range` so a frozen line number beyond a shrunk file's length can't itself cause unpredictable placement. Also added two new settings, `agenticComments.mcp.alwaysIncludeSnippet` (default on, experimental — includes the snippet on every MCP comment, not just degraded ones, saving agents a round-trip file read) and `agenticComments.mcp.snippetMaxChars` (default 500) — the extension's first-ever contributed settings.
- **Added Edit (comment text only)** — gutter-only via the previously-unused `comments/comment/title`/`comments/comment/context` menu points, mirroring Delete's never-an-MCP-tool posture so agents can't rewrite review history. Restricted to live (unresolved) comments; works regardless of `author.type`. Required repurposing `vscode.Comment.contextValue` (previously doubling as the rendered comment's id) into a pure `'editable'`/`undefined` menu-gating tag — `comments/comment/title`'s `when` clause needs exact string equality, so it can't also carry an id — with the id and a back-reference to the owning `CommentThread` moved onto custom `id`/`parent` fields (`vscode.Comment` is a plain interface, extra fields are fine; same pattern VS Code's own `comment-sample` extension uses). Caught and fixed a pre-existing, never-exercised bug in the test mock's `CommentMode` enum (`Editable` instead of the real API's `Editing`) while wiring this up.
