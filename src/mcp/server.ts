import * as http from 'http';
import { AddressInfo } from 'net';
import { randomUUID, randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CommentStore } from '../storage/store';
import { canonicalizeRelativePath, resolveWorkspaceRelativePath, toWorkspaceRelativePath } from '../storage/paths';
import { createAnchorFromContent } from '../anchoring/anchor';
import { ToolCommentView } from '../types';

export const AUTH_HEADER = 'x-agent-comments-token';

/**
 * Lean wire format for tool responses — every field costs tokens on every call. Responses are
 * grouped by file (`{ files: { "<path>": {...} } }`) instead of repeating the file path on every
 * comment, and file-level facts (fileStatus) live once on the group rather than once per comment.
 * Fields that are almost always the same value (an exact anchor, an unresolved status) are omitted
 * rather than spelled out, and author/resolvedBy are flattened from {type: "x"} to plain "x".
 */
interface McpCommentEntry {
  id: string;
  line: number;
  endLine?: number;
  text: string;
  author: 'user' | 'agent';
  locationUncertain?: true;
  status?: 'resolved';
  resolvedBy?: 'user' | 'agent';
}

function toMcpCommentEntry(c: ToolCommentView): McpCommentEntry {
  const entry: McpCommentEntry = {
    id: c.id,
    line: c.line,
    text: c.text,
    author: c.author.type,
  };
  if (c.endLine !== undefined) {
    entry.endLine = c.endLine;
  }
  if (c.anchorStatus !== 'exact') {
    entry.locationUncertain = true;
  }
  if (c.status === 'resolved') {
    entry.status = 'resolved';
    if (c.resolvedBy) {
      entry.resolvedBy = c.resolvedBy.type;
    }
  }
  return entry;
}

/** Prefers a live open/dirty buffer over disk content, so a comment anchors against what's actually
 * on screen rather than the last-saved version (§3.3 — tools must work with no open editor as the
 * normal case, but must not ignore one when it happens to exist and disagrees with disk). */
async function readCurrentText(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

function resolveCanonicalFile(file: string): { canonicalFile: string } | { error: string } {
  const canonicalFile = canonicalizeRelativePath(file);
  if (!canonicalFile) {
    return { error: `Could not resolve "${file}" to a file in this workspace.` };
  }
  return { canonicalFile };
}

export class AgentCommentsMcpServer implements vscode.Disposable {
  private httpServer: http.Server | undefined;
  private transport: StreamableHTTPServerTransport | undefined;
  private mcpServer: McpServer | undefined;
  private _port: number | undefined;
  private readonly authToken = randomBytes(24).toString('hex');

  constructor(private readonly store: CommentStore) {}

  get port(): number | undefined {
    return this._port;
  }

  /** Shared secret VS Code sends back on every request (via McpHttpServerDefinition's headers) so
   * an unrelated local process that merely discovers our ephemeral port can't read/write comments. */
  get token(): string {
    return this.authToken;
  }

  async start(): Promise<number> {
    const server = new McpServer({ name: 'agent-comments', version: '0.1.0' });
    this.registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);

    const httpServer = http.createServer((req, res) => {
      if (!req.url || !req.url.startsWith('/mcp')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers[AUTH_HEADER] !== this.authToken) {
        res.statusCode = 401;
        res.end();
        return;
      }
      void transport.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    this.mcpServer = server;
    this.transport = transport;
    this.httpServer = httpServer;
    this._port = (httpServer.address() as AddressInfo).port;
    return this._port;
  }

  dispose(): void {
    this.httpServer?.close();
    void this.transport?.close();
    void this.mcpServer?.close();
  }

  private registerTools(server: McpServer): void {
    server.registerTool(
      'list_unresolved_comments',
      {
        title: 'List unresolved comments',
        description:
          'Lists unresolved review comments, grouped by file. Omit "file" to list across the whole workspace. ' +
          '"locationUncertain: true" means the code nearby changed and the line number may be off.',
        inputSchema: {
          file: z.string().optional().describe('Workspace-relative file path. Omit for the whole workspace.'),
        },
      },
      async ({ file }) => {
        let canonicalFile: string | undefined;
        if (file !== undefined) {
          const resolved = resolveCanonicalFile(file);
          if ('error' in resolved) {
            return asError(resolved.error);
          }
          canonicalFile = resolved.canonicalFile;
        }
        const comments = await this.store.listUnresolved(canonicalFile);
        const files: Record<string, { fileStatus?: 'file-not-found'; comments: McpCommentEntry[] }> = {};
        for (const c of comments) {
          const group = (files[c.file] ??= { comments: [] });
          if (c.fileStatus !== 'ok') {
            group.fileStatus = c.fileStatus;
          }
          group.comments.push(toMcpCommentEntry(c));
        }
        return asResult({ files });
      }
    );

    server.registerTool(
      'get_comments',
      {
        title: 'Get comments for files (bulk)',
        description:
          'Gets all comments for one or more files, grouped by file, optionally including resolved ones. ' +
          'A "status": "resolved" entry means resolved; "resolvedBy" comes with it.',
        inputSchema: {
          files: z.array(z.string()).min(1).describe('Workspace-relative file paths.'),
          includeResolved: z.boolean().optional().default(false),
        },
      },
      async ({ files, includeResolved }) => {
        const perFile = await Promise.all(
          files.map(async (file) => {
            const resolved = resolveCanonicalFile(file);
            if ('error' in resolved) {
              return [file, { error: resolved.error }] as const;
            }
            const comments = await this.store.getComments(resolved.canonicalFile, includeResolved ?? false);
            const fileStatus =
              comments.length > 0 ? comments[0].fileStatus : (await this.store.loadFile(resolved.canonicalFile)).fileStatus;
            const group: { fileStatus?: 'file-not-found'; comments: McpCommentEntry[] } = {
              comments: comments.map(toMcpCommentEntry),
            };
            if (fileStatus !== 'ok') {
              group.fileStatus = fileStatus;
            }
            return [file, group] as const;
          })
        );
        return asResult({ files: Object.fromEntries(perFile) });
      }
    );

    const addCommentEntrySchema = z.object({
      line: z.number().int().min(1).describe('1-indexed start line.'),
      endLine: z.number().int().min(1).optional().describe('1-indexed end line, for range comments.'),
      text: z.string().min(1),
    });

    server.registerTool(
      'add_comments',
      {
        title: 'Add comments (bulk)',
        description: 'Leaves one or more review comments, grouped by file, in one call. Always stamped as author type "agent".',
        inputSchema: {
          files: z.record(z.array(addCommentEntrySchema)).describe('Map of workspace-relative file path to the comments to add there.'),
        },
      },
      async ({ files }) => {
        const perFile = await Promise.all(
          Object.entries(files).map(async ([file, items]) => {
            const uri = resolveWorkspaceRelativePath(file);
            if (!uri) {
              return [file, { error: `No workspace folder open to resolve "${file}".` }] as const;
            }
            let content: string;
            try {
              content = await readCurrentText(uri);
            } catch {
              return [file, { error: `File not found: ${file}` }] as const;
            }
            const canonicalFile = toWorkspaceRelativePath(uri);
            const created = await Promise.all(
              items.map(async (item) => {
                const startLine0 = item.line - 1;
                const endLine0 = (item.endLine ?? item.line) - 1;
                const anchor = createAnchorFromContent(content, startLine0, Math.max(startLine0, endLine0));
                const comment = await this.store.addComment(canonicalFile, anchor, item.text, { type: 'agent' });
                return item.endLine !== undefined
                  ? { line: item.line, endLine: item.endLine, id: comment.id }
                  : { line: item.line, id: comment.id };
              })
            );
            return [file, { created }] as const;
          })
        );
        return asResult({ files: Object.fromEntries(perFile) });
      }
    );

    server.registerTool(
      'resolve_comments',
      {
        title: 'Resolve comments (bulk)',
        description:
          'Resolves one or more comments, grouped by file, in one call. Always stamped as resolved by author type "agent".',
        inputSchema: {
          files: z.record(z.array(z.string())).describe('Map of workspace-relative file path to the comment ids to resolve there.'),
        },
      },
      async ({ files }) => {
        let resolvedCount = 0;
        const failed: Record<string, { id: string; error: string }[]> = {};

        await Promise.all(
          Object.entries(files).map(async ([file, ids]) => {
            const resolved = resolveCanonicalFile(file);
            if ('error' in resolved) {
              failed[file] = ids.map((id) => ({ id, error: resolved.error }));
              return;
            }
            const results = await Promise.all(
              ids.map(async (id) => ({ id, ok: !!(await this.store.resolveComment(resolved.canonicalFile, id, { type: 'agent' })) }))
            );
            const fails = results.filter((r) => !r.ok).map((r) => ({ id: r.id, error: `Comment not found: ${r.id}` }));
            resolvedCount += results.length - fails.length;
            if (fails.length > 0) {
              failed[file] = fails;
            }
          })
        );

        const payload: Record<string, unknown> = { resolved: resolvedCount };
        if (Object.keys(failed).length > 0) {
          payload.failed = failed;
        }
        return asResult(payload);
      }
    );
  }
}

function asResult(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function asError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}
