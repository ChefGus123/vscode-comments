import * as vscode from 'vscode';
import { CommentStore } from '../../src/storage/store';
import { archiveDirUri, archiveFileUri, commentsDirUri, commentsFileUri } from '../../src/storage/paths';
import { Anchor, Author } from '../../src/types';

const mockVscode = vscode as unknown as { __reset(): void };
const storageUri = vscode.Uri.file('/storage');
const repoUri = vscode.Uri.file('/repo');

const author: Author = { type: 'user' };
const agent: Author = { type: 'agent' };

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    lineHint: 1,
    endLineHint: 1,
    contentHash: 'hash',
    contextBefore: '',
    contextAfter: '',
    status: 'exact',
    ...overrides,
  };
}

async function markSourceFileExists(relativePath: string): Promise<void> {
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(repoUri, relativePath), Buffer.from('source', 'utf8'));
}

beforeEach(() => {
  vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
});

afterEach(() => {
  mockVscode.__reset();
  jest.restoreAllMocks();
});

describe('initialize', () => {
  it('starts with an empty index when the storage directory is fresh', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    expect(store.getIndexSnapshot().size).toBe(0);
  });

  it('rebuilds the index from comment files already on disk', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const reloaded = new CommentStore(storageUri);
    await reloaded.initialize();
    const entry = reloaded.getIndexSnapshot().get('a.ts');
    expect(entry?.unresolvedCount).toBe(1);
    expect(entry?.fileStatus).toBe('ok');
  });

  it('computes lastModified as the max updatedAt across several comments in one file', async () => {
    await vscode.workspace.fs.createDirectory(commentsDirUri(storageUri));
    const data = {
      filePath: 'a.ts',
      fileStatus: 'ok',
      comments: [
        { id: 'c1', anchor: makeAnchor(), author, text: 'first', status: 'unresolved', resolvedBy: null, createdAt: '2020-01-02T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' },
        { id: 'c2', anchor: makeAnchor(), author, text: 'second', status: 'unresolved', resolvedBy: null, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
      ],
    };
    await vscode.workspace.fs.writeFile(commentsFileUri(storageUri, 'a.ts'), Buffer.from(JSON.stringify(data), 'utf8'));

    const store = new CommentStore(storageUri);
    await store.initialize();
    expect(store.getIndexSnapshot().get('a.ts')?.lastModified).toBe('2020-01-02T00:00:00.000Z');
  });

  it('ignores non-.json files and subdirectories inside comments/', async () => {
    await vscode.workspace.fs.createDirectory(commentsDirUri(storageUri));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(commentsDirUri(storageUri), 'notes.txt'),
      Buffer.from('irrelevant', 'utf8')
    );
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(commentsDirUri(storageUri), 'subdir'));

    const store = new CommentStore(storageUri);
    await store.initialize();
    expect(store.getIndexSnapshot().size).toBe(0);
  });

  it('tolerates a readDirectory failure while listing comments/ (fresh workspace state)', async () => {
    jest.spyOn(vscode.workspace.fs, 'readDirectory').mockRejectedValueOnce(new Error('boom'));
    const store = new CommentStore(storageUri);
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.getIndexSnapshot().size).toBe(0);
  });

  it('skips comment files that fail to parse as JSON', async () => {
    await vscode.workspace.fs.createDirectory(commentsDirUri(storageUri));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(commentsDirUri(storageUri), 'broken.json'),
      Buffer.from('{not valid json', 'utf8')
    );
    const store = new CommentStore(storageUri);
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.getIndexSnapshot().size).toBe(0);
  });
});

describe('addComment / loadFile / fileStatus', () => {
  it('creates a comment and marks the file ok when the source file exists', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');

    const comment = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    expect(comment.status).toBe('unresolved');
    expect(comment.resolvedBy).toBeNull();

    const data = await store.loadFile('a.ts');
    expect(data.fileStatus).toBe('ok');
    expect(data.comments).toHaveLength(1);
  });

  it('marks the file file-not-found when the source path cannot be resolved to an existing file', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    // no markSourceFileExists call: /repo/missing.ts is never written to the mock fs
    await store.addComment('missing.ts', makeAnchor(), 'hello', author);
    const data = await store.loadFile('missing.ts');
    expect(data.fileStatus).toBe('file-not-found');
  });

  it('marks the file file-not-found when no workspace folder is open to resolve it', async () => {
    vscode.workspace.workspaceFolders = undefined;
    const store = new CommentStore(storageUri);
    await store.initialize();
    await store.addComment('a.ts', makeAnchor(), 'hello', author);
    const data = await store.loadFile('a.ts');
    expect(data.fileStatus).toBe('file-not-found');
  });

  it('serves subsequent loads from cache without re-reading disk', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const readFileSpy = jest.spyOn(vscode.workspace.fs, 'readFile');
    readFileSpy.mockClear();
    const data = await store.loadFile('a.ts');
    expect(data.comments).toHaveLength(1);
    expect(readFileSpy).not.toHaveBeenCalledWith(commentsFileUri(storageUri, 'a.ts'));
  });

  it('warns when a file accumulates more than 200 unresolved comments', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('hot.ts');
    for (let i = 0; i < 201; i++) {
      await store.addComment('hot.ts', makeAnchor(), `comment ${i}`, author);
    }
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('hot.ts'));
  }, 20000);
});

describe('resolveComment', () => {
  it('moves a comment from live storage into the archive', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const resolved = await store.resolveComment('a.ts', created.id, agent);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolvedBy).toEqual(agent);

    const data = await store.loadFile('a.ts');
    expect(data.comments).toHaveLength(0);
    expect(store.getIndexSnapshot().has('a.ts')).toBe(false);

    const archived = await store.getComments('a.ts', true);
    expect(archived).toHaveLength(1);
    expect(archived[0].status).toBe('resolved');
  });

  it('returns undefined for an unknown comment id', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const result = await store.resolveComment('a.ts', 'nope', author);
    expect(result).toBeUndefined();
  });

  it('tolerates the comments-file delete failing when the last comment is resolved', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);

    jest.spyOn(vscode.workspace.fs, 'delete').mockRejectedValueOnce(new Error('locked'));
    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));

    const resolved = await store.resolveComment('a.ts', created.id, author);
    expect(resolved?.status).toBe('resolved');
    expect(events).toContain('resolve');
    expect(store.getIndexSnapshot().has('a.ts')).toBe(false);
  });
});

describe('updateCommentText', () => {
  it('updates the text and bumps updatedAt on a live unresolved comment', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const updated = await store.updateCommentText('a.ts', created.id, 'edited text');
    expect(updated?.text).toBe('edited text');
    expect(updated?.updatedAt >= created.updatedAt).toBe(true);

    const data = await store.loadFile('a.ts');
    expect(data.comments[0].text).toBe('edited text');
  });

  it('fires an edit-kind change event', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    await store.updateCommentText('a.ts', created.id, 'edited text');
    expect(events).toContain('edit');
  });

  it('returns undefined for an unknown comment id', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const result = await store.updateCommentText('a.ts', 'nope', 'edited text');
    expect(result).toBeUndefined();
  });

  it('returns undefined for a comment that only exists in the archive (resolved comments are not editable)', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const result = await store.updateCommentText('a.ts', created.id, 'edited text');
    expect(result).toBeUndefined();

    const archived = await store.getComments('a.ts', true);
    expect(archived[0].text).toBe('hello');
  });
});

describe('reopenComment', () => {
  it('returns undefined when there is no archive at all for the file', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const result = await store.reopenComment('a.ts', 'whatever');
    expect(result).toBeUndefined();
  });

  it('returns undefined when the id is not present in an existing archive', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const result = await store.reopenComment('a.ts', 'not-the-id');
    expect(result).toBeUndefined();
  });

  it('moves an archived comment back into live storage as unresolved', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, agent);

    const reopened = await store.reopenComment('a.ts', created.id);
    expect(reopened?.status).toBe('unresolved');
    expect(reopened?.resolvedBy).toBeNull();
    expect((reopened as any).archivedAt).toBeUndefined();
    expect((reopened as any).filePath).toBeUndefined();

    const data = await store.loadFile('a.ts');
    expect(data.comments).toHaveLength(1);
  });

  it('leaves remaining archived comments in place when reopening one of several', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const c1 = await store.addComment('a.ts', makeAnchor(), 'one', author);
    const c2 = await store.addComment('a.ts', makeAnchor(), 'two', author);
    await store.resolveComment('a.ts', c1.id, author);
    await store.resolveComment('a.ts', c2.id, author);

    await store.reopenComment('a.ts', c1.id);
    const stillArchived = await store.getComments('a.ts', true);
    const resolvedOnes = stillArchived.filter((c) => c.status === 'resolved');
    expect(resolvedOnes).toHaveLength(1);
    expect(resolvedOnes[0].id).toBe(c2.id);
  });
});

describe('deleteComment', () => {
  it('deletes a live unresolved comment', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const deleted = await store.deleteComment('a.ts', created.id);
    expect(deleted?.id).toBe(created.id);
    const data = await store.loadFile('a.ts');
    expect(data.comments).toHaveLength(0);
  });

  it('deletes an archived (resolved) comment', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    const deleted = await store.deleteComment('a.ts', created.id);
    expect(deleted?.id).toBe(created.id);
    expect(events).toContain('delete');

    const archived = await store.getComments('a.ts', true);
    expect(archived).toHaveLength(0);
  });

  it('returns undefined when the id exists in neither live nor archived storage', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);
    const result = await store.deleteComment('a.ts', 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('rewrites the remaining archive shard when one of several archived comments is deleted', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const c1 = await store.addComment('a.ts', makeAnchor(), 'one', author);
    const c2 = await store.addComment('a.ts', makeAnchor(), 'two', author);
    await store.resolveComment('a.ts', c1.id, author);
    await store.resolveComment('a.ts', c2.id, author);

    await store.deleteComment('a.ts', c1.id);
    const remaining = await store.getComments('a.ts', true);
    expect(remaining.map((c) => c.id)).toEqual([c2.id]);
  });

  it('returns undefined when there is no archive and the live list is empty', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const result = await store.deleteComment('never-touched.ts', 'nonexistent');
    expect(result).toBeUndefined();
  });
});

describe('updateAnchors', () => {
  it('persists when the updater reports a change', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    await store.updateAnchors('a.ts', (cs) => {
      cs[0].anchor.status = 'approximate';
      return true;
    });
    expect(events).toContain('reanchor');
    const data = await store.loadFile('a.ts');
    expect(data.comments[0].anchor.status).toBe('approximate');
  });

  it('does not persist when the updater reports no change', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    await store.updateAnchors('a.ts', () => false);
    expect(events).toHaveLength(0);
  });
});

describe('reanchorIfFileChanged', () => {
  it('runs the updater and records the content hash on first check', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const updater = jest.fn((cs: { anchor: Anchor }[]) => {
      cs[0].anchor.status = 'approximate';
      return true;
    });
    await store.reanchorIfFileChanged('a.ts', 'content-v1', updater as any);
    expect(updater).toHaveBeenCalledTimes(1);
  });

  it('skips the updater entirely on a second check with unchanged content', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const updater = jest.fn(() => true);
    await store.reanchorIfFileChanged('a.ts', 'content-v1', updater as any);
    updater.mockClear();
    await store.reanchorIfFileChanged('a.ts', 'content-v1', updater as any);
    expect(updater).not.toHaveBeenCalled();
  });

  it('re-runs the updater when the content changed since the last check', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const updater = jest.fn(() => true);
    await store.reanchorIfFileChanged('a.ts', 'content-v1', updater as any);
    updater.mockClear();
    await store.reanchorIfFileChanged('a.ts', 'content-v2', updater as any);
    expect(updater).toHaveBeenCalledTimes(1);
  });
});

describe('listUnresolved', () => {
  it('lists unresolved comments across the whole workspace when no file is given', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await markSourceFileExists('b.ts');
    await store.addComment('a.ts', makeAnchor(), 'in a', author);
    const bComment = await store.addComment('b.ts', makeAnchor(), 'in b', author);
    await store.resolveComment('b.ts', bComment.id, author);

    const all = await store.listUnresolved();
    expect(all.map((c) => c.text).sort()).toEqual(['in a']);
  });

  it('lists unresolved comments scoped to a single file', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'in a', author);
    const scoped = await store.listUnresolved('a.ts');
    expect(scoped).toHaveLength(1);
  });
});

describe('getComments', () => {
  it('reports endLine only when it differs from the start line', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor({ lineHint: 3, endLineHint: 3 }), 'single', author);
    await store.addComment('a.ts', makeAnchor({ lineHint: 5, endLineHint: 7 }), 'range', author);

    const views = await store.getComments('a.ts', false);
    const single = views.find((v) => v.text === 'single');
    const range = views.find((v) => v.text === 'range');
    expect(single?.endLine).toBeUndefined();
    expect(range?.endLine).toBe(7);
  });

  it('omits archived comments when includeResolved is false', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const views = await store.getComments('a.ts', false);
    expect(views).toHaveLength(0);
  });

  it('round-trips the anchor originalContent onto the tool view', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor({ originalContent: 'const x = 1;' }), 'note', author);

    const views = await store.getComments('a.ts', false);
    expect(views[0].originalContent).toBe('const x = 1;');
  });

  it('leaves originalContent undefined for a legacy anchor that never had it', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'note', author);

    const views = await store.getComments('a.ts', false);
    expect(views[0].originalContent).toBeUndefined();
  });
});

describe('getArchivedComments', () => {
  it('returns archived comments in the live StoredComment shape, stripping filePath/archivedAt', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor({ lineHint: 3, endLineHint: 3 }), 'hello', author);
    await store.resolveComment('a.ts', created.id, agent);

    const archived = await store.getArchivedComments('a.ts');
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(created.id);
    expect(archived[0].anchor.lineHint).toBe(3);
    expect(archived[0].status).toBe('resolved');
    expect(archived[0]).not.toHaveProperty('filePath');
    expect(archived[0]).not.toHaveProperty('archivedAt');
  });

  it('returns an empty array when the file has no archive yet', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const archived = await store.getArchivedComments('never-resolved.ts');
    expect(archived).toEqual([]);
  });

  it('caches archive reads and only hits disk once across repeated calls, invalidating on the next write', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const readSpy = jest.spyOn(vscode.workspace.fs, 'readFile');
    readSpy.mockClear();
    await store.getArchivedComments('a.ts');
    await store.getArchivedComments('a.ts');
    // resolveComment invalidates the cache (it appends without populating it), so the first call
    // here misses and reads disk; the second call must be served from cache, not a second read.
    expect(readSpy).toHaveBeenCalledTimes(1);

    await store.reopenComment('a.ts', created.id);
    await store.resolveComment('a.ts', created.id, author);
    readSpy.mockClear();
    await store.getArchivedComments('a.ts');
    await store.getArchivedComments('a.ts');
    expect(readSpy).toHaveBeenCalledTimes(1); // one real disk read after the write, then served from cache
  });

  it('skips a corrupted line instead of discarding the whole archive, and warns once', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const good = await store.addComment('a.ts', makeAnchor(), 'good', author);
    await store.resolveComment('a.ts', good.id, author);

    // Simulate a corrupted trailing line (e.g. a partial write from a crash) by appending garbage.
    const uri = archiveFileUri(storageUri, 'a.ts');
    const existing = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(existing + '{not valid json\n', 'utf8'));

    const archived = await store.getArchivedComments('a.ts');
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(good.id);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('corrupted archive data'));
  });
});

describe('reanchorArchive', () => {
  it('persists an updated archived anchor and fires a reanchor event', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    await store.reanchorArchive('a.ts', (cs) => {
      cs[0].anchor.lineHint = 42;
      return true;
    });
    expect(events).toContain('reanchor');

    const archived = await store.getArchivedComments('a.ts');
    expect(archived[0].anchor.lineHint).toBe(42);
  });

  it('does not write or fire an event when the updater reports no change', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    await store.reanchorArchive('a.ts', () => false);
    expect(events).toHaveLength(0);
  });

  it('is a no-op on a file with no archive', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const updater = jest.fn(() => true);
    await store.reanchorArchive('never-resolved.ts', updater as any);
    expect(updater).toHaveBeenCalledWith([]);
  });
});

describe('listArchivedFilePaths', () => {
  it('returns an empty map when the archive directory does not exist yet', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    const result = await store.listArchivedFilePaths();
    expect(result.size).toBe(0);
  });

  it('counts archived comments per file across multiple shards, ignoring non-.jsonl and broken shards', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await markSourceFileExists('b.ts');
    const a1 = await store.addComment('a.ts', makeAnchor(), 'a1', author);
    const a2 = await store.addComment('a.ts', makeAnchor(), 'a2', author);
    const b1 = await store.addComment('b.ts', makeAnchor(), 'b1', author);
    await store.resolveComment('a.ts', a1.id, author);
    await store.resolveComment('a.ts', a2.id, author);
    await store.resolveComment('b.ts', b1.id, author);

    await vscode.workspace.fs.createDirectory(archiveDirUri(storageUri));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(archiveDirUri(storageUri), 'ignored.txt'),
      Buffer.from('irrelevant', 'utf8')
    );
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(archiveDirUri(storageUri), 'empty.jsonl'), Buffer.from('', 'utf8'));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(archiveDirUri(storageUri), 'broken.jsonl'),
      Buffer.from('{not json', 'utf8')
    );

    const result = await store.listArchivedFilePaths();
    expect(result.get('a.ts')).toBe(2);
    expect(result.get('b.ts')).toBe(1);
    expect(result.size).toBe(2);
  });

  it('tolerates a readDirectory failure on the archive root', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    jest.spyOn(vscode.workspace.fs, 'readDirectory').mockRejectedValueOnce(new Error('boom'));
    const result = await store.listArchivedFilePaths();
    expect(result.size).toBe(0);
  });
});

describe('clearAll', () => {
  it('wipes the index, cache, and on-disk storage, then re-initializes', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);
    expect(store.getIndexSnapshot().size).toBe(1);

    const events: string[] = [];
    store.onDidChangeFile((e) => events.push(e.kind));
    await store.clearAll();

    expect(store.getIndexSnapshot().size).toBe(0);
    expect(events).toContain('clear');
    const data = await store.loadFile('a.ts');
    expect(data.comments).toHaveLength(0);
  });

  it('tolerates clearing when the storage directory was never created', async () => {
    const store = new CommentStore(storageUri);
    await expect(store.clearAll()).resolves.toBeUndefined();
    expect(store.getIndexSnapshot().size).toBe(0);
  });

  it('invalidates the archive cache too, so a previously-read archive does not resurrect after clearing', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    const created = await store.addComment('a.ts', makeAnchor(), 'hello', author);
    await store.resolveComment('a.ts', created.id, author);
    // Populate the archive cache before clearing — this is what previously went stale.
    expect(await store.getArchivedComments('a.ts')).toHaveLength(1);

    await store.clearAll();
    expect(await store.getArchivedComments('a.ts')).toEqual([]);

    // Reopening a comment that "shouldn't exist" after a clear would be a symptom of the same bug:
    // a stale cached array getting spliced and written back out to disk.
    const reopened = await store.reopenComment('a.ts', created.id);
    expect(reopened).toBeUndefined();
  });
});

describe('cache eviction', () => {
  it('evicts the oldest entry once the cache exceeds its capacity', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    for (let i = 0; i < 51; i++) {
      const file = `file${i}.ts`;
      await markSourceFileExists(file);
      await store.addComment(file, makeAnchor(), `c${i}`, author);
    }

    const readFileSpy = jest.spyOn(vscode.workspace.fs, 'readFile');
    readFileSpy.mockClear();
    // file0 should have been evicted from the cache, so loading it again must hit disk.
    await store.loadFile('file0.ts');
    expect(readFileSpy).toHaveBeenCalledWith(commentsFileUri(storageUri, 'file0.ts'));
  });

  it('defensively tolerates an eviction candidate reported as undefined', () => {
    const store = new CommentStore(storageUri);
    const fakeCache = {
      size: 51,
      delete: jest.fn(),
      set: jest.fn(),
      get: jest.fn(),
      keys: () => ({ next: () => ({ value: undefined }) }),
    };
    (store as unknown as { cache: unknown }).cache = fakeCache;
    expect(() =>
      (store as unknown as { touchCache: (f: string, d: unknown) => void }).touchCache('x', {
        filePath: 'x',
        fileStatus: 'ok',
        comments: [],
      })
    ).not.toThrow();
  });
});

describe('write queue', () => {
  it('serializes concurrent writes to the same file and keeps working after one fails', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');

    const writeFileSpy = jest.spyOn(vscode.workspace.fs, 'writeFile');
    writeFileSpy.mockRejectedValueOnce(new Error('disk full'));

    const results = await Promise.allSettled([
      store.addComment('a.ts', makeAnchor(), 'one', author),
      store.addComment('a.ts', makeAnchor(), 'two', author),
      store.addComment('a.ts', makeAnchor(), 'three', author),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');

    // the queue must have recovered: a fresh write on the same file still works. Note 'one' still
    // ends up persisted too — its own disk write failed, but it was already pushed onto the shared
    // in-memory/cached comments array, and the next successful write persists that array as-is.
    await store.addComment('a.ts', makeAnchor(), 'four', author);
    const data = await store.loadFile('a.ts');
    expect(data.comments.map((c) => c.text).sort()).toEqual(['four', 'one', 'three', 'two']);
  });

  it('does not block writes to unrelated files', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await markSourceFileExists('b.ts');
    await Promise.all([
      store.addComment('a.ts', makeAnchor(), 'a', author),
      store.addComment('b.ts', makeAnchor(), 'b', author),
    ]);
    expect((await store.loadFile('a.ts')).comments).toHaveLength(1);
    expect((await store.loadFile('b.ts')).comments).toHaveLength(1);
  });
});

describe('getIndexSnapshot', () => {
  it('returns an independent copy of the index', async () => {
    const store = new CommentStore(storageUri);
    await store.initialize();
    await markSourceFileExists('a.ts');
    await store.addComment('a.ts', makeAnchor(), 'hello', author);

    const snapshot = store.getIndexSnapshot();
    snapshot.delete('a.ts');
    expect(store.getIndexSnapshot().has('a.ts')).toBe(true);
  });
});
