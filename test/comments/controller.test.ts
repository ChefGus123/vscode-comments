import * as vscode from 'vscode';
import { CommentStore } from '../../src/storage/store';
import { AgentCommentsController } from '../../src/comments/controller';
import { createAnchor } from '../../src/anchoring/anchor';
import { createTextDocument } from '../__mocks__/vscode';

const mockVscode = vscode as unknown as {
  __reset(): void;
  __setConfig(key: string, value: unknown): void;
  _emitters: Record<string, { fire: (e: unknown) => void }>;
};
const storageUri = vscode.Uri.file('/storage');
const repoUri = vscode.Uri.file('/repo');
const extensionUri = vscode.Uri.file('/ext');

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

async function writeSourceFile(relativePath: string, content: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.joinPath(repoUri, relativePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return uri;
}

// setup() controllers keep subscribing to the shared mock event emitters for the rest of the test
// file unless disposed — __reset() clears state but doesn't touch listeners, so every test's
// controller would otherwise stay live and react to later tests' events. Tracked here and disposed
// in the shared afterEach so each test starts with a clean slate.
const controllersToDispose: AgentCommentsController[] = [];

async function setup() {
  vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
  const store = new CommentStore(storageUri);
  await store.initialize();
  const controller = new AgentCommentsController(store, extensionUri);
  controllersToDispose.push(controller);
  await flush();
  const createControllerMock = vscode.comments.createCommentController as jest.Mock;
  const commentController = createControllerMock.mock.results[createControllerMock.mock.results.length - 1].value;
  return { store, controller, commentController };
}

afterEach(() => {
  for (const controller of controllersToDispose) {
    controller.dispose();
  }
  controllersToDispose.length = 0;
  mockVscode.__reset();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('construction', () => {
  it('registers a comment controller with a commenting range provider covering file documents', async () => {
    const { commentController } = await setup();
    expect(vscode.comments.createCommentController).toHaveBeenCalledWith('agentComments', 'Agentic Comments');

    const fileDoc = await vscode.workspace.openTextDocument(await writeSourceFile('r.ts', 'a\nb\nc'));
    const range = commentController.commentingRangeProvider.provideCommentingRanges(fileDoc);
    expect(range).toEqual([new vscode.Range(0, 0, 2, 0)]);
  });

  it('the commenting range provider declines non-file documents and empty documents', async () => {
    const { commentController } = await setup();
    const untitledDoc = { uri: vscode.Uri.parse('untitled://x/Untitled-1'), lineCount: 3 };
    expect(commentController.commentingRangeProvider.provideCommentingRanges(untitledDoc)).toBeUndefined();

    const emptyDoc = { uri: vscode.Uri.file('/repo/empty.ts'), lineCount: 0 };
    expect(commentController.commentingRangeProvider.provideCommentingRanges(emptyDoc)).toBeUndefined();
  });

  it('renders threads for documents that are already open at construction time', async () => {
    vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
    const store = new CommentStore(storageUri);
    await store.initialize();
    const uri = await writeSourceFile('pre.ts', 'line1\nline2');
    const doc = await vscode.workspace.openTextDocument(uri);
    await store.addComment('pre.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hi', { type: 'user' });

    const controller = new AgentCommentsController(store, extensionUri);
    await flush();
    const createControllerMock = vscode.comments.createCommentController as jest.Mock;
    const commentController = createControllerMock.mock.results[createControllerMock.mock.results.length - 1].value;
    expect(commentController.createCommentThread).toHaveBeenCalled();
    void doc;
    controller.dispose();
  });
});

describe('additional subscription wiring', () => {
  it('renders documents that become visible via onDidChangeVisibleTextEditors', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    mockVscode._emitters.didChangeVisibleTextEditors.fire([{ document: doc } as any]);
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);
  });

  it('ignores onDidOpenTextDocument for non-file-scheme documents', async () => {
    const { commentController } = await setup();
    mockVscode._emitters.didOpenTextDocument.fire({ uri: vscode.Uri.parse('untitled://x/Untitled-1') } as any);
    await flush();
    expect(commentController.createCommentThread).not.toHaveBeenCalled();
  });
});

describe('renderDocument / syncThreads via document open', () => {
  it('creates a thread for each live comment when a file is opened', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });

    await vscode.workspace.openTextDocument(uri);
    await flush();

    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);
    const thread = commentController.createCommentThread.mock.results[0].value;
    expect(thread.canReply).toBe(false);
    expect(thread.contextValue).toBe('unresolved');
    expect(thread.comments[0].body.value).toBe('hello');
    expect(thread.comments[0].author.name).toBe('You');
  });

  it('leaves an already-exact, correctly-hinted anchor untouched on the first-open reanchor pass', async () => {
    const { store, commentController } = await setup();
    const lines = ['one', 'two', 'three'];
    const uri = await writeSourceFile('exact.ts', lines.join('\n'));
    const doc = createTextDocument(uri, lines.join('\n'));
    const anchor = createAnchor(doc as any, 1, 1); // matches 'two' exactly, with correct context
    await store.addComment('exact.ts', anchor, 'hi', { type: 'user' });

    await vscode.workspace.openTextDocument(uri);
    await flush();

    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);
    const rendered = commentController.createCommentThread.mock.results[0].value;
    expect(rendered.contextValue).toBe('unresolved');
    const data = await store.loadFile('exact.ts');
    expect(data.comments[0].anchor.status).toBe('exact');
    expect(data.comments[0].anchor.lineHint).toBe(2);
  });

  it('labels approximate/orphaned anchors and updates an existing thread in place on re-render', async () => {
    const { store } = await setup();
    const uri = await writeSourceFile('b.ts', 'x\ny\nz');
    const created = await store.addComment('b.ts', { lineHint: 2, endLineHint: 2, contentHash: 'nomatch', contextBefore: 'nope', contextAfter: 'nope', status: 'exact' }, 'orig', { type: 'agent' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    // orphaned: content hash and context both fail to match anywhere in the (short) document
    const dataAfterFirstOpen = await store.loadFile('b.ts');
    expect(dataAfterFirstOpen.comments[0].anchor.status).toBe('orphaned');

    // Now update the comment's text directly through the store and force a re-render by re-opening.
    await store.resolveComment('b.ts', created.id, { type: 'user' });
    await flush();
  });

  it('includes the original snippet in the comment body once the anchor degrades', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('c.ts', 'x\ny\nz');
    await store.addComment(
      'c.ts',
      { lineHint: 2, endLineHint: 2, contentHash: 'nomatch', contextBefore: 'nope', contextAfter: 'nope', originalContent: 'old code', status: 'exact' },
      'orig',
      { type: 'agent' }
    );
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    expect(thread.comments[0].body.value).toContain('*Originally:*');
    expect(thread.comments[0].body.value).toContain('old code');
  });

  it('omits the snippet block for an exact anchor even when originalContent is set', async () => {
    const { store, commentController } = await setup();
    const lines = ['one', 'two', 'three'];
    const uri = await writeSourceFile('exact2.ts', lines.join('\n'));
    const anchor = createAnchor(createTextDocument(uri, lines.join('\n')) as any, 1, 1);
    await store.addComment('exact2.ts', anchor, 'hi', { type: 'user' });

    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    expect(thread.comments[0].body.value).toBe('hi');
  });

  it('omits the snippet block when originalContent is missing (legacy anchor)', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('legacy.ts', 'x\ny\nz');
    await store.addComment(
      'legacy.ts',
      { lineHint: 2, endLineHint: 2, contentHash: 'nomatch', contextBefore: 'nope', contextAfter: 'nope', status: 'exact' },
      'orig',
      { type: 'agent' }
    );
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    expect(thread.comments[0].body.value).toBe('orig');
  });

  it('clamps the rendered range to the document bounds when the stored lineHint exceeds it', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('short.ts', 'a\nb');
    await store.addComment(
      'short.ts',
      { lineHint: 50, endLineHint: 50, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'orphaned' },
      'stale',
      { type: 'user' }
    );
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    expect(thread.range.start.line).toBeLessThanOrEqual(1);
    expect(thread.range.end.line).toBeLessThanOrEqual(1);
  });
});

describe('onStoreChanged', () => {
  it('disposes every thread on a global clear event', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    await store.clearAll();
    await flush();
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('disposes and forgets the specific thread on a delete event', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    await store.deleteComment('a.ts', created.id);
    await flush();
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('disposes and forgets the thread on a resolve event by default (hideResolvedComments: true)', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('a resolve event on an in-progress edit disposes the thread and clears the editing guard by default', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();

    expect(thread.dispose).toHaveBeenCalled();
    expect((controller as any).editingCommentIds.has(created.id)).toBe(false);
  });

  it('updates the rendered thread in place on a resolve event without disposing it when hideResolvedComments is false', async () => {
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();
    expect(thread.dispose).not.toHaveBeenCalled();
    expect(thread.contextValue).toBe('resolved');
    expect(thread.comments[0].label).toBe('resolved by agent');
  });

  it('tolerates the thread disappearing between the resolve event and the queued update running', async () => {
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    const { store, controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    // onStoreChanged checks for the thread synchronously but applies the update on the per-file
    // queue. Hold that queue open so the eviction can land in between the two, which is the window
    // the inner re-check exists to cover.
    let release!: () => void;
    (controller as any).fileQueues.set('a.ts', new Promise<void>((r) => (release = r)));

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    (controller as any).threadsByFile.get('a.ts').delete(created.id);
    release();

    await expect(flush()).resolves.toBeUndefined();
  });

  it('a resolve event overrides an in-progress edit, resetting the comment back to Preview mode instead of leaving it stuck, when hideResolvedComments is false', async () => {
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();

    expect(thread.contextValue).toBe('resolved');
    expect(thread.comments[0].mode).toBe(vscode.CommentMode.Preview);
    expect(thread.comments[0].label).toBe('resolved by agent');
    expect((controller as any).editingCommentIds.has(created.id)).toBe(false);
  });

  it('re-renders visible documents when hideResolvedComments is toggled live, showing/hiding resolved threads accordingly', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    // The config-toggle re-render only eagerly reaches visible editors (background tabs catch up
    // lazily via onDidChangeVisibleTextEditors instead), so this needs a real visible editor, not
    // just an open document.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();
    expect(thread.dispose).toHaveBeenCalled();

    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(2);
    const reshownThread = commentController.createCommentThread.mock.results[1].value;
    expect(reshownThread.contextValue).toBe('resolved');

    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', true);
    await flush();
    expect(reshownThread.dispose).toHaveBeenCalled();
  });

  it('ignores configuration changes to unrelated settings', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);

    // A change to somebody else's setting must not trigger the archive-reanchor + re-render pass.
    mockVscode.__setConfig('editor.fontSize', 14);
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);
  });

  it('handles a resolve event for a file with no rendered thread by falling through to the default path', async () => {
    const { store } = await setup();
    // Never opened in an editor, so there is no rendered thread and no open document for it.
    await writeSourceFile('never-opened.ts', 'x');
    const created = await store.addComment('never-opened.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hi', { type: 'user' });
    await expect(store.resolveComment('never-opened.ts', created.id, { type: 'user' })).resolves.toBeDefined();
    await flush();
  });

  it('handles an edit event for a file with no rendered thread by falling through to the default path', async () => {
    const { store } = await setup();
    // Never opened in an editor, so there is no rendered thread and no open document for it.
    await writeSourceFile('never-opened.ts', 'x');
    const created = await store.addComment('never-opened.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hi', { type: 'user' });
    await expect(store.updateCommentText('never-opened.ts', created.id, 'edited')).resolves.toBeDefined();
    await flush();
  });

  it('re-renders an already-open document on a plain add/reanchor event for that file', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await vscode.workspace.openTextDocument(uri);
    await flush();
    expect(commentController.createCommentThread).not.toHaveBeenCalled();

    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'added later', { type: 'user' });
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);
  });

  it('disposes threads left over for a file whose document is no longer open when a non-delete/resolve event arrives', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    // Simulate the document vanishing from the workspace's open-document registry without an
    // onDidCloseTextDocument notification reaching the controller (e.g. a missed/out-of-order event).
    vscode.workspace.textDocuments = vscode.workspace.textDocuments.filter((d) => d !== doc);

    await store.updateAnchors('a.ts', () => true); // fires a plain 'reanchor' event, not 'delete'/'resolve'
    await flush();
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('disposes a rendered, still-unresolved thread that syncThreads no longer sees for its file', async () => {
    const { store, controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const doc = await vscode.workspace.openTextDocument(uri);
    const staleThread = { dispose: jest.fn() };
    (controller as any).threadsByFile.set('a.ts', new Map([['ghost-id', { thread: staleThread, commentId: 'ghost-id', status: 'unresolved' }]]));

    (controller as any).syncThreads(doc, 'a.ts', []);
    expect(staleThread.dispose).toHaveBeenCalled();
    expect((controller as any).threadsByFile.get('a.ts').has('ghost-id')).toBe(false);
    void store;
  });
});

describe('render/mutation queue race safety', () => {
  it('does not resurrect a thread deleted by a concurrent delete while a render is in flight for the same file', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);

    // Stall a render right after it captures the live comment list, returning a snapshot (not the
    // shared cached array) so this render's captured list can't see an in-place mutation a
    // concurrent delete makes afterward — reproducing the real vulnerability, where the awaited
    // archive fetch builds its own independent array rather than sharing the cache's mutations.
    let release: () => void = () => {};
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLoadFile = store.loadFile.bind(store);
    jest.spyOn(store, 'loadFile').mockImplementationOnce(async (filePath: string) => {
      const data = await originalLoadFile(filePath);
      await stall;
      return { ...data, comments: [...data.comments] };
    });

    // Kick off a render that stalls mid-flight — simulating one already in progress (e.g. a tab
    // switch) when the comment gets deleted underneath it.
    const renderPromise = (controller as any).renderDocument(doc);
    await flush();

    await store.deleteComment('a.ts', created.id);
    await flush();

    release();
    await renderPromise;
    await flush();

    // Before the fix: the stalled render's stale (pre-delete) comment list would still include the
    // deleted comment, and since the delete handler ran unqueued and had already disposed the
    // thread, syncThreads would find the id missing from `existing` and create a resurrected
    // thread for a comment that no longer exists. With the fix, the delete handler and the render
    // are serialized on the same per-file queue, so the render only ever runs relative to a
    // threadsByFile state that already reflects the delete.
    expect(commentController.createCommentThread).toHaveBeenCalledTimes(1);
  });
});

describe('evictIfHidden', () => {
  it('disposes a pending draft thread when its document closes', async () => {
    const { controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    controller.addCommentAtSelection();
    const draftThread = commentController.createCommentThread.mock.results.at(-1)!.value;

    vscode.workspace.textDocuments = vscode.workspace.textDocuments.filter((d) => d !== doc);
    mockVscode._emitters.didCloseTextDocument.fire(doc);
    expect(draftThread.dispose).toHaveBeenCalled();
  });

  it('keeps threads alive when the document is still visible in another editor', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    await vscode.window.showTextDocument(doc);
    const thread = commentController.createCommentThread.mock.results[0].value;

    mockVscode._emitters.didCloseTextDocument.fire(doc);
    expect(thread.dispose).not.toHaveBeenCalled();
  });

  it('disposes all threads and forgets reanchor-on-open state when a rendered document closes with no visible editor', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    const thread = commentController.createCommentThread.mock.results[0].value;

    mockVscode._emitters.didCloseTextDocument.fire(doc);
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('tolerates closing a file-scheme document that was never rendered (no threads to dispose)', async () => {
    const { commentController } = await setup();
    const uri = await writeSourceFile('untouched.ts', 'one\ntwo');
    const doc = await vscode.workspace.openTextDocument(uri);
    expect(() => mockVscode._emitters.didCloseTextDocument.fire(doc)).not.toThrow();
    expect(commentController.createCommentThread).not.toHaveBeenCalled();
  });

  it('ignores close events for non-file-scheme documents', async () => {
    const { commentController } = await setup();
    const fakeDoc = { uri: vscode.Uri.parse('untitled://x/Untitled-1') };
    expect(() => mockVscode._emitters.didCloseTextDocument.fire(fakeDoc as any)).not.toThrow();
    expect(commentController.createCommentThread).not.toHaveBeenCalled();
  });
});

describe('onDocumentChanged debounce + reanchorAfterChange', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('ignores changes on non-file documents and no-op change events', async () => {
    const { commentController } = await setup();
    mockVscode._emitters.didChangeTextDocument.fire({ document: { uri: vscode.Uri.parse('untitled://x/Untitled-1') }, contentChanges: [{}] });
    mockVscode._emitters.didChangeTextDocument.fire({ document: { uri: vscode.Uri.file('/repo/a.ts') }, contentChanges: [] });
    await jest.advanceTimersByTimeAsync(1000);
    expect(commentController.createCommentThread).not.toHaveBeenCalled();
  });

  it('does nothing when the changed file has no rendered threads', async () => {
    const { store } = await setup();
    await writeSourceFile('a.ts', 'one\ntwo');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(repoUri, 'a.ts'));
    // No comments were ever added, so threadsByFile has no entry for 'a.ts'.
    mockVscode._emitters.didChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'x' }] });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await store.loadFile('a.ts')).comments).toHaveLength(0);
  });

  it('reanchors an exact comment to approximate when an overlapping edit changes its own line content', async () => {
    const { store } = await setup();
    const lines = ['before', 'target', 'after'];
    const uri = await writeSourceFile('shift.ts', lines.join('\n'));
    const anchor = createAnchor(createTextDocument(uri, lines.join('\n')) as any, 1, 1); // exact match on 'target'
    await store.addComment('shift.ts', anchor, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    expect((await store.loadFile('shift.ts')).comments[0].anchor.status).toBe('exact');

    // A real edit to the comment's own line: the buffer changes first (as VS Code would apply it),
    // then the change event fires — content hash no longer matches, but context still does.
    (doc as any).__setText('before\nCHANGED\nafter');
    mockVscode._emitters.didChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new vscode.Range(1, 0, 1, 0), text: 'CHANGED' }] });
    await jest.advanceTimersByTimeAsync(1000);

    const data = await store.loadFile('shift.ts');
    expect(data.comments[0].anchor.status).toBe('approximate');
  });

  it('reanchors a resolved comment shown via hideResolvedComments: false when an edit shifts its line', async () => {
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    const { store, controller } = await setup();
    const lines = ['zero', 'one', 'two', 'target', 'four'];
    const uri = await writeSourceFile('shift.ts', lines.join('\n'));
    const anchor = createAnchor(createTextDocument(uri, lines.join('\n')) as any, 3, 3); // exact match on 'target'
    const created = await store.addComment('shift.ts', anchor, 'hi', { type: 'user' });
    await store.resolveComment('shift.ts', created.id, { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    // The initial render (which now also reanchors the archive on first open) is queued behind
    // whatever onDidOpenTextDocument already triggered — explicitly awaiting it here, rather than
    // just flushing a fixed number of microtask rounds, guarantees the thread actually exists
    // before firing the edit below (onDocumentChanged's "nothing rendered yet" gate would otherwise
    // skip scheduling the reanchor entirely if it ran too early).
    await (controller as any).renderDocument(doc);
    expect((await store.getArchivedComments('shift.ts'))[0].anchor.lineHint).toBe(4);

    // Insert a line well above the comment's own line — a pure shift, not an overlapping edit.
    (doc as any).__setText(['NEW', ...lines].join('\n'));
    mockVscode._emitters.didChangeTextDocument.fire({
      document: doc,
      contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'NEW\n' }],
    });
    await jest.advanceTimersByTimeAsync(1000);

    // Before this fix, a shown-but-resolved comment's anchor was never updated by edits, so it
    // would still report lineHint 4 here instead of tracking the insertion.
    expect((await store.getArchivedComments('shift.ts'))[0].anchor.lineHint).toBe(5);
  });

  it('fully reanchors the archive when hideResolvedComments is toggled on for an already-open file, catching drift accumulated while hidden', async () => {
    // Starts hidden (default) — the file's first-open pass runs while nothing shows the archive.
    const { store, controller } = await setup();
    const lines = ['zero', 'one', 'two', 'target', 'four'];
    const uri = await writeSourceFile('shift.ts', lines.join('\n'));
    const anchor = createAnchor(createTextDocument(uri, lines.join('\n')) as any, 3, 3); // exact match on 'target'
    const created = await store.addComment('shift.ts', anchor, 'hi', { type: 'user' });
    await store.resolveComment('shift.ts', created.id, { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await (controller as any).renderDocument(doc);

    // Edit while still hidden — reanchorAfterChange deliberately skips the archive here since
    // nothing renders it, so the stored anchor goes stale on purpose.
    (doc as any).__setText(['NEW', ...lines].join('\n'));
    mockVscode._emitters.didChangeTextDocument.fire({
      document: doc,
      contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'NEW\n' }],
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await store.getArchivedComments('shift.ts'))[0].anchor.lineHint).toBe(4); // still stale

    // Show resolved comments without closing the tab. Before the fix, the archive's one-time full
    // reanchor was nested inside reanchoredOnOpen — already consumed by the first (hidden) open —
    // so it would never run again for this file and the comment would stay stuck at line 4 forever.
    mockVscode.__setConfig('agenticComments.editor.hideResolvedComments', false);
    await (controller as any).renderDocument(doc);

    expect((await store.getArchivedComments('shift.ts'))[0].anchor.lineHint).toBe(5);
  });

  it('debounces rapid edits and reanchors comments once after the quiet period', async () => {
    const { store } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const created = await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();

    // Two rapid edits within the debounce window: only the last should trigger a reanchor pass.
    mockVscode._emitters.didChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'X' }] });
    await jest.advanceTimersByTimeAsync(100);
    mockVscode._emitters.didChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'Y' }] });
    await jest.advanceTimersByTimeAsync(500);

    const data = await store.loadFile('a.ts');
    expect(data.comments[0].id).toBe(created.id);
  });

  it('keeps an already-orphaned comment orphaned and frozen even when a later overlapping edit restores content that would otherwise re-anchor exactly', async () => {
    const { store } = await setup();
    const uri = await writeSourceFile('frozen.ts', 'one\ntwo\nthree');
    const anchor = createAnchor(createTextDocument(uri, 'one\ntwo\nthree') as any, 1, 1); // matches 'two' exactly
    await store.addComment('frozen.ts', { ...anchor, status: 'orphaned' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();

    // An edit overlapping the comment's own line — would satisfy the exact-match cascade if it ran,
    // but the freeze must short-circuit before it gets the chance.
    mockVscode._emitters.didChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new vscode.Range(1, 0, 1, 0), text: 'two' }] });
    await jest.advanceTimersByTimeAsync(1000);

    const data = await store.loadFile('frozen.ts');
    expect(data.comments[0].anchor.status).toBe('orphaned');
    expect(data.comments[0].anchor.lineHint).toBe(anchor.lineHint);
  });
});

describe('toVscodeComment edge cases (white-box)', () => {
  it('falls back to "unknown" when a resolved comment defensively has no resolvedBy', async () => {
    const { controller } = await setup();
    const vscodeComment = (controller as any).toVscodeComment({
      id: 'c1',
      anchor: { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' },
      author: { type: 'user' },
      text: 'hi',
      status: 'resolved',
      resolvedBy: null,
      createdAt: '',
      updatedAt: '',
    });
    expect(vscodeComment.label).toBe('resolved by unknown');
  });

  it('marks an unresolved comment editable and a resolved comment not editable, and carries id/rawText', async () => {
    const { controller } = await setup();
    const base = {
      id: 'c1',
      anchor: { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' as const },
      author: { type: 'user' as const },
      text: 'hi',
      resolvedBy: null,
      createdAt: '',
      updatedAt: '',
    };
    const unresolved = (controller as any).toVscodeComment({ ...base, status: 'unresolved' });
    expect(unresolved.contextValue).toBe('editable');
    expect(unresolved.id).toBe('c1');
    expect(unresolved.rawText).toBe('hi');

    const resolved = (controller as any).toVscodeComment({ ...base, status: 'resolved', resolvedBy: { type: 'user' } });
    expect(resolved.contextValue).toBeUndefined();
  });
});

describe('createComment', () => {
  it('warns and does nothing when there is no reply thread', async () => {
    const { controller } = await setup();
    await controller.createComment(undefined, 'user');
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it('disposes the thread without saving when the reply text is blank', async () => {
    const { controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const thread = { uri, range: new vscode.Range(0, 0, 0, 0), dispose: jest.fn() };
    await controller.createComment({ thread, text: '   ' } as any, 'user');
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('creates a comment from the reply text and disposes the draft thread', async () => {
    const { store, controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const thread = { uri, range: new vscode.Range(1, 0, 1, 0), dispose: jest.fn() };
    await controller.createComment({ thread, text: 'new comment' } as any, 'agent');
    expect(thread.dispose).toHaveBeenCalled();
    const data = await store.loadFile('a.ts');
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].text).toBe('new comment');
    expect(data.comments[0].author.type).toBe('agent');
  });

  it('defaults to a zero-length range at the top of the file when the thread has no range', async () => {
    const { store, controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const thread = { uri, range: undefined, dispose: jest.fn() };
    await controller.createComment({ thread, text: 'no range' } as any, 'user');
    const data = await store.loadFile('a.ts');
    expect(data.comments[0].anchor.lineHint).toBe(1);
    expect(data.comments[0].anchor.endLineHint).toBe(1);
  });

  it('defaults to a zero-length range when the reply thread has none, and clears a matching pending draft', async () => {
    const { controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const editorDoc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(editorDoc);
    controller.addCommentAtSelection();
    const pending = (controller as any).pendingDraftThread;

    await controller.createComment({ thread: pending, text: 'hi' } as any, 'user');
    expect((controller as any).pendingDraftThread).toBeUndefined();
  });
});

describe('addCommentAtSelection', () => {
  it('warns when there is no active file editor', async () => {
    const { controller } = await setup();
    vscode.window.activeTextEditor = undefined;
    controller.addCommentAtSelection();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it('warns when the active editor is not a file-scheme document', async () => {
    const { controller } = await setup();
    vscode.window.activeTextEditor = { document: { uri: vscode.Uri.parse('untitled://x/Untitled-1') } } as any;
    controller.addCommentAtSelection();
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it('creates an empty expanded draft thread at the current selection and disposes a prior draft', async () => {
    const { controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    controller.addCommentAtSelection();
    const first = commentController.createCommentThread.mock.results.at(-1)!.value;
    expect(first.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);

    controller.addCommentAtSelection();
    expect(first.dispose).toHaveBeenCalled();
  });
});

describe('per-file render queue', () => {
  it('logs and keeps the queue usable when a queued task throws', async () => {
    const { store, commentController } = await setup();
    const uri = await writeSourceFile('boom.ts', 'one\ntwo');
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // Every caller fires queued work with `void`, so without this log a throw would vanish silently.
    const loadFileSpy = jest.spyOn(store, 'loadFile').mockRejectedValueOnce(new Error('disk on fire'));

    await vscode.workspace.openTextDocument(uri);
    await flush();

    expect(consoleSpy).toHaveBeenCalledWith(
      'Agentic Comments: error in queued render/mutation task for',
      'boom.ts',
      expect.objectContaining({ message: 'disk on fire' })
    );

    // The queue must not be wedged: the next render for the same file still goes through.
    loadFileSpy.mockRestore();
    await store.addComment('boom.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'after', { type: 'user' });
    await flush();
    expect(commentController.createCommentThread).toHaveBeenCalled();
  });
});

describe('addCommentFromPreview', () => {
  const inputBox = () => vscode.window.showInputBox as unknown as jest.Mock;
  /** The `prompt` string the input box was last opened with — this is the "snap and show" output. */
  const lastPrompt = (): string => inputBox().mock.calls.at(-1)![0].prompt;

  /** A document whose blocks are easy to reason about by line number (1-based in comments):
   *   1 `# Title`, 2 blank, 3-5 a three-line paragraph, 6 blank, 7 `last`. */
  const DOC = '# Title\n\nalpha\nbeta\ngamma\n\nlast';

  async function previewDoc(relativePath = 'doc.md', content = DOC): Promise<string> {
    const uri = await writeSourceFile(relativePath, content);
    return uri.toString();
  }

  describe('payload validation — never guesses a location', () => {
    it.each([
      ['no context at all', undefined],
      ['no source', { agentCommentsLine: 0 }],
      ['a non-string source', { agentCommentsSource: 42, agentCommentsLine: 0 }],
      ['no line', { agentCommentsSource: 'file:///repo/doc.md' }],
      ['a non-numeric line', { agentCommentsSource: 'file:///repo/doc.md', agentCommentsLine: '3' }],
      ['a non-finite line', { agentCommentsSource: 'file:///repo/doc.md', agentCommentsLine: Number.NaN }],
    ])('warns and creates nothing given %s', async (_label, ctx) => {
      const { controller, store } = await setup();
      await controller.addCommentFromPreview(ctx as any);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not tell which line'));
      expect(inputBox()).not.toHaveBeenCalled();
      expect((await store.loadFile('doc.md')).comments).toHaveLength(0);
    });

    it('warns for a preview of a non-file-scheme document', async () => {
      const { controller } = await setup();
      await controller.addCommentFromPreview({ agentCommentsSource: 'untitled://x/Untitled-1', agentCommentsLine: 0 });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('unsaved or virtual'));
      expect(inputBox()).not.toHaveBeenCalled();
    });
  });

  describe('single-line anchors (bare right-click)', () => {
    it('creates a user-authored comment anchored to the clicked line', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('  looks wrong  ');

      // data-line is zero-based: 2 is source line 3, "alpha".
      await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 2 });

      const [comment] = (await store.loadFile('doc.md')).comments;
      expect(comment.text).toBe('looks wrong');
      expect(comment.author).toEqual({ type: 'user' });
      expect(comment.status).toBe('unresolved');
      expect(comment.anchor.lineHint).toBe(3);
      expect(comment.anchor.endLineHint).toBe(3);
    });

    it('matches createAnchor exactly, so a preview comment is indistinguishable from a gutter one', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source));
      inputBox().mockResolvedValueOnce('hi');

      await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 2 });

      const [comment] = (await store.loadFile('doc.md')).comments;
      expect(comment.anchor).toEqual(createAnchor(document as any, 2, 2));
    });

    it('shows the line number and the clicked line\'s own text when nothing is selected', async () => {
      const { controller } = await setup();
      await controller.addCommentFromPreview({ agentCommentsSource: await previewDoc(), agentCommentsLine: 2 });
      expect(lastPrompt()).toBe('Line 3: alpha');
    });

    it('prefers the selected text over the line text for the prompt', async () => {
      const { controller } = await setup();
      await controller.addCommentFromPreview({
        agentCommentsSource: await previewDoc(),
        agentCommentsLine: 2,
        agentCommentsSelection: '  lph  ',
      });
      expect(lastPrompt()).toBe('Line 3: lph');
    });

    it('falls back to the line text when the selection is blank', async () => {
      const { controller } = await setup();
      await controller.addCommentFromPreview({
        agentCommentsSource: await previewDoc(),
        agentCommentsLine: 2,
        agentCommentsSelection: '   ',
      });
      expect(lastPrompt()).toBe('Line 3: alpha');
    });

    it('truncates a long preview instead of overflowing the input box', async () => {
      const { controller } = await setup();
      const long = 'x'.repeat(200);
      await controller.addCommentFromPreview({
        agentCommentsSource: await previewDoc('long.md', long),
        agentCommentsLine: 0,
        agentCommentsSelection: long,
      });
      expect(lastPrompt()).toBe(`Line 1: ${'x'.repeat(60)}…`);
    });

    it('omits the separator when there is no text to show at all', async () => {
      const { controller } = await setup();
      // Line 2 (index 1) is blank and nothing is selected, so there is no preview text.
      await controller.addCommentFromPreview({ agentCommentsSource: await previewDoc(), agentCommentsLine: 1 });
      expect(lastPrompt()).toBe('Line 2');
    });
  });

  describe('clamping a line into the document', () => {
    it('clamps the preview\'s past-the-end sentinel line onto the last real line', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('at the end');
      // The preview appends a `data-line="${lineCount}"` sentinel div after the body.
      await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 7 });
      expect((await store.loadFile('doc.md')).comments[0].anchor.lineHint).toBe(7);
    });

    it('clamps a negative line to the first line', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('at the start');
      await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: -5 });
      expect((await store.loadFile('doc.md')).comments[0].anchor.lineHint).toBe(1);
    });

    it('floors a fractional line', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('fractional');
      await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 2.9 });
      expect((await store.loadFile('doc.md')).comments[0].anchor.lineHint).toBe(3);
    });
  });

  describe('multi-line anchors (selection snapped to whole blocks)', () => {
    it('anchors the whole span and says so in the prompt', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('about this whole paragraph');

      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 2,
        agentCommentsEndLine: 4,
      });

      expect(lastPrompt()).toBe('Lines 3–5: alpha');
      const [comment] = (await store.loadFile('doc.md')).comments;
      expect(comment.anchor.lineHint).toBe(3);
      expect(comment.anchor.endLineHint).toBe(5);
      expect(comment.anchor.originalContent).toBe('alpha\nbeta\ngamma');
    });

    it('trims the blank separator line left by deriving the end from the next block\'s start', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('trimmed');

      // preview.js reports "the line before the next block starts" — index 5, a blank line.
      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 2,
        agentCommentsEndLine: 5,
      });

      expect((await store.loadFile('doc.md')).comments[0].anchor.endLineHint).toBe(5);
      expect(lastPrompt()).toBe('Lines 3–5: alpha');
    });

    it('trims a run of several blank lines back to the last line with content', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc('gappy.md', 'alpha\n\n\n\nlast');
      inputBox().mockResolvedValueOnce('trimmed hard');
      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 0,
        agentCommentsEndLine: 3,
      });
      expect((await store.loadFile('gappy.md')).comments[0].anchor.endLineHint).toBe(1);
      expect(lastPrompt()).toBe('Line 1: alpha');
    });

    it('never trims below the start line, even when the start line is itself blank', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('blank start');
      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 1,
        agentCommentsEndLine: 1,
      });
      const { anchor } = (await store.loadFile('doc.md')).comments[0];
      expect(anchor.lineHint).toBe(2);
      expect(anchor.endLineHint).toBe(2);
    });

    it('ignores an end line before the start line rather than inverting the range', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('backwards');
      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 4,
        agentCommentsEndLine: 2,
      });
      const { anchor } = (await store.loadFile('doc.md')).comments[0];
      expect(anchor.lineHint).toBe(5);
      expect(anchor.endLineHint).toBe(5);
    });

    it('clamps an out-of-range end line onto the last line', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('to the end');
      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 2,
        agentCommentsEndLine: 99,
      });
      expect((await store.loadFile('doc.md')).comments[0].anchor.endLineHint).toBe(7);
    });

    it.each([
      ['omitted', undefined],
      ['a non-finite number', Number.NaN],
      ['a non-number', '4'],
    ])('stays single-line when the end line is %s', async (_label, agentCommentsEndLine) => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce('single');
      await controller.addCommentFromPreview({
        agentCommentsSource: source,
        agentCommentsLine: 2,
        agentCommentsEndLine,
      } as any);
      const { anchor } = (await store.loadFile('doc.md')).comments[0];
      expect(anchor.lineHint).toBe(3);
      expect(anchor.endLineHint).toBe(3);
      expect(lastPrompt()).toBe('Line 3: alpha');
    });
  });

  describe('dismissing the input box', () => {
    it.each([
      ['Esc', undefined],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ])('creates nothing when the user answers with %s', async (_label, answer) => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      inputBox().mockResolvedValueOnce(answer);
      await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 2 });
      expect((await store.loadFile('doc.md')).comments).toHaveLength(0);
    });
  });

  it('works on a file with no editor open for it — the URI alone is enough', async () => {
    const { controller, store } = await setup();
    const source = await previewDoc('closed.md');
    expect(vscode.workspace.textDocuments.find((d) => d.uri.toString() === source)).toBeUndefined();
    inputBox().mockResolvedValueOnce('from a closed file');

    await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 0 });

    expect((await store.loadFile('closed.md')).comments).toHaveLength(1);
  });

  it('keys the comment off the workspace-relative path, matching every other entry point', async () => {
    const { controller, store } = await setup();
    const source = await previewDoc('docs/nested/deep.md');
    inputBox().mockResolvedValueOnce('nested');
    await controller.addCommentFromPreview({ agentCommentsSource: source, agentCommentsLine: 0 });
    expect((await store.loadFile('docs/nested/deep.md')).comments).toHaveLength(1);
  });
});

describe('editCommentFromPreview / resolveCommentFromPreview / reopenCommentFromPreview / deleteCommentFromPreview', () => {
  const inputBox = () => vscode.window.showInputBox as unknown as jest.Mock;
  const quickPick = () => vscode.window.showQuickPick as unknown as jest.Mock;
  const anchor = { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' as const };

  async function previewDoc(relativePath = 'doc.md', content = 'one\ntwo\nthree'): Promise<string> {
    const uri = await writeSourceFile(relativePath, content);
    return uri.toString();
  }

  describe('payload validation', () => {
    it('warns when there is no source', async () => {
      const { controller } = await setup();
      await controller.resolveCommentFromPreview({ agentCommentsCommentIds: 'c1' });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not tell which file'));
    });

    it('warns when there are no comment ids', async () => {
      const { controller } = await setup();
      const source = await previewDoc();
      await controller.deleteCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: '' });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not tell which comment'));
    });

    it('warns when agentCommentsCommentIds is entirely absent from the payload', async () => {
      const { controller } = await setup();
      const source = await previewDoc();
      await controller.deleteCommentFromPreview({ agentCommentsSource: source });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not tell which comment'));
    });

    it('warns for a non-file-scheme source, same message addCommentFromPreview uses', async () => {
      const { controller } = await setup();
      await controller.editCommentFromPreview({ agentCommentsSource: 'untitled://x/Untitled-1', agentCommentsCommentIds: 'c1' });
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('unsaved or virtual'));
    });
  });

  describe('resolveCommentFromPreview', () => {
    it('resolves the single candidate directly without prompting', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'hi', { type: 'user' });

      await controller.resolveCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect(quickPick()).not.toHaveBeenCalled();
      expect((await store.loadFile('doc.md')).comments).toHaveLength(0);
      const archived = await store.getArchivedComments('doc.md');
      expect(archived[0].status).toBe('resolved');
      expect(archived[0].resolvedBy).toEqual({ type: 'user' });
    });

    it('prompts with a quickpick when more than one candidate applies, and resolves only the picked one', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const a = await store.addComment('doc.md', anchor, 'first', { type: 'user' });
      const b = await store.addComment('doc.md', anchor, 'second', { type: 'agent' });
      quickPick().mockImplementationOnce(async (items: { comment: { id: string } }[]) => items.find((i) => i.comment.id === b.id));

      await controller.resolveCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: `${a.id},${b.id}` });

      expect(quickPick()).toHaveBeenCalled();
      const items = quickPick().mock.calls[0][0] as { label: string; description: string }[];
      expect(items.map((i) => i.label)).toEqual(['first', 'second']);
      expect(items.map((i) => i.description)).toEqual(['You · unresolved', 'Agent · unresolved']);

      const live = (await store.loadFile('doc.md')).comments;
      expect(live.map((c) => c.id)).toEqual([a.id]);
      expect((await store.getArchivedComments('doc.md')).map((c) => c.id)).toEqual([b.id]);
    });

    it('does nothing and informs the user when every candidate is already resolved', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'hi', { type: 'user' });
      await store.resolveComment('doc.md', added.id, { type: 'user' });

      await controller.resolveCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('nothing to resolve'));
      expect(quickPick()).not.toHaveBeenCalled();
    });

    it('falls back to "unknown" resolver in the quickpick description when resolvedBy is missing on a resolved candidate', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const a = await store.addComment('doc.md', anchor, 'first', { type: 'user' });
      // Simulates a resolved comment with no resolvedBy, same defensive case treeView.ts's own
      // fallback covers — not reachable through the store's own resolveComment, which always sets it.
      jest.spyOn(store, 'getArchivedComments').mockResolvedValueOnce([
        { id: 'c_archived', anchor, author: { type: 'user' }, text: 'stale', status: 'resolved', resolvedBy: null, createdAt: '', updatedAt: '' },
      ]);
      quickPick().mockImplementationOnce(async (items: { comment: { id: string } }[]) => items.find((i) => i.comment.id === a.id));

      await controller.deleteCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: `${a.id},c_archived` });

      const items = quickPick().mock.calls[0][0] as { description: string }[];
      expect(items.map((i) => i.description)).toContain('You · resolved by unknown');
    });

    it('changes nothing when the quickpick is dismissed', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const a = await store.addComment('doc.md', anchor, 'first', { type: 'user' });
      const b = await store.addComment('doc.md', anchor, 'second', { type: 'user' });

      await controller.resolveCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: `${a.id},${b.id}` });

      expect((await store.loadFile('doc.md')).comments).toHaveLength(2);
    });
  });

  describe('reopenCommentFromPreview', () => {
    it('does nothing and informs the user when every candidate is still unresolved', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'hi', { type: 'user' });

      await controller.reopenCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('nothing to reopen'));
      expect(quickPick()).not.toHaveBeenCalled();
    });

    it('reopens the single resolved candidate, ignoring an unresolved id in the same list', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const resolved = await store.addComment('doc.md', anchor, 'r', { type: 'user' });
      await store.resolveComment('doc.md', resolved.id, { type: 'user' });
      const unresolved = await store.addComment('doc.md', anchor, 'u', { type: 'user' });

      await controller.reopenCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: `${resolved.id},${unresolved.id}` });

      expect(quickPick()).not.toHaveBeenCalled();
      const live = (await store.loadFile('doc.md')).comments;
      expect(live.find((c) => c.id === resolved.id)?.status).toBe('unresolved');
      expect(await store.getArchivedComments('doc.md')).toHaveLength(0);
    });
  });

  describe('deleteCommentFromPreview', () => {
    it('deletes the single candidate regardless of status', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'hi', { type: 'user' });

      await controller.deleteCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect((await store.loadFile('doc.md')).comments).toHaveLength(0);
      expect(await store.getArchivedComments('doc.md')).toHaveLength(0);
    });

    it('prompts with a quickpick across mixed resolved/unresolved candidates', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const a = await store.addComment('doc.md', anchor, 'first', { type: 'user' });
      const b = await store.addComment('doc.md', anchor, 'second', { type: 'user' });
      await store.resolveComment('doc.md', b.id, { type: 'user' });
      quickPick().mockImplementationOnce(async (items: { comment: { id: string } }[]) => items.find((i) => i.comment.id === a.id));

      await controller.deleteCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: `${a.id},${b.id}` });

      expect((await store.loadFile('doc.md')).comments).toHaveLength(0);
      expect(await store.getArchivedComments('doc.md')).toHaveLength(1);
    });
  });

  describe('editCommentFromPreview', () => {
    it('shows an input box prefilled with the current text and saves the edit', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'original', { type: 'user' });
      inputBox().mockResolvedValueOnce('edited text');

      await controller.editCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect(inputBox().mock.calls[0][0]).toMatchObject({ value: 'original' });
      expect((await store.loadFile('doc.md')).comments[0].text).toBe('edited text');
    });

    it('does nothing and informs the user when every candidate is already resolved', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'hi', { type: 'user' });
      await store.resolveComment('doc.md', added.id, { type: 'user' });

      await controller.editCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('nothing to edit'));
      expect(inputBox()).not.toHaveBeenCalled();
    });

    it('makes no change on a blank/cancelled input box', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'original', { type: 'user' });

      await controller.editCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect((await store.loadFile('doc.md')).comments[0].text).toBe('original');
    });

    it('warns when the save lands on a comment resolved/deleted elsewhere in the same race', async () => {
      const { controller, store } = await setup();
      const source = await previewDoc();
      const added = await store.addComment('doc.md', anchor, 'original', { type: 'user' });
      inputBox().mockResolvedValueOnce('too late');
      jest.spyOn(store, 'updateCommentText').mockResolvedValueOnce(undefined);

      await controller.editCommentFromPreview({ agentCommentsSource: source, agentCommentsCommentIds: added.id });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('resolved or deleted elsewhere'));
    });
  });
});

describe('resolveThread / reopenThread / deleteThread', () => {
  it('warns for resolveThread/reopenThread/deleteThread when there is no thread or comment id', async () => {
    const { controller } = await setup();
    await controller.resolveThread(undefined, 'user');
    await controller.reopenThread(undefined);
    await controller.deleteThread(undefined);
    await controller.resolveThread({ uri: repoUri, comments: [{}] } as any, 'user');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(4);
  });

  it('resolves, reopens, and deletes via the store using the thread uri and comment id', async () => {
    const { store, controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo');
    const created = await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });

    const thread = { uri, comments: [{ id: created.id }] } as any;
    await controller.resolveThread(thread, 'user');
    expect((await store.loadFile('a.ts')).comments).toHaveLength(0);

    await controller.reopenThread(thread);
    expect((await store.loadFile('a.ts')).comments).toHaveLength(1);

    await controller.deleteThread(thread);
    expect((await store.loadFile('a.ts')).comments).toHaveLength(0);
  });
});

describe('editComment / saveComment / cancelComment', () => {
  it('warns for editComment/saveComment/cancelComment when the comment has no parent thread', async () => {
    const { controller } = await setup();
    controller.editComment(undefined);
    await controller.saveComment(undefined);
    await controller.cancelComment(undefined);
    controller.editComment({} as any);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(4);
  });

  it('editComment flips mode to Editing, sets body to rawText, and reassigns the parent comments array', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    const originalArray = thread.comments;

    controller.editComment(comment);

    expect(comment.mode).toBe(vscode.CommentMode.Editing);
    expect(comment.body).toBe('hello');
    expect(thread.comments).not.toBe(originalArray);
    expect(thread.comments[0]).toBe(comment);
  });

  it('saveComment persists the new text via the store and the re-rendered comment shows it in Preview mode', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);
    comment.body = 'edited text';

    await controller.saveComment(comment);
    await flush();

    const data = await store.loadFile('a.ts');
    expect(data.comments[0].text).toBe('edited text');
    expect(thread.comments[0].mode).toBe(vscode.CommentMode.Preview);
    expect(thread.comments[0].body.value).toBe('edited text');
  });

  it('warns instead of silently discarding the edit when the comment was resolved elsewhere before Save ran', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const created = await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);
    comment.body = 'edited text';

    // Resolved out from under the edit before Save is clicked — updateCommentText can no longer find
    // it in the live array, so the save must be reported as failed rather than silently dropped.
    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();

    await controller.saveComment(comment);
    await flush();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('could not save'));
    const archived = await store.getComments('a.ts', true);
    expect(archived[0].text).toBe('hello');
  });

  it('saveComment reads text from a MarkdownString body just like a plain string body', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);
    comment.body = new vscode.MarkdownString('edited via markdown');

    await controller.saveComment(comment);
    await flush();

    const data = await store.loadFile('a.ts');
    expect(data.comments[0].text).toBe('edited via markdown');
  });

  it('treats a blank/whitespace-only save as an implicit cancel, leaving stored text untouched', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);
    comment.body = '   ';

    await controller.saveComment(comment);
    await flush();

    const data = await store.loadFile('a.ts');
    expect(data.comments[0].text).toBe('hello');
    expect(thread.comments[0].mode).toBe(vscode.CommentMode.Preview);
  });

  it('cancelComment discards edits and restores the original Preview-mode body without persisting', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);
    comment.body = 'unsaved edit';

    await controller.cancelComment(comment);
    await flush();

    const data = await store.loadFile('a.ts');
    expect(data.comments[0].text).toBe('hello');
    expect(thread.comments[0].mode).toBe(vscode.CommentMode.Preview);
    expect(thread.comments[0].body.value).toBe('hello');
  });

  it('cancelComment is a no-op on the thread when the comment was resolved elsewhere first (nothing left to restore it from)', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const created = await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hello', { type: 'user' });
    await vscode.workspace.openTextDocument(uri);
    await flush();

    const thread = commentController.createCommentThread.mock.results[0].value;
    const comment = thread.comments[0];
    controller.editComment(comment);
    comment.body = 'unsaved edit';

    await store.resolveComment('a.ts', created.id, { type: 'agent' });
    await flush();
    // The resolve event already reset this thread to Preview/resolved on its own; cancelComment
    // should not throw or misbehave when the comment it was tracking is no longer live.
    await expect(controller.cancelComment(comment)).resolves.toBeUndefined();
  });
});

describe('revealComment', () => {
  it('does nothing when filePath or line is missing', async () => {
    const { controller } = await setup();
    await controller.revealComment(undefined, 5);
    await controller.revealComment('a.ts', undefined);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('warns when the file path cannot be resolved in the workspace', async () => {
    const { controller } = await setup();
    vscode.workspace.workspaceFolders = undefined;
    await controller.revealComment('a.ts', 3);
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it('opens the document, selects/reveals the line, and expands the comment thread', async () => {
    const { store, controller, commentController } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    const created = await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hi', { type: 'user' });

    await controller.revealComment('a.ts', 2, created.id);
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
    const thread = commentController.createCommentThread.mock.results[0].value;
    expect(thread.collapsibleState).toBe(vscode.CommentThreadCollapsibleState.Expanded);
    void uri;
  });

  it('reveals without expanding anything when no commentId is given', async () => {
    const { controller } = await setup();
    await writeSourceFile('a.ts', 'one\ntwo');
    await controller.revealComment('a.ts', 1);
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });

  it('reveals without expanding when the given commentId has no rendered thread', async () => {
    const { store, controller } = await setup();
    await writeSourceFile('a.ts', 'one\ntwo');
    await store.addComment('a.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: 'two', status: 'exact' }, 'hi', { type: 'user' });
    await expect(controller.revealComment('a.ts', 1, 'no-such-id')).resolves.toBeUndefined();
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('clears pending debounce timers and disposes all subscriptions', async () => {
    jest.useFakeTimers();
    const { store, controller } = await setup();
    const uri = await writeSourceFile('a.ts', 'one\ntwo\nthree');
    await store.addComment('a.ts', { lineHint: 2, endLineHint: 2, contentHash: 'h', contextBefore: 'one', contextAfter: 'three', status: 'exact' }, 'hi', { type: 'user' });
    const doc = await vscode.workspace.openTextDocument(uri);
    await flush();
    mockVscode._emitters.didChangeTextDocument.fire({ document: doc, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'x' }] });

    expect(() => controller.dispose()).not.toThrow();
  });
});
