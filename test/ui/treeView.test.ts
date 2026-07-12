import * as vscode from 'vscode';
import { AgentCommentsTreeProvider, CommentNode } from '../../src/ui/treeView';
import { FileCommentData, FileIndexEntry, ToolCommentView } from '../../src/types';

const mockVscode = vscode as unknown as { __reset(): void };

function makeFakeStore() {
  const emitter = new vscode.EventEmitter<void>();
  return {
    onDidChangeFile: emitter.event,
    fire: () => emitter.fire(),
    getIndexSnapshot: jest.fn<Map<string, FileIndexEntry>, []>(() => new Map()),
    listArchivedFilePaths: jest.fn<Promise<Map<string, number>>, []>(async () => new Map()),
    loadFile: jest.fn<Promise<FileCommentData>, [string]>(async (filePath: string) => ({
      filePath,
      fileStatus: 'ok',
      comments: [],
    })),
    getComments: jest.fn<Promise<ToolCommentView[]>, [string, boolean]>(async () => []),
    listUnresolved: jest.fn<Promise<ToolCommentView[]>, [string?]>(async () => []),
  };
}

function comment(overrides: Partial<ToolCommentView> = {}): ToolCommentView {
  return {
    id: 'c1',
    file: 'a.ts',
    fileStatus: 'ok',
    line: 5,
    anchorStatus: 'exact',
    author: { type: 'user' },
    text: 'hello',
    createdAt: '2020-01-01T00:00:00.000Z',
    status: 'unresolved',
    resolvedBy: null,
    ...overrides,
  };
}

afterEach(() => {
  mockVscode.__reset();
  jest.restoreAllMocks();
});

describe('construction', () => {
  it('initializes the showResolved context key to false and refreshes on store changes', () => {
    const store = makeFakeStore();
    const provider = new AgentCommentsTreeProvider(store as any);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'agentComments.showResolved', false);

    const refreshed = jest.fn();
    provider.onDidChangeTreeData(refreshed);
    store.fire();
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

describe('setShowResolved', () => {
  it('updates the context key and refreshes the tree', () => {
    const store = makeFakeStore();
    const provider = new AgentCommentsTreeProvider(store as any);
    const refreshed = jest.fn();
    provider.onDidChangeTreeData(refreshed);

    provider.setShowResolved(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'agentComments.showResolved', true);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

describe('getTreeItem — file nodes', () => {
  it('renders an ok file node with a file icon', () => {
    const provider = new AgentCommentsTreeProvider(makeFakeStore() as any);
    const item = provider.getTreeItem({ kind: 'file', filePath: 'a.ts', unresolvedCount: 2, fileStatus: 'ok' });
    expect(item.label).toBe('a.ts');
    expect(item.description).toBe('2 unresolved');
    expect(item.contextValue).toBe('agentCommentsFile');
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('file');
  });

  it('renders a file-not-found node with a warning icon and tooltip', () => {
    const provider = new AgentCommentsTreeProvider(makeFakeStore() as any);
    const item = provider.getTreeItem({ kind: 'file', filePath: 'missing.ts', unresolvedCount: 0, fileStatus: 'file-not-found' });
    expect(item.contextValue).toBe('agentCommentsFileMissing');
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('warning');
    expect(item.tooltip).toContain('not auto-relocated');
  });
});

describe('getTreeItem — comment nodes', () => {
  const provider = new AgentCommentsTreeProvider(makeFakeStore() as any);

  it('shows a single-line label when there is no endLine', () => {
    const item = provider.getTreeItem({ kind: 'comment', comment: comment({ line: 5, endLine: undefined }) });
    expect(item.description).toContain('L5');
    expect(item.description).not.toContain('-');
  });

  it('shows a range label when endLine is present', () => {
    const item = provider.getTreeItem({ kind: 'comment', comment: comment({ line: 5, endLine: 8 }) });
    expect(item.description).toContain('L5-8');
  });

  it('appends "resolved by <type>" for resolved comments with a known resolver', () => {
    const item = provider.getTreeItem({
      kind: 'comment',
      comment: comment({ status: 'resolved', resolvedBy: { type: 'agent' } }),
    });
    expect(item.description).toContain('resolved by agent');
    expect(item.contextValue).toBe('agentCommentsCommentResolved');
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('check');
  });

  it('falls back to "unknown" resolver when resolvedBy is missing on a resolved comment', () => {
    const item = provider.getTreeItem({
      kind: 'comment',
      comment: comment({ status: 'resolved', resolvedBy: null }),
    });
    expect(item.description).toContain('resolved by unknown');
  });

  it('uses a warning icon for orphaned, unresolved comments', () => {
    const item = provider.getTreeItem({
      kind: 'comment',
      comment: comment({ status: 'unresolved', anchorStatus: 'orphaned' }),
    });
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('warning');
    expect(item.contextValue).toBe('agentCommentsCommentUnresolved');
  });

  it('uses an account icon for an unresolved, non-orphaned user comment', () => {
    const item = provider.getTreeItem({
      kind: 'comment',
      comment: comment({ status: 'unresolved', anchorStatus: 'exact', author: { type: 'user' } }),
    });
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('account');
    expect((item.tooltip as vscode.MarkdownString).value).toContain('You');
  });

  it('uses a hubot icon for an unresolved, non-orphaned agent comment', () => {
    const item = provider.getTreeItem({
      kind: 'comment',
      comment: comment({ status: 'unresolved', anchorStatus: 'approximate', author: { type: 'agent' } }),
    });
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('hubot');
    expect((item.tooltip as vscode.MarkdownString).value).toContain('Agent');
  });

  it('attaches a reveal command only when the file still exists', () => {
    const okItem = provider.getTreeItem({ kind: 'comment', comment: comment({ fileStatus: 'ok' }) });
    expect(okItem.command).toBeDefined();

    const missingItem = provider.getTreeItem({ kind: 'comment', comment: comment({ fileStatus: 'file-not-found' }) });
    expect(missingItem.command).toBeUndefined();
  });

  it('truncates long comment text in the label', () => {
    const longText = 'x'.repeat(120);
    const item = provider.getTreeItem({ kind: 'comment', comment: comment({ text: longText }) });
    expect((item.label as string).length).toBe(80);
    expect(item.label).toMatch(/\.\.\.$/);
  });

  it('collapses internal whitespace/newlines when truncation is not needed', () => {
    const item = provider.getTreeItem({ kind: 'comment', comment: comment({ text: 'line one\n  line two' }) });
    expect(item.label).toBe('line one line two');
  });
});

describe('getChildren — root level', () => {
  it('returns index-backed file nodes sorted by path when showResolved is false', async () => {
    const store = makeFakeStore();
    store.getIndexSnapshot.mockReturnValue(
      new Map([
        ['b.ts', { unresolvedCount: 1, lastModified: '', fileStatus: 'ok' as const }],
        ['a.ts', { unresolvedCount: 2, lastModified: '', fileStatus: 'ok' as const }],
      ])
    );
    const provider = new AgentCommentsTreeProvider(store as any);
    const children = await provider.getChildren();
    expect(children.map((c: any) => c.filePath)).toEqual(['a.ts', 'b.ts']);
    expect(store.listArchivedFilePaths).not.toHaveBeenCalled();
  });

  it('merges in archived-only files when showResolved is true, skipping files already in the index', async () => {
    const store = makeFakeStore();
    store.getIndexSnapshot.mockReturnValue(new Map([['a.ts', { unresolvedCount: 1, lastModified: '', fileStatus: 'ok' as const }]]));
    store.listArchivedFilePaths.mockResolvedValue(
      new Map([
        ['a.ts', 1], // already in the index — must not trigger a redundant loadFile
        ['c.ts', 2], // archived-only — must be loaded and merged in
      ])
    );
    store.loadFile.mockResolvedValue({ filePath: 'c.ts', fileStatus: 'ok', comments: [] });

    const provider = new AgentCommentsTreeProvider(store as any);
    provider.setShowResolved(true);
    const children = await provider.getChildren();

    expect(store.loadFile).toHaveBeenCalledTimes(1);
    expect(store.loadFile).toHaveBeenCalledWith('c.ts');
    expect(children.map((c: any) => c.filePath)).toEqual(['a.ts', 'c.ts']);
    expect((children.find((c: any) => c.filePath === 'c.ts') as any).unresolvedCount).toBe(0);
  });
});

describe('getChildren — file node children', () => {
  it('fetches only unresolved comments when showResolved is false, sorted by line', async () => {
    const store = makeFakeStore();
    store.listUnresolved.mockResolvedValue([comment({ id: 'b', line: 9 }), comment({ id: 'a', line: 1 })]);
    const provider = new AgentCommentsTreeProvider(store as any);

    const children = (await provider.getChildren({ kind: 'file', filePath: 'a.ts', unresolvedCount: 2, fileStatus: 'ok' })) as CommentNode[];
    expect(store.listUnresolved).toHaveBeenCalledWith('a.ts');
    expect(children.map((c) => c.comment.id)).toEqual(['a', 'b']);
  });

  it('fetches all comments (including resolved) when showResolved is true', async () => {
    const store = makeFakeStore();
    store.getComments.mockResolvedValue([comment({ id: 'x', line: 3 })]);
    const provider = new AgentCommentsTreeProvider(store as any);
    provider.setShowResolved(true);

    const children = (await provider.getChildren({ kind: 'file', filePath: 'a.ts', unresolvedCount: 0, fileStatus: 'ok' })) as CommentNode[];
    expect(store.getComments).toHaveBeenCalledWith('a.ts', true);
    expect(children.map((c) => c.comment.id)).toEqual(['x']);
  });
});

describe('getChildren — comment node has no children', () => {
  it('returns an empty array for a comment element', async () => {
    const provider = new AgentCommentsTreeProvider(makeFakeStore() as any);
    const children = await provider.getChildren({ kind: 'comment', comment: comment() });
    expect(children).toEqual([]);
  });
});
