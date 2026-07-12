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

async function writeJson(uri: vscode.Uri, data: unknown): Promise<void> {
  await ensureDir(vscode.Uri.joinPath(uri, '..'));
  const bytes = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  await vscode.workspace.fs.writeFile(uri, bytes);
}

async function appendJsonl(uri: vscode.Uri, record: unknown): Promise<void> {
  await ensureDir(vscode.Uri.joinPath(uri, '..'));
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

export type StoreChangeKind = 'add' | 'resolve' | 'reopen' | 'reanchor' | 'clear';

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

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(commentsDirUri(this.storageUri), name);
      const data = await readJson<FileCommentData>(uri);
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
    this.writeQueues.set(
      filePath,
      next.catch(() => undefined)
    );
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
          `Agent Comments: ${data.filePath} has ${unresolvedCount} unresolved comments. Consider resolving some.`
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

  async updateAnchors(filePath: string, updater: (comments: StoredComment[]) => boolean): Promise<void> {
    await this.queueWrite(filePath, async () => {
      const data = await this.loadFile(filePath);
      const changed = updater(data.comments);
      if (changed) {
        await this.persist(data, 'reanchor');
      }
    });
  }

  async listUnresolved(filePath?: string): Promise<ToolCommentView[]> {
    const filePaths = filePath ? [filePath] : Array.from(this.index.keys());
    const results: ToolCommentView[] = [];
    for (const fp of filePaths) {
      const data = await this.loadFile(fp);
      for (const c of data.comments) {
        if (c.status !== 'unresolved') {
          continue;
        }
        results.push(toView(fp, data.fileStatus, c));
      }
    }
    return results;
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
    const result = new Map<string, number>();
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(archiveDirUri(this.storageUri));
    } catch {
      entries = [];
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.jsonl')) {
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(archiveDirUri(this.storageUri), name));
        const lines = Buffer.from(bytes)
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0);
        if (lines.length === 0) {
          continue;
        }
        const first = JSON.parse(lines[0]) as ArchivedComment;
        result.set(first.filePath, lines.length);
      } catch {
        // skip unreadable/corrupt archive shard
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
    author: c.author,
    text: c.text,
    createdAt: c.createdAt,
    status: c.status,
    resolvedBy: c.resolvedBy,
  };
}
