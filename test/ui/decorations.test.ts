import * as vscode from 'vscode';
import { AgentCommentsDecorationProvider } from '../../src/ui/decorations';
import { FileIndexEntry } from '../../src/types';

const mockVscode = vscode as unknown as { __reset(): void };
const repoUri = vscode.Uri.file('/repo');

function makeFakeStore() {
  const emitter = new vscode.EventEmitter<{ filePath: string }>();
  let index = new Map<string, FileIndexEntry>();
  return {
    onDidChangeFile: emitter.event,
    fire: (e: { filePath: string }) => emitter.fire(e),
    getIndexSnapshot: () => index,
    setIndex: (m: Map<string, FileIndexEntry>) => {
      index = m;
    },
  };
}

afterEach(() => {
  mockVscode.__reset();
});

describe('AgentCommentsDecorationProvider construction wiring', () => {
  it('fires an undefined (repaint-everything) event when the store reports a global clear', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const store = makeFakeStore();
    const provider = new AgentCommentsDecorationProvider(store as any);
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    store.fire({ filePath: '*' });
    expect(fired).toEqual([undefined]);
  });

  it('fires the resolved uri when a specific file changes and can be resolved', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const store = makeFakeStore();
    const provider = new AgentCommentsDecorationProvider(store as any);
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    store.fire({ filePath: 'src/a.ts' });
    expect(fired).toHaveLength(1);
    expect((fired[0] as vscode.Uri).toString()).toBe('file:///repo/src/a.ts');
  });

  it('does not fire when the changed file path cannot be resolved (no workspace open)', () => {
    vscode.workspace.workspaceFolders = undefined;
    const store = makeFakeStore();
    const provider = new AgentCommentsDecorationProvider(store as any);
    const fired: unknown[] = [];
    provider.onDidChangeFileDecorations((e) => fired.push(e));

    store.fire({ filePath: 'src/a.ts' });
    expect(fired).toHaveLength(0);
  });
});

describe('provideFileDecoration', () => {
  function providerWithIndex(entries: Record<string, FileIndexEntry>) {
    const store = makeFakeStore();
    store.setIndex(new Map(Object.entries(entries)));
    return new AgentCommentsDecorationProvider(store as any);
  }

  it('returns undefined for non-file-scheme uris', () => {
    const provider = providerWithIndex({});
    const uri = vscode.Uri.parse('untitled://ignored/Untitled-1');
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it('returns undefined when the file has no index entry', () => {
    const provider = providerWithIndex({});
    expect(provider.provideFileDecoration(vscode.Uri.file('/repo/a.ts'))).toBeUndefined();
  });

  it('returns undefined when the entry has zero unresolved comments', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const provider = providerWithIndex({ 'a.ts': { unresolvedCount: 0, lastModified: '', fileStatus: 'ok' } });
    expect(provider.provideFileDecoration(vscode.Uri.file('/repo/a.ts'))).toBeUndefined();
  });

  it('renders a warning badge when the underlying file is missing', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const provider = providerWithIndex({ 'a.ts': { unresolvedCount: 3, lastModified: '', fileStatus: 'file-not-found' } });
    const decoration = provider.provideFileDecoration(vscode.Uri.file('/repo/a.ts'));
    expect(decoration?.badge).toBe('!');
    expect(decoration?.tooltip).toContain('file missing');
  });

  it('renders the exact unresolved count for small counts', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const provider = providerWithIndex({ 'a.ts': { unresolvedCount: 3, lastModified: '', fileStatus: 'ok' } });
    const decoration = provider.provideFileDecoration(vscode.Uri.file('/repo/a.ts'));
    expect(decoration?.badge).toBe('3');
    expect(decoration?.tooltip).toBe('3 unresolved comments');
  });

  it('uses singular wording for exactly one unresolved comment', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const provider = providerWithIndex({ 'a.ts': { unresolvedCount: 1, lastModified: '', fileStatus: 'ok' } });
    const decoration = provider.provideFileDecoration(vscode.Uri.file('/repo/a.ts'));
    expect(decoration?.tooltip).toBe('1 unresolved comment');
  });

  it('caps the badge at "9+" for large counts', () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const provider = providerWithIndex({ 'a.ts': { unresolvedCount: 42, lastModified: '', fileStatus: 'ok' } });
    const decoration = provider.provideFileDecoration(vscode.Uri.file('/repo/a.ts'));
    expect(decoration?.badge).toBe('9+');
  });
});
