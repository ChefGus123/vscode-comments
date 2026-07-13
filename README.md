# Agentic Comments

Leave GitHub-style inline review comments on your live code, and let AI coding agents read, act on, and resolve them — no git, no PR, no copy-pasting file paths into a chat box.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Issues](https://img.shields.io/github/issues/ChefGus123/vscode-comments)](https://github.com/ChefGus123/vscode-comments/issues)

**Leave a comment**

![Leaving a comment](media/leaveComment.gif)

**An agent addresses it**

![Agent addressing a comment](media/agentAddresses.gif)

## Features

- **Inline comments, right in the gutter** — hover any line for the native "+", or right-click a line/selection → **Add Comment**. One message per comment, no reply threads to manage.
- **Comments survive edits** — anchored by content hash plus surrounding context, not just a line number. As code shifts, a comment stays `exact`, degrades to `approximate` (relocated nearby), or is flagged `orphaned` if the code is gone — never silently deleted or hidden.
- **Built for agents, not just humans** — an in-process MCP server exposes your comments as structured tools (list, fetch, create, resolve), so an agent can pull exactly what's unresolved in a file or across the whole workspace instead of you re-explaining it in chat.
- **User vs. agent, at a glance** — blue author icon for comments you wrote, red for ones an agent left; resolved comments carry a "resolved by user/agent" tag.
- **Dedicated sidebar** — comments grouped by file, unresolved by default with a toggle to show resolved, inline Resolve/Reopen/Delete actions, click-to-jump navigation.
- **Explorer badges** — files with unresolved comments get a count badge, the same way VS Code marks modified files for git.
- **Never touches git** — nothing is written inside your repo folder. Comments live in VS Code's own per-workspace extension storage.

## Commands

| Command | Trigger |
|---|---|
| **Add Comment** | Gutter "+" on hover, or right-click a line/selection in the editor |
| **Resolve** / **Reopen** | Comment thread title bar, or inline in the sidebar |
| **Delete** | Comment thread title bar, or inline in the sidebar — permanent, works on unresolved and resolved comments alike |
| **Reveal Comment** | Click a comment in the sidebar — jumps to it and expands the thread |
| **Show Resolved Comments** / **Hide Resolved Comments** | Sidebar toolbar |
| **Refresh** | Sidebar toolbar |
| **Clear All Comment Data for This Workspace** | Command Palette — deletes all stored comments for the workspace; irreversible |

## MCP Tools

Any MCP-compatible agent gets these tools automatically once the extension is active — enable/disable them per your agent's own tool picker, same as any other MCP tool.

| Tool | What it does |
|---|---|
| `list_unresolved_comments` | List unresolved comments, optionally scoped to one file, grouped by file |
| `get_comments` | Fetch comments for one or more files, optionally including resolved ones |
| `add_comments` | Create one or more comments in a single call, grouped by file |
| `resolve_comments` | Resolve one or more comments by id, grouped by file |

Every response flags comments whose anchor isn't exact (`locationUncertain: true`) rather than hiding them, so an agent always knows when to double-check a line number before trusting it.

## Release Notes

### 0.2.2
- Improved tool descriptions to improve adherence

---

**[Report an issue](https://github.com/ChefGus123/vscode-comments/issues)** · [License: MIT](LICENSE)
