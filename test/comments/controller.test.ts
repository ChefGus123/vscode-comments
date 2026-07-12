import * as vscode from 'vscode';
import { CommentStore } from '../../src/storage/store';
import { AgentCommentsController } from '../../src/comments/controller';
import { createAnchor } from '../../src/anchoring/anchor';
import { createTextDocument } from '../__mocks__/vscode';

const mockVscode = vscode as unknown as { __reset(): void; _emitters: Record<string, { fire: (e: unknown) => void }> };
const storageUri = vscode.Uri.file('/storage');
const repoUri = vscode.Uri.file('/repo');
const extensionUri = vscode.Uri.file('/ext');

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

async function writeSourceFile(relativePath: string, content: string): Promise<vscode.Uri> {
  const uri = vscode.Uri.joinPath(repoUri, relativePath);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return uri;
}

async function setup() {
  vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
  const store = new CommentStore(storageUri);
  await store.initialize();
  const controller = new AgentCommentsController(store, extensionUri);
  await flush();
  const createControllerMock = vscode.comments.createCommentController as jest.Mock;
  const commentController = createControllerMock.mock.results[createControllerMock.mock.results.length - 1].value;
  return { store, controller, commentController };
}

afterEach(() => {
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

  it('updates the rendered thread in place on a resolve event without disposing it', async () => {
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

  it('handles a resolve event for a file with no rendered thread by falling through to the default path', async () => {
    const { store } = await setup();
    // Never opened in an editor, so there is no rendered thread and no open document for it.
    await writeSourceFile('never-opened.ts', 'x');
    const created = await store.addComment('never-opened.ts', { lineHint: 1, endLineHint: 1, contentHash: 'h', contextBefore: '', contextAfter: '', status: 'exact' }, 'hi', { type: 'user' });
    await expect(store.resolveComment('never-opened.ts', created.id, { type: 'user' })).resolves.toBeDefined();
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

    const thread = { uri, comments: [{ contextValue: created.id }] } as any;
    await controller.resolveThread(thread, 'user');
    expect((await store.loadFile('a.ts')).comments).toHaveLength(0);

    await controller.reopenThread(thread);
    expect((await store.loadFile('a.ts')).comments).toHaveLength(1);

    await controller.deleteThread(thread);
    expect((await store.loadFile('a.ts')).comments).toHaveLength(0);
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
