# Agentic Comments

Leave GitHub-style inline review comments directly on your live code — no git, no PRs, no diffs — and let AI coding agents (Copilot, Claude Code, or any MCP-compatible agent) read and act on them as structured, location-anchored context. Agents can leave comments back, too, turning the extension into a shared scratchpad between you and however many agent sessions you run.

## Why

Explaining "where" a problem is to an agent, over and over, in chat, doesn't scale — and reviewing an agent's work by narrating line numbers back at it is worse. This extension gives both of you the same, persistent, at-a-glance view: comment on the actual code, in place, and have it survive across chat sessions, agent restarts, and further edits.

**The core loop:**
1. You select some code and leave a comment, the same way you'd comment on a GitHub diff.
2. An agent calls a tool to fetch unresolved comments — for one file or the whole workspace — instead of you re-explaining where the issue is.
3. The agent acts (fixes the code, replies in its own chat) and either resolves the comment via a tool call, or leaves its own comment for you or another agent session to pick up.
4. You see, at a glance, what's resolved, what isn't, and whether a resolution came from you or an agent.

## Use cases

- **Code review for agent output.** Leave comments on the parts you want changed instead of writing another prompt — the agent's next turn (or a fresh session) can just ask for unresolved comments.
- **Leaving yourself notes mid-task.** Flag something to come back to without breaking flow.
- **Handing off between agent sessions.** One agent (or subagent) leaves a comment for another to pick up — a shared, durable scratchpad not tied to any one chat's context window.
- **Tracking review status across a large change.** The sidebar and Explorer badges show what's outstanding without reopening every file.

## Features

- **Native inline comments** — the gutter "+" (single line) or a range selection + right-click → *Add Comment* (multi-line), using VS Code's own Comments UI (the same API GitHub/GitLab PR extensions use).
- **Author-aware styling** — blue for comments you left, red for comments an agent left, with anchor confidence layered on top (dimmed = approximate location, warning glyph = orphaned).
- **Resolve / Reopen** — binary status, right on the comment thread's title bar. A resolved comment shows who resolved it (you or an agent).
- **Delete** — permanently removes a comment, whether it's unresolved or already resolved. Available from the comment thread's title bar and the sidebar. Irreversible and immediate — no confirmation prompt.
- **Sidebar panel** — a dedicated "Agentic Comments" view in the Activity Bar, grouped by file, with click-to-jump navigation and inline Resolve/Reopen/Delete actions. Toggle "Show Resolved" to see the full history, not just what's outstanding.
- **Explorer badges** — files with unresolved comments get a colored count badge, the same mechanism VS Code's Git integration uses for modified files.
- **Anchors that degrade gracefully** — comments track a content hash plus surrounding context, not just a line number, so they survive edits. Anchor confidence is always shown, never hidden: `exact`, `approximate` (relocated via context), or `orphaned` (kept, flagged, never deleted).
- **Nothing touches git.** Comment data lives entirely in VS Code's own per-workspace extension storage, outside your repo folder — no `.gitignore` entries, nothing to accidentally commit.

## Agent integration (MCP)

The extension runs its own in-process MCP server (via `vscode.lm.registerMcpServerDefinitionProvider`), so **any MCP-compatible agent** — GitHub Copilot agent mode, Claude Code, or anything else that speaks MCP — can use it once the extension is active. There's nothing extra to configure; VS Code discovers it automatically.

Four tools are exposed:

| Tool | Purpose |
|---|---|
| `list_unresolved_comments` | List unresolved comments, grouped by file. Omit `file` to list across the whole workspace. |
| `get_comments` | Get all comments for one or more files in a single call, grouped by file, optionally including resolved ones (`includeResolved: true`). |
| `add_comments` | Leave one or more comments in a single call, grouped by file (`{ files: { "path": [{ line, text }] } }`). Always attributed to the agent. |
| `resolve_comments` | Resolve one or more comments in a single call, grouped by file (`{ files: { "path": ["id1", "id2"] } }`). Always attributed to the agent. |

The multi-comment tools are bulk by design — one call handles many comments across many files, each item succeeding or failing independently, and responses omit fields that are almost always the same value (e.g. a normal `fileStatus`, an exact anchor) to keep them token-lean.

There's no delete tool — agents can resolve comments, not erase them; deleting is a manual, UI-only action.

Whether an agent can use these tools at all is controlled entirely through **VS Code's own MCP tool enable/disable picker** — there's no separate permission system to configure inside the extension.

## Commands

| Command | Where it shows up |
|---|---|
| **Add Comment** | Gutter "+" on hover, or right-click a line/selection → *Add Comment* |
| **Resolve** / **Reopen** | Comment thread title bar; also as an inline action in the sidebar |
| **Delete** | Comment thread title bar; also as an inline action in the sidebar — permanent, no confirmation prompt |
| **Reveal Comment** | Click a comment in the sidebar — jumps to it and expands the thread if collapsed |
| **Show Resolved Comments** / **Hide Resolved Comments** | Toolbar icon in the Agentic Comments sidebar panel |
| **Refresh** | Toolbar icon in the Agentic Comments sidebar panel |
| **Clear All Comment Data for This Workspace** | Command Palette — deletes all stored comment data for the current workspace (escape hatch; irreversible) |

## Requirements

VS Code 1.101 or newer (for the MCP server registration API).

## Design notes

- Comments are a single message per anchor — there are no reply threads. An agent's response belongs in its own chat/session or as a code change, never written back into the comment.
- Status is binary (`resolved`/`unresolved`); "who resolved it" is metadata riding alongside, not a third state. Delete is separate from status — it's a permanent removal, not a state.
- Renamed or moved files aren't automatically tracked (VS Code has no reliable way to detect a rename made outside its own UI, e.g. via a terminal `mv`). Comments on a file that no longer resolves are kept and flagged `file-not-found` rather than silently dropped.
- Storage is local to the machine — there's no cross-clone or cross-machine syncing.
