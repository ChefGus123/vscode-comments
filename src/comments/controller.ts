import * as vscode from 'vscode';
import { CommentStore, StoreChangeEvent } from '../storage/store';
import { resolveWorkspaceRelativePath, toWorkspaceRelativePath } from '../storage/paths';
import { createAnchor, reanchor, shiftAnchorForChange } from '../anchoring/anchor';
import { Anchor, AnchorStatus, AuthorType, StoredComment } from '../types';

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

export class AgentCommentsController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly threadsByFile = new Map<string, Map<string, RenderedThread>>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reanchoredOnOpen = new Set<string>();
  private pendingDraftThread: vscode.CommentThread | undefined;

  constructor(private readonly store: CommentStore, private readonly extensionUri: vscode.Uri) {
    this.controller = vscode.comments.createCommentController('agentComments', 'Agent Comments');
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
      await this.store.updateAnchors(filePath, (comments) => {
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
      const range = new vscode.Range(comment.anchor.lineHint - 1, 0, comment.anchor.endLineHint - 1, 0);
      if (rendered) {
        rendered.thread.range = range;
        rendered.status = comment.status;
        this.updateThreadComment(rendered.thread, comment);
      } else {
        const thread = this.controller.createCommentThread(document.uri, range, [
          this.toVscodeComment(comment),
        ]);
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
      }
    }
  }

  private updateThreadComment(thread: vscode.CommentThread, comment: StoredComment): void {
    thread.contextValue = comment.status;
    thread.label = labelFor(comment.anchor.status);
    thread.comments = [this.toVscodeComment(comment)];
  }

  private toVscodeComment(comment: StoredComment): vscode.Comment {
    return {
      body: new vscode.MarkdownString(comment.text),
      mode: vscode.CommentMode.Preview,
      author: {
        name: comment.author.type === 'user' ? 'You' : 'Agent',
        iconPath: iconFor(comment.author.type, comment.anchor.status, this.extensionUri),
      },
      label: comment.status === 'resolved' ? `resolved by ${comment.resolvedBy?.type ?? 'unknown'}` : labelFor(comment.anchor.status),
      contextValue: comment.id,
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
      return;
    }

    if (event.kind === 'resolve' && event.comment) {
      const rendered = this.threadsByFile.get(event.filePath)?.get(event.comment.id);
      if (rendered) {
        rendered.status = 'resolved';
        rendered.thread.contextValue = 'resolved';
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
    const stillVisible = vscode.window.visibleTextEditors.some((e) => e.document === document);
    if (stillVisible || document.uri.scheme !== 'file') {
      return;
    }
    const filePath = toWorkspaceRelativePath(document.uri);
    const threads = this.threadsByFile.get(filePath);
    if (threads) {
      for (const [, rendered] of threads) {
        rendered.thread.dispose();
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
        let anchor: Anchor | undefined = comment.anchor;
        for (const change of changes) {
          if (!anchor) {
            break;
          }
          anchor = shiftAnchorForChange(anchor, change);
        }
        if (!anchor) {
          anchor = reanchor(document, comment.anchor);
        }
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
        'Agent Comments: use the gutter "+" or select a range and choose "Add Comment" — this action only works from the comment input box.'
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
      vscode.window.showWarningMessage('Agent Comments: open a file to add a comment.');
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
    const id = thread?.comments[0]?.contextValue;
    if (!thread || !id) {
      vscode.window.showWarningMessage('Agent Comments: use the Resolve button on a comment thread.');
      return;
    }
    const filePath = toWorkspaceRelativePath(thread.uri);
    await this.store.resolveComment(filePath, id, { type: resolvedByType });
  }

  async reopenThread(thread: vscode.CommentThread | undefined): Promise<void> {
    const id = thread?.comments[0]?.contextValue;
    if (!thread || !id) {
      vscode.window.showWarningMessage('Agent Comments: use the Reopen button on a resolved comment thread.');
      return;
    }
    const filePath = toWorkspaceRelativePath(thread.uri);
    await this.store.reopenComment(filePath, id);
  }

  async revealComment(filePath: string | undefined, line: number | undefined, commentId?: string): Promise<void> {
    if (!filePath || !line) {
      return;
    }
    const target = resolveWorkspaceRelativePath(filePath);
    if (!target) {
      vscode.window.showWarningMessage(`Agent Comments: could not resolve "${filePath}" in this workspace.`);
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
