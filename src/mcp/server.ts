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

const commentViewShape = {
  id: z.string(),
  file: z.string(),
  fileStatus: z.enum(['ok', 'file-not-found']),
  line: z.number(),
  endLine: z.number().optional(),
  anchorStatus: z.enum(['exact', 'approximate', 'orphaned']),
  author: z.object({ type: z.enum(['user', 'agent']) }),
  text: z.string(),
  createdAt: z.string(),
  status: z.enum(['unresolved', 'resolved']).optional(),
  resolvedBy: z.object({ type: z.enum(['user', 'agent']) }).nullable().optional(),
};

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
          'Lists unresolved review comments left by the developer or other agents, anchored to exact code locations. Omit "file" to list across the whole workspace.',
        inputSchema: {
          file: z.string().optional().describe('Workspace-relative file path. Omit for the whole workspace.'),
        },
        outputSchema: { comments: z.array(z.object(commentViewShape)) },
      },
      async ({ file }) => {
        const comments = await this.store.listUnresolved(file);
        return asResult({ comments });
      }
    );

    server.registerTool(
      'get_comments',
      {
        title: 'Get comments for a file',
        description:
          'Gets all comments for a specific file, optionally including resolved ones (read from the archive).',
        inputSchema: {
          file: z.string().describe('Workspace-relative file path.'),
          includeResolved: z.boolean().optional().default(false),
        },
        outputSchema: { comments: z.array(z.object(commentViewShape)) },
      },
      async ({ file, includeResolved }) => {
        const comments = await this.store.getComments(file, includeResolved ?? false);
        return asResult({ comments });
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
        outputSchema: { id: z.string(), status: z.literal('created') },
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
        outputSchema: {
          id: z.string(),
          status: z.literal('resolved'),
          resolvedBy: z.object({ type: z.literal('agent') }),
        },
      },
      async ({ file, id }) => {
        const comment = await this.store.resolveComment(file, id, { type: 'agent' });
        if (!comment) {
          return asError(`Comment not found: ${id}`);
        }
        return asResult({ id: comment.id, status: 'resolved' as const, resolvedBy: { type: 'agent' as const } });
      }
    );
  }
}

function asResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function asError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}
