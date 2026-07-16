import * as http from 'http';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentCommentsMcpServer, AUTH_HEADER } from '../../src/mcp/server';
import { CommentStore } from '../../src/storage/store';
import { hashContent } from '../../src/anchoring/hash';
import { createTextDocument } from '../__mocks__/vscode';
import { archiveFileUri } from '../../src/storage/paths';

const mockVscode = vscode as unknown as { __reset(): void; __setConfig(key: string, value: unknown): void };
const storageUri = vscode.Uri.file('/storage');
const repoUri = vscode.Uri.file('/repo');

async function writeSourceFile(relativePath: string, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(repoUri, relativePath), Buffer.from(content, 'utf8'));
}

async function setupServer() {
  vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
  const store = new CommentStore(storageUri);
  await store.initialize();
  const server = new AgentCommentsMcpServer(store);
  const port = await server.start();
  return { store, server, port };
}

const activeClients: Client[] = [];

async function connectClient(server: AgentCommentsMcpServer, port: number, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { [AUTH_HEADER]: server.token, ...headers } },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  activeClients.push(client);
  return client;
}

function textOf(result: any): any {
  return JSON.parse(result.content[0].text);
}

function rawRequest(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

let activeServer: AgentCommentsMcpServer | undefined;

afterEach(async () => {
  await Promise.all(activeClients.splice(0).map((c) => c.close()));
  activeServer?.dispose();
  activeServer = undefined;
  mockVscode.__reset();
});

describe('server lifecycle and raw HTTP auth', () => {
  it('starts on an ephemeral localhost port and exposes a token', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    expect(port).toBeGreaterThan(0);
    expect(server.port).toBe(port);
    expect(server.token).toHaveLength(48);
  });

  it('returns 404 for paths outside /mcp', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    const res = await rawRequest(port, '/other');
    expect(res.status).toBe(404);
  });

  it('returns 401 when the auth header is missing or wrong', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    const missing = await rawRequest(port, '/mcp');
    expect(missing.status).toBe(401);
    const wrong = await rawRequest(port, '/mcp', { [AUTH_HEADER]: 'nope' });
    expect(wrong.status).toBe(401);
  });

  it('tolerates dispose() being called before start-related resources exist elsewhere', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const server = new AgentCommentsMcpServer(store);
    expect(() => server.dispose()).not.toThrow();
  });
});

describe('list_unresolved_comments', () => {
  it('lists unresolved comments across the whole workspace, grouped by file', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hello', { type: 'user' });

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: {} });
    const payload = textOf(result);
    expect(payload.files['a.ts'].comments).toHaveLength(1);
    expect(payload.files['a.ts'].comments[0]).toMatchObject({ line: 1, text: 'hello', author: 'user' });
    expect(payload.files['a.ts'].fileStatus).toBeUndefined();
  });

  it('scopes to a single resolvable file and marks non-exact anchors as locationUncertain', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 5, endLineHint: 6, contentHash: 'no-match-anywhere', contextBefore: 'zz', contextAfter: 'zz', status: 'approximate' }, 'hi', { type: 'agent' });

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: { file: 'a.ts' } });
    const payload = textOf(result);
    expect(payload.files['a.ts'].comments[0].locationUncertain).toBe(true);
    expect(payload.files['a.ts'].comments[0].endLine).toBe(6);
  });

  it('includes originalContent on every comment by default, exact anchors included', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment(
      'a.ts',
      { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', originalContent: 'two', status: 'exact' },
      'hello',
      { type: 'user' }
    );

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: { file: 'a.ts' } });
    const payload = textOf(result);
    expect(payload.files['a.ts'].comments[0].locationUncertain).toBeUndefined();
    expect(payload.files['a.ts'].comments[0].originalContent).toBe('two');
  });

  it('omits originalContent on exact anchors when alwaysIncludeSnippet is disabled', async () => {
    mockVscode.__setConfig('agenticComments.mcp.alwaysIncludeSnippet', false);
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment(
      'a.ts',
      { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', originalContent: 'two', status: 'exact' },
      'exact-one',
      { type: 'user' }
    );
    await store.addComment(
      'a.ts',
      { lineHint: 5, endLineHint: 5, contentHash: 'no-match', contextBefore: 'zz', contextAfter: 'zz', originalContent: 'gone', status: 'approximate' },
      'uncertain-one',
      { type: 'user' }
    );

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: { file: 'a.ts' } });
    const payload = textOf(result);
    const exactEntry = payload.files['a.ts'].comments.find((c: any) => c.text === 'exact-one');
    const uncertainEntry = payload.files['a.ts'].comments.find((c: any) => c.text === 'uncertain-one');
    expect('originalContent' in exactEntry).toBe(false);
    expect(uncertainEntry.originalContent).toBe('gone');
  });

  it('truncates originalContent to the configured snippetMaxChars', async () => {
    mockVscode.__setConfig('agenticComments.mcp.snippetMaxChars', 4);
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment(
      'a.ts',
      { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', originalContent: 'abcdefgh', status: 'exact' },
      'hello',
      { type: 'user' }
    );

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: { file: 'a.ts' } });
    const payload = textOf(result);
    expect(payload.files['a.ts'].comments[0].originalContent).toMatch(/^abcd\n… \(truncated, 4 more chars\)$/);
  });

  it('omits originalContent entirely when snippetMaxChars is 0', async () => {
    mockVscode.__setConfig('agenticComments.mcp.snippetMaxChars', 0);
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment(
      'a.ts',
      { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', originalContent: 'two', status: 'exact' },
      'hello',
      { type: 'user' }
    );

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: { file: 'a.ts' } });
    const payload = textOf(result);
    expect('originalContent' in payload.files['a.ts'].comments[0]).toBe(false);
  });

  it('surfaces fileStatus for a file whose comments exist but whose source file is missing', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    // Never write repo/a.ts to disk — the store will mark it file-not-found.
    await store.addComment('missing.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hi', { type: 'user' });

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: {} });
    const payload = textOf(result);
    expect(payload.files['missing.ts'].fileStatus).toBe('file-not-found');
  });

  it('returns an error result for an unresolvable file path', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    const client = await connectClient(server, port);
    vscode.workspace.workspaceFolders = undefined;
    const result = await client.callTool({ name: 'list_unresolved_comments', arguments: { file: 'nope.ts' } });
    expect(result.isError).toBe(true);
  });
});

describe('get_comments', () => {
  it('gets comments for multiple files, resolving fileStatus via the first comment when present', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'c1', { type: 'user' });

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'get_comments', arguments: { files: ['a.ts'] } });
    const payload = textOf(result);
    expect(payload.files['a.ts'].comments).toHaveLength(1);
  });

  it('falls back to loadFile for fileStatus when a resolvable file has zero comments', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('empty.ts', 'one');

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'get_comments', arguments: { files: ['empty.ts'] } });
    const payload = textOf(result);
    expect(payload.files['empty.ts'].comments).toHaveLength(0);
    expect(payload.files['empty.ts'].fileStatus).toBeUndefined();
  });

  it('surfaces fileStatus via loadFile when a resolvable file has zero comments and is missing on disk', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    // Resolvable (workspace folder is open) but never written to the mock fs.
    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'get_comments', arguments: { files: ['ghost.ts'] } });
    const payload = textOf(result);
    expect(payload.files['ghost.ts'].comments).toHaveLength(0);
    expect(payload.files['ghost.ts'].fileStatus).toBe('file-not-found');
  });

  it('reports a per-file error for an unresolvable path without failing the whole call', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    vscode.workspace.workspaceFolders = undefined;
    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'get_comments', arguments: { files: ['nope.ts'] } });
    const payload = textOf(result);
    expect(payload.files['nope.ts'].error).toContain('nope.ts');
  });

  it('omits resolvedBy when an archived comment defensively has none', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one');
    await vscode.workspace.fs.writeFile(
      archiveFileUri(storageUri, 'a.ts'),
      Buffer.from(
        JSON.stringify({
          id: 'c1',
          anchor: { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
          author: { type: 'user' },
          text: 'hi',
          status: 'resolved',
          resolvedBy: null,
          createdAt: '',
          updatedAt: '',
          filePath: 'a.ts',
          archivedAt: '',
        }) + '\n',
        'utf8'
      )
    );

    const client = await connectClient(server, port);
    const result = await client.callTool({ name: 'get_comments', arguments: { files: ['a.ts'], includeResolved: true } });
    const payload = textOf(result);
    expect(payload.files['a.ts'].comments[0]).toMatchObject({ status: 'resolved' });
    expect(payload.files['a.ts'].comments[0].resolvedBy).toBeUndefined();
  });

  it('defaults includeResolved to false when a raw tool call omits it entirely (bypassing the MCP schema default)', async () => {
    const registerToolSpy = jest.spyOn(McpServer.prototype, 'registerTool');
    const { store, server } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hi', { type: 'user' });
    await store.resolveComment('a.ts', created.id, { type: 'user' });

    const call = registerToolSpy.mock.calls.find(([name]) => name === 'get_comments');
    const handler = call![2] as (args: { files: string[]; includeResolved: boolean | undefined }) => Promise<any>;
    const raw = await handler({ files: ['a.ts'], includeResolved: undefined });
    const payload = JSON.parse(raw.content[0].text);
    expect(payload.files['a.ts'].comments).toHaveLength(0);
  });

  it('includes resolved comments (with resolvedBy) only when includeResolved is true', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'c1', { type: 'user' });
    await store.resolveComment('a.ts', created.id, { type: 'agent' });

    const client = await connectClient(server, port);
    const withoutResolved = textOf(await client.callTool({ name: 'get_comments', arguments: { files: ['a.ts'] } }));
    expect(withoutResolved.files['a.ts'].comments).toHaveLength(0);

    const withResolved = textOf(await client.callTool({ name: 'get_comments', arguments: { files: ['a.ts'], includeResolved: true } }));
    expect(withResolved.files['a.ts'].comments[0]).toMatchObject({ status: 'resolved', resolvedBy: 'agent' });
  });
});

describe('add_comments', () => {
  it('creates single-line and range comments in one call, stamped as agent-authored', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one\ntwo\nthree\nfour');

    const client = await connectClient(server, port);
    const result = await client.callTool({
      name: 'add_comments',
      arguments: { files: { 'a.ts': [{ line: 1, text: 'single' }, { line: 2, endLine: 3, text: 'range' }] } },
    });
    const payload = textOf(result);
    expect(payload.files['a.ts'].created).toEqual([
      { line: 1, id: expect.any(String) },
      { line: 2, endLine: 3, id: expect.any(String) },
    ]);

    const stored = await store.getComments('a.ts', false);
    expect(stored.every((c) => c.author.type === 'agent')).toBe(true);
  });

  it('reports an error for an unresolvable file without touching other files in the same call', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('ok.ts', 'one');
    const client = await connectClient(server, port);
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];

    const result = await client.callTool({
      name: 'add_comments',
      arguments: { files: { 'ok.ts': [{ line: 1, text: 'fine' }] } },
    });
    const payload = textOf(result);
    expect(payload.files['ok.ts'].created).toHaveLength(1);
  });

  it('reports an error when the file path cannot be resolved to any workspace folder', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    const client = await connectClient(server, port);
    vscode.workspace.workspaceFolders = undefined;
    const result = await client.callTool({
      name: 'add_comments',
      arguments: { files: { 'nope.ts': [{ line: 1, text: 'x' }] } },
    });
    const payload = textOf(result);
    expect(payload.files['nope.ts'].error).toContain('No workspace folder open');
  });

  it('reports a file-not-found error when the target file does not exist on disk or in an open buffer', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    const client = await connectClient(server, port);
    const result = await client.callTool({
      name: 'add_comments',
      arguments: { files: { 'ghost.ts': [{ line: 1, text: 'x' }] } },
    });
    const payload = textOf(result);
    expect(payload.files['ghost.ts'].error).toContain('ghost.ts');
  });

  it('reads from an open in-memory buffer instead of disk when both exist', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('buf.ts', 'diskline1\ndiskline2');
    const uri = vscode.Uri.joinPath(repoUri, 'buf.ts');
    const bufferContent = 'bufferline1\nbufferline2\nbufferline3';
    vscode.workspace.textDocuments.push(createTextDocument(uri, bufferContent) as any);

    const client = await connectClient(server, port);
    await client.callTool({ name: 'add_comments', arguments: { files: { 'buf.ts': [{ line: 3, text: 'from buffer' }] } } });

    const stored = await store.getComments('buf.ts', false);
    expect(stored[0].anchorStatus).toBe('exact');
    // anchor was built from the *third* buffer line, which only exists in the open buffer, not on disk
    const rawComments = (await store.loadFile('buf.ts')).comments;
    expect(rawComments[0].anchor.contentHash).toBe(hashContent('bufferline3'));
  });
});

describe('resolve_comments', () => {
  it('resolves several comments across files and reports the total resolved count', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one');
    await writeSourceFile('b.ts', 'one');
    const a1 = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'a1', { type: 'user' });
    const b1 = await store.addComment('b.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'b1', { type: 'user' });

    const client = await connectClient(server, port);
    const result = await client.callTool({
      name: 'resolve_comments',
      arguments: { files: { 'a.ts': [a1.id], 'b.ts': [b1.id] } },
    });
    const payload = textOf(result);
    expect(payload.resolved).toBe(2);
    expect(payload.failed).toBeUndefined();
  });

  it('reports per-id failures for unknown comment ids without failing resolvable ones in the same file', async () => {
    const { store, server, port } = await setupServer();
    activeServer = server;
    await writeSourceFile('a.ts', 'one');
    const a1 = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'a1', { type: 'user' });

    const client = await connectClient(server, port);
    const result = await client.callTool({
      name: 'resolve_comments',
      arguments: { files: { 'a.ts': [a1.id, 'bogus-id'] } },
    });
    const payload = textOf(result);
    expect(payload.resolved).toBe(1);
    expect(payload.failed['a.ts']).toEqual([{ id: 'bogus-id', error: 'Comment not found: bogus-id' }]);
  });

  it('reports a whole-file failure for every id when the file path cannot be resolved', async () => {
    const { server, port } = await setupServer();
    activeServer = server;
    const client = await connectClient(server, port);
    vscode.workspace.workspaceFolders = undefined;
    const result = await client.callTool({
      name: 'resolve_comments',
      arguments: { files: { 'nope.ts': ['id1', 'id2'] } },
    });
    const payload = textOf(result);
    expect(payload.resolved).toBe(0);
    expect(payload.failed['nope.ts']).toHaveLength(2);
  });
});
