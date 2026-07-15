import * as vscode from 'vscode';
import { CommentStore, StoreChangeEvent } from '../storage/store';
import { resolveWorkspaceRelativePath, toWorkspaceRelativePath } from '../storage/paths';
import { createAnchor, reanchor, shiftAnchorForChanges } from '../anchoring/anchor';
import { truncateSnippet, UI_SNIPPET_MAX_CHARS } from '../anchoring/snippet';
import { AnchorStatus, AuthorType, StoredComment } from '../types';

const DEBOUNCE_MS = 400;

function iconFor(authorType: AuthorType, status: AnchorStatus, extensionUri: vscode.Uri): vscode.Uri {
  const base = authorType === 'user' ? 'author-user' : 'author-agent';
  const suffix = status === 'exact' ? '' : status === 'approximate' ? '-dim' : '-orphaned';
  return vscode.Uri.joinPath(extensionUri, 'media', `${base}${suffix}.svg`);
}

function labelFor(status: AnchorStatus): string | undefined {
  if (status === 'approximate') {
    return 'Anchor: approximate match';
  }
  if (status === 'orphaned') {
    return 'Anchor: orphaned — original location not found';
  }
  return undefined;
}

interface RenderedThread {
  thread: vscode.CommentThread;
  commentId: string;
  status: StoredComment['status'];
}

/** Rendered `vscode.Comment` with extra fields the base interface doesn't provide: `contextValue`
 * is reused by VS Code for `comments/comment/title` menu gating (must equal exactly "editable" —
 * it can't double as an id), so the id and a back-reference to the owning thread live here instead. */
interface EditableComment extends vscode.Comment {
  id: string;
  parent?: vscode.CommentThread;
  /** Plain text (no markdown, no "*Originally:*" snippet suffix) shown while editing. */
  rawText: string;
}

export class AgentCommentsController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly threadsByFile = new Map<string, Map<string, RenderedThread>>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reanchoredOnOpen = new Set<string>();
  /** Comment ids currently in the gutter's editable textarea. Re-renders (onDidChangeVisibleTextEditors,
   * onStoreChanged, etc.) fire independently of that in-progress edit and must not rebuild these comments
   * via toVscodeComment — that would stomp CommentMode.Editing back to Preview mid-edit. */
  private readonly editingCommentIds = new Set<string>();
  private pendingDraftThread: vscode.CommentThread | undefined;

  constructor(private readonly store: CommentStore, private readonly extensionUri: vscode.Uri) {
    this.controller = vscode.comments.createCommentController('agentComments', 'Agentic Comments');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.uri.scheme !== 'file' || document.lineCount === 0) {
          return undefined;
        }
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };
    this.disposables.push(this.controller);

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.renderDocument(doc)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const e of editors) {
          this.renderDocument(e.document);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.evictIfHidden(doc)),
      store.onDidChangeFile((event) => this.onStoreChanged(event))
    );

    for (const document of vscode.workspace.textDocuments) {
      this.renderDocument(document);
    }
  }

  private findOpenDocument(filePath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (doc) => doc.uri.scheme === 'file' && toWorkspaceRelativePath(doc.uri) === filePath
    );
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async renderDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const filePath = toWorkspaceRelativePath(document.uri);

    // First time this file is opened in this session: re-validate anchors against the file's
    // current contents in case it was edited out-of-band (terminal/agent) while unopened —
    // onDidChangeTextDocument can't have told us since no editor was watching it (§4.1).
    if (!this.reanchoredOnOpen.has(filePath)) {
      this.reanchoredOnOpen.add(filePath);
      // reanchorIfFileChanged short-circuits via a whole-file hash when nothing changed while the
      // file was closed, so this only pays the per-comment window-scan cost when something did.
      await this.store.reanchorIfFileChanged(filePath, document.getText(), (comments) => {
        let changed = false;
        for (const comment of comments) {
          const updated = reanchor(document, comment.anchor);
          if (
            updated.lineHint !== comment.anchor.lineHint ||
            updated.endLineHint !== comment.anchor.endLineHint ||
            updated.status !== comment.anchor.status
          ) {
            comment.anchor = updated;
            comment.updatedAt = new Date().toISOString();
            changed = true;
          }
        }
        return changed;
      });
    }

    const data = await this.store.loadFile(filePath);
    this.syncThreads(document, filePath, data.comments);
  }

  private syncThreads(document: vscode.TextDocument, filePath: string, comments: StoredComment[]): void {
    let existing = this.threadsByFile.get(filePath);
    if (!existing) {
      existing = new Map();
      this.threadsByFile.set(filePath, existing);
    }

    const seen = new Set<string>();
    for (const comment of comments) {
      seen.add(comment.id);
      const rendered = existing.get(comment.id);
      const maxLine = Math.max(0, document.lineCount - 1);
      const rangeStart = Math.min(Math.max(0, comment.anchor.lineHint - 1), maxLine);
      const rangeEnd = Math.min(Math.max(rangeStart, comment.anchor.endLineHint - 1), maxLine);
      const range = new vscode.Range(rangeStart, 0, rangeEnd, 0);
      if (rendered) {
        rendered.thread.range = range;
        rendered.status = comment.status;
        this.updateThreadComment(rendered.thread, comment);
      } else {
        const vsComment = this.toVscodeComment(comment);
        const thread = this.controller.createCommentThread(document.uri, range, [vsComment]);
        vsComment.parent = thread;
        thread.canReply = false;
        thread.contextValue = comment.status;
        thread.label = labelFor(comment.anchor.status);
        existing.set(comment.id, { thread, commentId: comment.id, status: comment.status });
      }
    }

    // Resolved threads are kept visible (with a Reopen action) for the rest of this session even
    // though they've already moved out of the live JSON into the archive — see §7/§3.2.
    for (const [id, rendered] of existing) {
      if (!seen.has(id) && rendered.status !== 'resolved') {
        rendered.thread.dispose();
        existing.delete(id);
        this.editingCommentIds.delete(id);
      }
    }
  }

  /** Single choke point for rebuilding a rendered comment from its stored state. Skips comments
   * currently in the gutter's edit textarea (editingCommentIds) so callers never need to remember
   * that check themselves — centralized here instead of at each call site. */
  private updateThreadComment(thread: vscode.CommentThread, comment: StoredComment): void {
    if (this.editingCommentIds.has(comment.id)) {
      return;
    }
    thread.contextValue = comment.status;
    thread.label = labelFor(comment.anchor.status);
    const vsComment = this.toVscodeComment(comment);
    vsComment.parent = thread;
    thread.comments = [vsComment];
  }

  private commentBody(comment: StoredComment): vscode.MarkdownString {
    const { anchor } = comment;
    let value = comment.text;
    if (anchor.status !== 'exact' && anchor.originalContent) {
      const snippet = truncateSnippet(anchor.originalContent, UI_SNIPPET_MAX_CHARS);
      value += `\n\n---\n*Originally:*\n\`\`\`\n${snippet}\n\`\`\``;
    }
    return new vscode.MarkdownString(value);
  }

  private toVscodeComment(comment: StoredComment): EditableComment {
    return {
      body: this.commentBody(comment),
      mode: vscode.CommentMode.Preview,
      author: {
        name: comment.author.type === 'user' ? 'You' : 'Agent',
        iconPath: iconFor(comment.author.type, comment.anchor.status, this.extensionUri),
      },
      label: comment.status === 'resolved' ? `resolved by ${comment.resolvedBy?.type ?? 'unknown'}` : labelFor(comment.anchor.status),
      contextValue: comment.status === 'unresolved' ? 'editable' : undefined,
      id: comment.id,
      rawText: comment.text,
    };
  }

  private onStoreChanged(event: StoreChangeEvent): void {
    if (event.kind === 'clear') {
      for (const [, threads] of this.threadsByFile) {
        for (const [, rendered] of threads) {
          rendered.thread.dispose();
        }
      }
      this.threadsByFile.clear();
      this.editingCommentIds.clear();
      return;
    }

    if (event.kind === 'delete' && event.comment) {
      const threads = this.threadsByFile.get(event.filePath);
      const rendered = threads?.get(event.comment.id);
      if (rendered) {
        rendered.thread.dispose();
        threads?.delete(event.comment.id);
        this.editingCommentIds.delete(event.comment.id);
      }
      return;
    }

    if (event.kind === 'resolve' && event.comment) {
      const rendered = this.threadsByFile.get(event.filePath)?.get(event.comment.id);
      if (rendered) {
        rendered.status = 'resolved';
        rendered.thread.contextValue = 'resolved';
        // A resolve overrides any in-progress edit rather than deferring to it — once resolved, the
        // comment leaves the live JSON for good (until reopened), so nothing will ever revisit this
        // thread to apply a deferred rebuild. Clearing the guard lets it through immediately instead
        // of leaving the textarea stuck open with stale content for the rest of the session.
        this.editingCommentIds.delete(event.comment.id);
        this.updateThreadComment(rendered.thread, event.comment);
        return;
      }
    }

    if (event.kind === 'edit' && event.comment) {
      const rendered = this.threadsByFile.get(event.filePath)?.get(event.comment.id);
      if (rendered) {
        this.updateThreadComment(rendered.thread, event.comment);
        return;
      }
    }

    const document = this.findOpenDocument(event.filePath);
    if (document) {
      void this.renderDocument(document);
    } else {
      const threads = this.threadsByFile.get(event.filePath);
      if (threads) {
        for (const [, rendered] of threads) {
          rendered.thread.dispose();
        }
        this.threadsByFile.delete(event.filePath);
      }
    }
  }

  private evictIfHidden(document: vscode.TextDocument): void {
    if (this.pendingDraftThread && this.pendingDraftThread.uri.toString() === document.uri.toString()) {
      this.pendingDraftThread.dispose();
      this.pendingDraftThread = undefined;
    }

    const stillVisible = vscode.window.visibleTextEditors.some((e) => e.document === document);
    if (stillVisible || document.uri.scheme !== 'file') {
      return;
    }
    const filePath = toWorkspaceRelativePath(document.uri);
    const threads = this.threadsByFile.get(filePath);
    if (threads) {
      for (const [id, rendered] of threads) {
        rendered.thread.dispose();
        this.editingCommentIds.delete(id);
      }
      this.threadsByFile.delete(filePath);
    }
    this.reanchoredOnOpen.delete(filePath);
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
      return;
    }
    const filePath = toWorkspaceRelativePath(e.document.uri);
    const threads = this.threadsByFile.get(filePath);
    if (!threads || threads.size === 0) {
      return;
    }

    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const changes = e.contentChanges;
    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        void this.reanchorAfterChange(e.document, filePath, changes);
      }, DEBOUNCE_MS)
    );
  }

  private async reanchorAfterChange(
    document: vscode.TextDocument,
    filePath: string,
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): Promise<void> {
    await this.store.updateAnchors(filePath, (comments) => {
      let changed = false;
      for (const comment of comments) {
        const shifted = shiftAnchorForChanges(comment.anchor, changes);
        const anchor = shifted ?? reanchor(document, comment.anchor);
        if (
          anchor.lineHint !== comment.anchor.lineHint ||
          anchor.endLineHint !== comment.anchor.endLineHint ||
          anchor.status !== comment.anchor.status
        ) {
          comment.anchor = anchor;
          comment.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      return changed;
    });
  }

  async createComment(reply: vscode.CommentReply | undefined, authorType: AuthorType): Promise<void> {
    if (!reply?.thread) {
      vscode.window.showWarningMessage(
        'Agentic Comments: use the gutter "+" or select a range and choose "Add Comment" — this action only works from the comment input box.'
      );
      return;
    }
    if (reply.thread === this.pendingDraftThread) {
      this.pendingDraftThread = undefined;
    }
    if (!reply.text.trim()) {
      reply.thread.dispose();
      return;
    }
    const document = await vscode.workspace.openTextDocument(reply.thread.uri);
    const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
    const anchor = createAnchor(document, range.start.line, range.end.line);
    const filePath = toWorkspaceRelativePath(document.uri);
    await this.store.addComment(filePath, anchor, reply.text, { type: authorType });
    reply.thread.dispose();
  }

  /** Right-click "Add Comment": VS Code doesn't wire the gutter "+" flow into the context menu on
   * its own, so we drive the same public API (an empty-comments thread) ourselves. */
  addCommentAtSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      vscode.window.showWarningMessage('Agentic Comments: open a file to add a comment.');
      return;
    }
    this.pendingDraftThread?.dispose();

    const selection = editor.selection;
    const range = new vscode.Range(selection.start.line, 0, selection.end.line, 0);
    const thread = this.controller.createCommentThread(editor.document.uri, range, []);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.pendingDraftThread = thread;
  }

  async resolveThread(thread: vscode.CommentThread | undefined, resolvedByType: AuthorType): Promise<void> {
    const id = (thread?.comments[0] as EditableComment | undefined)?.id;
    if (!thread || !id) {
      vscode.window.showWarningMessage('Agentic Comments: use the Resolve button on a comment thread.');
      return;
    }
    const filePath = toWorkspaceRelativePath(thread.uri);
    await this.store.resolveComment(filePath, id, { type: resolvedByType });
  }

  async reopenThread(thread: vscode.CommentThread | undefined): Promise<void> {
    const id = (thread?.comments[0] as EditableComment | undefined)?.id;
    if (!thread || !id) {
      vscode.window.showWarningMessage('Agentic Comments: use the Reopen button on a resolved comment thread.');
      return;
    }
    const filePath = toWorkspaceRelativePath(thread.uri);
    await this.store.reopenComment(filePath, id);
  }

  async deleteThread(thread: vscode.CommentThread | undefined): Promise<void> {
    const id = (thread?.comments[0] as EditableComment | undefined)?.id;
    if (!thread || !id) {
      vscode.window.showWarningMessage('Agentic Comments: use the Delete button on a comment thread.');
      return;
    }
    const filePath = toWorkspaceRelativePath(thread.uri);
    await this.store.deleteComment(filePath, id);
  }

  /** Flips a comment into its editable textarea. Only reachable via the gutter's
   * comments/comment/title menu (gated on `comment == editable`), never via MCP or the tree view. */
  editComment(comment: vscode.Comment | undefined): void {
    const c = comment as EditableComment | undefined;
    if (!c?.parent) {
      vscode.window.showWarningMessage('Agentic Comments: use the Edit button on a comment.');
      return;
    }
    this.editingCommentIds.add(c.id);
    c.mode = vscode.CommentMode.Editing;
    c.body = c.rawText;
    // New array reference required — VS Code only re-renders comments on reference change.
    c.parent.comments = [...c.parent.comments];
  }

  async saveComment(comment: vscode.Comment | undefined): Promise<void> {
    const c = comment as EditableComment | undefined;
    if (!c?.parent) {
      vscode.window.showWarningMessage('Agentic Comments: use the Save button on a comment.');
      return;
    }
    const newText = typeof c.body === 'string' ? c.body : c.body.value;
    if (!newText.trim()) {
      // Blank save is treated as cancel, same as a blank reply in createComment.
      await this.cancelComment(comment);
      return;
    }
    // Must clear before persisting: the store write below fires an 'edit' StoreChangeEvent, and the
    // resulting re-render (onStoreChanged's dedicated 'edit' branch) needs the editingCommentIds
    // guard lifted to actually rebuild this comment in Preview mode.
    this.editingCommentIds.delete(c.id);
    const filePath = toWorkspaceRelativePath(c.parent.uri);
    const saved = await this.store.updateCommentText(filePath, c.id, newText);
    if (!saved) {
      // The comment was resolved or deleted elsewhere between opening the editor and clicking Save —
      // that concurrent change already updated (or disposed) this thread on its own; the only thing
      // left to do is let the user know their edit didn't get written anywhere.
      vscode.window.showWarningMessage(
        'Agentic Comments: could not save — this comment was resolved or deleted elsewhere.'
      );
    }
  }

  async cancelComment(comment: vscode.Comment | undefined): Promise<void> {
    const c = comment as EditableComment | undefined;
    if (!c?.parent) {
      vscode.window.showWarningMessage('Agentic Comments: use the Cancel button on a comment.');
      return;
    }
    // Must clear before rebuilding, same reason as saveComment — otherwise the editingCommentIds
    // guard blocks the very rebuild this method depends on to restore Preview mode.
    this.editingCommentIds.delete(c.id);
    // Store was never touched, so the live comment (if it's still there — it may have been resolved
    // or deleted concurrently, in which case that event already updated/disposed this thread and
    // there's nothing further to do here) still holds the original text; rebuild just this one thread
    // from it rather than re-rendering the whole document.
    const filePath = toWorkspaceRelativePath(c.parent.uri);
    const data = await this.store.loadFile(filePath);
    const stored = data.comments.find((sc) => sc.id === c.id);
    if (stored) {
      this.updateThreadComment(c.parent, stored);
    }
  }

  async revealComment(filePath: string | undefined, line: number | undefined, commentId?: string): Promise<void> {
    if (!filePath || !line) {
      return;
    }
    const target = resolveWorkspaceRelativePath(filePath);
    if (!target) {
      vscode.window.showWarningMessage(`Agentic Comments: could not resolve "${filePath}" in this workspace.`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(target);
    // Ensure threadsByFile is populated for this document before we look a thread up below —
    // renderDocument is idempotent, so calling it again here (it may already have run via the
    // onDidOpenTextDocument listener) is safe and closes the race between the two.
    await this.renderDocument(document);
    const editor = await vscode.window.showTextDocument(document);
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

    if (commentId) {
      const rendered = this.threadsByFile.get(filePath)?.get(commentId);
      if (rendered) {
        rendered.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
    }
  }
}
