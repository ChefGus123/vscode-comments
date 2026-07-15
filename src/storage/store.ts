import * as vscode from 'vscode';
import {
  Anchor,
  ArchivedComment,
  Author,
  FileCommentData,
  FileIndexEntry,
  StoredComment,
  ToolCommentView,
} from '../types';
import { archiveDirUri, archiveFileUri, commentsDirUri, commentsFileUri, resolveWorkspaceRelativePath } from './paths';
import { hashContent } from '../anchoring/hash';

const UNRESOLVED_WARNING_THRESHOLD = 200;
const CACHE_CAP = 50;

let idCounter = 0;
function generateId(): string {
  idCounter += 1;
  return `c_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch {
    // already exists
  }
}

// Note: no ensureDir here — comments/ and archive/ are created once in initialize(), which is
// always awaited before any write can happen, so re-checking on every single write is pure overhead.
async function writeJson(uri: vscode.Uri, data: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(uri, bytes);
}

async function appendJsonl(uri: vscode.Uri, record: unknown): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  let existing = '';
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    existing = Buffer.from(bytes).toString('utf8');
  } catch {
    existing = '';
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(existing + line, 'utf8'));
}

export type StoreChangeKind = 'add' | 'resolve' | 'reopen' | 'reanchor' | 'clear' | 'delete' | 'edit';

export interface StoreChangeEvent {
  filePath: string;
  kind: StoreChangeKind;
  comment?: StoredComment;
}

export class CommentStore {
  private readonly index = new Map<string, FileIndexEntry>();
  private readonly cache = new Map<string, FileCommentData>();
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<StoreChangeEvent>();
  /** Fires whenever a file's comment data changes; carries enough detail for UI to react without a full reload. */
  readonly onDidChangeFile = this.onDidChangeEmitter.event;

  constructor(private readonly storageUri: vscode.Uri) {}

  async initialize(): Promise<void> {
    await ensureDir(this.storageUri);
    await ensureDir(commentsDirUri(this.storageUri));
    await ensureDir(vscode.Uri.joinPath(this.storageUri, 'archive'));

    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(commentsDirUri(this.storageUri));
    } catch {
      entries = [];
    }

    const jsonFiles = entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'));
    const parsed = await Promise.all(
      jsonFiles.map(([name]) => readJson<FileCommentData>(vscode.Uri.joinPath(commentsDirUri(this.storageUri), name)))
    );
    for (const data of parsed) {
      if (!data) {
        continue;
      }
      const unresolvedCount = data.comments.filter((c) => c.status === 'unresolved').length;
      const lastModified = data.comments.reduce((max, c) => (c.updatedAt > max ? c.updatedAt : max), '');
      this.index.set(data.filePath, {
        unresolvedCount,
        lastModified,
        fileStatus: data.fileStatus,
      });
    }
  }

  getIndexSnapshot(): Map<string, FileIndexEntry> {
    return new Map(this.index);
  }

  private queueWrite<T>(filePath: string, op: () => Promise<T>): Promise<T> {
    const prior = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = prior.then(op, op);
    const settled = next.catch(() => undefined);
    this.writeQueues.set(filePath, settled);
    // Bound the map to files with a write actually in flight — otherwise it grows by one entry
    // per distinct file path ever touched for the life of the extension host (§2).
    void settled.then(() => {
      if (this.writeQueues.get(filePath) === settled) {
        this.writeQueues.delete(filePath);
      }
    });
    return next;
  }

  private touchCache(filePath: string, data: FileCommentData): void {
    this.cache.delete(filePath);
    this.cache.set(filePath, data);
    if (this.cache.size > CACHE_CAP) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  /** Loads (or lazily reads from disk) a file's live comment data, refreshing fileStatus as a side effect. */
  async loadFile(filePath: string): Promise<FileCommentData> {
    const cached = this.cache.get(filePath);
    if (cached) {
      this.touchCache(filePath, cached);
      return cached;
    }

    const uri = commentsFileUri(this.storageUri, filePath);
    const data = (await readJson<FileCommentData>(uri)) ?? { filePath, fileStatus: 'ok', comments: [] };

    const sourceUri = resolveWorkspaceRelativePath(filePath);
    const exists = sourceUri ? await fileExists(sourceUri) : false;
    data.fileStatus = exists ? 'ok' : 'file-not-found';

    this.touchCache(filePath, data);
    return data;
  }

  private async persist(data: FileCommentData, kind: StoreChangeKind, comment?: StoredComment): Promise<void> {
    const uri = commentsFileUri(this.storageUri, data.filePath);
    if (data.comments.length === 0) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // nothing to delete
      }
      this.index.delete(data.filePath);
      this.cache.delete(data.filePath);
    } else {
      await writeJson(uri, data);
      const unresolvedCount = data.comments.filter((c) => c.status === 'unresolved').length;
      const lastModified = data.comments.reduce((max, c) => (c.updatedAt > max ? c.updatedAt : max), '');
      this.index.set(data.filePath, { unresolvedCount, lastModified, fileStatus: data.fileStatus });
      this.touchCache(data.filePath, data);

      if (unresolvedCount > UNRESOLVED_WARNING_THRESHOLD) {
        vscode.window.showWarningMessage(
          `Agentic Comments: ${data.filePath} has ${unresolvedCount} unresolved comments. Consider resolving some.`
        );
      }
    }
    this.onDidChangeEmitter.fire({ filePath: data.filePath, kind, comment });
  }

  async addComment(
    filePath: string,
    anchor: Anchor,
    text: string,
    author: Author
  ): Promise<StoredComment> {
    return this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      const now = new Date().toISOString();
      const comment: StoredComment = {
        id: generateId(),
        anchor,
        author,
        text,
        status: 'unresolved',
        resolvedBy: null,
        createdAt: now,
        updatedAt: now,
      };
      data.comments.push(comment);
      await this.persist(data, 'add', comment);
      return comment;
    });
  }

  async resolveComment(filePath: string, id: string, resolvedBy: Author): Promise<StoredComment | undefined> {
    return this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      const idx = data.comments.findIndex((c) => c.id === id);
      if (idx === -1) {
        return undefined;
      }
      const comment = data.comments[idx];
      comment.status = 'resolved';
      comment.resolvedBy = resolvedBy;
      comment.updatedAt = new Date().toISOString();

      data.comments.splice(idx, 1);
      await appendJsonl(archiveFileUri(this.storageUri, filePath), {
        ...comment,
        filePath,
        archivedAt: comment.updatedAt,
      } as ArchivedComment);
      await this.persist(data, 'resolve', comment);
      return comment;
    });
  }

  /** Edits a live (unresolved) comment's text in place. Not applicable to resolved/archived
   * comments — edit is a gutter-only, unresolved-only affordance (never MCP-exposed). */
  async updateCommentText(filePath: string, id: string, text: string): Promise<StoredComment | undefined> {
    return this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      const idx = data.comments.findIndex((c) => c.id === id);
      if (idx === -1) {
        return undefined;
      }
      const comment = data.comments[idx];
      comment.text = text;
      comment.updatedAt = new Date().toISOString();
      await this.persist(data, 'edit', comment);
      return comment;
    });
  }

  async reopenComment(filePath: string, id: string): Promise<StoredComment | undefined> {
    return this.queueWrite(filePath, async () => {
      const archiveUri = archiveFileUri(this.storageUri, filePath);
      let archived: ArchivedComment[] = [];
      try {
        const bytes = await vscode.workspace.fs.readFile(archiveUri);
        const text = Buffer.from(bytes).toString('utf8');
        archived = text
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as ArchivedComment);
      } catch {
        archived = [];
      }
      const idx = archived.findIndex((c) => c.id === id);
      if (idx === -1) {
        return undefined;
      }
      const [comment] = archived.splice(idx, 1);
      await vscode.workspace.fs.writeFile(
        archiveUri,
        Buffer.from(archived.map((c) => JSON.stringify(c)).join('\n') + (archived.length ? '\n' : ''), 'utf8')
      );

      const { archivedAt: _archivedAt, filePath: _filePath, ...rest } = comment;
      const reopened: StoredComment = { ...rest, status: 'unresolved', resolvedBy: null, updatedAt: new Date().toISOString() };
      const data = await this.loadFile(filePath);
      data.comments.push(reopened);
      await this.persist(data, 'reopen', reopened);
      return reopened;
    });
  }

  /** Permanently removes a comment, whether it's still live (unresolved) or already archived (resolved). */
  async deleteComment(filePath: string, id: string): Promise<StoredComment | undefined> {
    return this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      const idx = data.comments.findIndex((c) => c.id === id);
      if (idx !== -1) {
        const [comment] = data.comments.splice(idx, 1);
        await this.persist(data, 'delete', comment);
        return comment;
      }

      const archiveUri = archiveFileUri(this.storageUri, filePath);
      let archived: ArchivedComment[] = [];
      try {
        const bytes = await vscode.workspace.fs.readFile(archiveUri);
        const text = Buffer.from(bytes).toString('utf8');
        archived = text
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as ArchivedComment);
      } catch {
        archived = [];
      }
      const archIdx = archived.findIndex((c) => c.id === id);
      if (archIdx === -1) {
        return undefined;
      }
      const [comment] = archived.splice(archIdx, 1);
      await vscode.workspace.fs.writeFile(
        archiveUri,
        Buffer.from(archived.map((c) => JSON.stringify(c)).join('\n') + (archived.length ? '\n' : ''), 'utf8')
      );
      this.onDidChangeEmitter.fire({ filePath, kind: 'delete', comment });
      return comment;
    });
  }

  async updateAnchors(filePath: string, updater: (comments: StoredComment[]) => boolean): Promise<void> {
    await this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      const changed = updater(data.comments);
      if (changed) {
        await this.persist(data, 'reanchor');
      }
    });
  }

  /**
   * Like updateAnchors, but skips the (potentially expensive, per-comment) reanchor callback
   * entirely when a whole-file content hash shows the file hasn't changed since the last check —
   * turning "first open in a session" from O(comments × window-scan) into one O(file size) hash
   * comparison in the common case where nothing happened while the file was closed (§4/§9).
   */
  async reanchorIfFileChanged(
    filePath: string,
    currentContent: string,
    updater: (comments: StoredComment[]) => boolean
  ): Promise<void> {
    const currentHash = hashContent(currentContent);
    await this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      if (data.contentHashAtLastCheck === currentHash) {
        return;
      }
      updater(data.comments);
      data.contentHashAtLastCheck = currentHash;
      await this.persist(data, 'reanchor');
    });
  }

  async listUnresolved(filePath?: string): Promise<ToolCommentView[]> {
    const filePaths = filePath ? [filePath] : Array.from(this.index.keys());
    const perFile = await Promise.all(
      filePaths.map(async (fp) => {
        const data = await this.loadFile(fp);
        return data.comments.filter((c) => c.status === 'unresolved').map((c) => toView(fp, data.fileStatus, c));
      })
    );
    return perFile.flat();
  }

  async getComments(filePath: string, includeResolved: boolean): Promise<ToolCommentView[]> {
    const data = await this.loadFile(filePath);
    const results: ToolCommentView[] = data.comments.map((c) => toView(filePath, data.fileStatus, c));

    if (includeResolved) {
      const archiveUri = archiveFileUri(this.storageUri, filePath);
      try {
        const bytes = await vscode.workspace.fs.readFile(archiveUri);
        const text = Buffer.from(bytes).toString('utf8');
        const archived = text
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as ArchivedComment);
        for (const c of archived) {
          results.push(toView(filePath, data.fileStatus, c));
        }
      } catch {
        // no archive yet
      }
    }
    return results;
  }

  /** Files that have any archived (resolved) comments, with the count in each — for the "show resolved" sidebar mode. */
  async listArchivedFilePaths(): Promise<Map<string, number>> {
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(archiveDirUri(this.storageUri));
    } catch {
      entries = [];
    }
    const shards = entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.jsonl'));

    const parsed = await Promise.all(
      shards.map(async ([name]) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(archiveDirUri(this.storageUri), name));
          const lines = Buffer.from(bytes)
            .toString('utf8')
            .split('\n')
            .filter((l) => l.trim().length > 0);
          if (lines.length === 0) {
            return undefined;
          }
          const first = JSON.parse(lines[0]) as ArchivedComment;
          return { filePath: first.filePath, count: lines.length };
        } catch {
          return undefined;
        }
      })
    );

    const result = new Map<string, number>();
    for (const entry of parsed) {
      if (entry) {
        result.set(entry.filePath, entry.count);
      }
    }
    return result;
  }

  async clearAll(): Promise<void> {
    this.index.clear();
    this.cache.clear();
    try {
      await vscode.workspace.fs.delete(this.storageUri, { recursive: true, useTrash: false });
    } catch {
      // nothing to delete
    }
    await this.initialize();
    this.onDidChangeEmitter.fire({ filePath: '*', kind: 'clear' });
  }
}

function toView(filePath: string, fileStatus: FileCommentData['fileStatus'], c: StoredComment): ToolCommentView {
  return {
    id: c.id,
    file: filePath,
    fileStatus,
    line: c.anchor.lineHint,
    endLine: c.anchor.endLineHint !== c.anchor.lineHint ? c.anchor.endLineHint : undefined,
    anchorStatus: c.anchor.status,
    originalContent: c.anchor.originalContent,
    author: c.author,
    text: c.text,
    createdAt: c.createdAt,
    status: c.status,
    resolvedBy: c.resolvedBy,
  };
}
