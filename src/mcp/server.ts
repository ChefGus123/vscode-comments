import * as http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { CommentStore } from '../storage/store';
import { resolveWorkspaceRelativePath } from '../storage/paths';
import { createAnchorFromContent } from '../anchoring/anchor';
import { ToolCommentView } from '../types';

/**
 * Lean wire format for tool responses — every field costs tokens on every call, so fields that are
 * almost always the same value (fileStatus "ok", anchor "exact", status "unresolved") are omitted
 * rather than spelled out, and author/resolvedBy are flattened from {type: "x"} to plain "x".
 */
interface McpCommentView {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  text: string;
  author: 'user' | 'agent';
  fileStatus?: 'file-not-found';
  locationUncertain?: true;
  status?: 'resolved';
  resolvedBy?: 'user' | 'agent';
}

function toMcpView(c: ToolCommentView): McpCommentView {
  const view: McpCommentView = {
    id: c.id,
    file: c.file,
    line: c.line,
    text: c.text,
    author: c.author.type,
  };
  if (c.endLine !== undefined) {
    view.endLine = c.endLine;
  }
  if (c.fileStatus !== 'ok') {
    view.fileStatus = c.fileStatus;
  }
  if (c.anchorStatus !== 'exact') {
    view.locationUncertain = true;
  }
  if (c.status === 'resolved') {
    view.status = 'resolved';
    if (c.resolvedBy) {
      view.resolvedBy = c.resolvedBy.type;
    }
  }
  return view;
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

export class AgentCommentsMcpServer implements vscode.Disposable {
  private httpServer: http.Server | undefined;
  private transport: StreamableHTTPServerTransport | undefined;
  private mcpServer: McpServer | undefined;
  private _port: number | undefined;

  constructor(private readonly store: CommentStore) {}

  get port(): number | undefined {
    return this._port;
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
          'Lists unresolved review comments left by the developer or other agents, anchored to exact code locations. Omit "file" to list across the whole workspace. ' +
          'Fields are omitted when not notable: "fileStatus" only appears as "file-not-found" (the commented file is missing — comment kept, not auto-relocated); ' +
          '"locationUncertain: true" means the code around the comment changed and the line number may be off — check nearby lines or the comment text itself before trusting it.',
        inputSchema: {
          file: z.string().optional().describe('Workspace-relative file path. Omit for the whole workspace.'),
        },
      },
      async ({ file }) => {
        const comments = await this.store.listUnresolved(file);
        return asResult({ comments: comments.map(toMcpView) });
      }
    );

    server.registerTool(
      'get_comments',
      {
        title: 'Get comments for a file',
        description:
          'Gets all comments for a specific file, optionally including resolved ones (read from the archive). ' +
          'A "status": "resolved" field appears only on resolved entries (everything else is unresolved); "resolvedBy" ("user" or "agent") comes with it.',
        inputSchema: {
          file: z.string().describe('Workspace-relative file path.'),
          includeResolved: z.boolean().optional().default(false),
        },
      },
      async ({ file, includeResolved }) => {
        const comments = await this.store.getComments(file, includeResolved ?? false);
        return asResult({ comments: comments.map(toMcpView) });
      }
    );

    server.registerTool(
      'add_comment',
      {
        title: 'Add a comment',
        description:
          'Leaves a new review comment anchored to a line or range in a file, visible to the developer and other agents. Always stamped as author type "agent".',
        inputSchema: {
          file: z.string().describe('Workspace-relative file path.'),
          line: z.number().int().min(1).describe('1-indexed start line.'),
          endLine: z.number().int().min(1).optional().describe('1-indexed end line, for range comments.'),
          text: z.string().min(1),
        },
      },
      async ({ file, line, endLine, text }) => {
        const uri = resolveWorkspaceRelativePath(file);
        if (!uri) {
          return asError(`No workspace folder open to resolve "${file}".`);
        }
        let content: string;
        try {
          content = await readFileText(uri);
        } catch {
          return asError(`File not found: ${file}`);
        }
        const startLine0 = line - 1;
        const endLine0 = (endLine ?? line) - 1;
        const anchor = createAnchorFromContent(content, startLine0, Math.max(startLine0, endLine0));
        const comment = await this.store.addComment(file, anchor, text, { type: 'agent' });
        return asResult({ id: comment.id, status: 'created' as const });
      }
    );

    server.registerTool(
      'resolve_comment',
      {
        title: 'Resolve a comment',
        description: 'Marks a comment as resolved. Always stamped as resolved by author type "agent".',
        inputSchema: {
          file: z.string().describe('Workspace-relative file path.'),
          id: z.string(),
        },
      },
      async ({ file, id }) => {
        const comment = await this.store.resolveComment(file, id, { type: 'agent' });
        if (!comment) {
          return asError(`Comment not found: ${id}`);
        }
        return asResult({ id: comment.id, status: 'resolved' as const, resolvedBy: 'agent' as const });
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
