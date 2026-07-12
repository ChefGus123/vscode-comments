# Agentic Comments

VS Code extension: inline review comments on live code, exposed to AI agents via MCP — a shared scratchpad between developer and agents, not git or a PR tool.

## Stack
TypeScript → esbuild bundle. VS Code Comments API + TreeView + FileDecoration. In-process MCP server (`@modelcontextprotocol/sdk` over local HTTP, token-authed).

## How to work on this project
- Anything sent repeatedly — tool descriptions, schemas, responses — is a real cost, not a one-off nicety. Trim it hard, right up to where a model could still misread it, no further.
- Don't answer from memory on how an editor/SDK API actually behaves. Check the installed source/types first; these surfaces move fast and guessing wrong has already cost a wrong claim once.
- Given outside input — a review, a bug report, a "what do you think" — check it against the real code before reacting, then agree or push back with reasons. Silent compliance and reflexive defense are both worse than a checked opinion.
- In general, we are against opinionating user behaviours. Should allow users to act as they wish (example, we do not limit deletion comments only for resolved/unresolved comments). However, its the other way around for agent behaviour (mcp tools), this is in order to reduce agent complexity and token costs.
- Keep fixes surgical. Bigger-scope calls (new dependencies, test infra, naming/identity decisions) get raised, not decided solo.
- Nothing is done until it typechecks and rebuilds — this project is judged by running in a real Extension Dev Host, not by a clean diff.
- A decision isn't finished until `PRD.md` says so too — update it in the same pass as the code change, not as cleanup afterward.

## Reference
- `PRD.md` — starting point, reference, and explanation for how and why this project works. A living document: keep it reflective of every decision and change as they happen, not a frozen spec.
- `README.md` — user-facing feature and tool docs, must be kept in sync with code and PRD decisions. A new/changed/removed feature that affects the user must be documented there.

## Layout
```
src/
  extension.ts       activation, wiring
  storage/           CommentStore, path canonicalization
  anchoring/         content hash + reanchor logic
  comments/          CommentController (editor UI)
  ui/                sidebar TreeView, Explorer decorations
  mcp/               MCP server + tools
  types.ts
```
