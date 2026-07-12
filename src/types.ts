export type AuthorType = 'user' | 'agent';

export interface Author {
  type: AuthorType;
}

export type AnchorStatus = 'exact' | 'approximate' | 'orphaned';

export interface Anchor {
  lineHint: number;
  endLineHint: number;
  contentHash: string;
  contextBefore: string;
  contextAfter: string;
  status: AnchorStatus;
}

export type CommentStatus = 'unresolved' | 'resolved';

export type FileStatus = 'ok' | 'file-not-found';

export interface StoredComment {
  id: string;
  anchor: Anchor;
  author: Author;
  text: string;
  status: CommentStatus;
  resolvedBy: Author | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileCommentData {
  filePath: string;
  fileStatus: FileStatus;
  comments: StoredComment[];
  /** Whole-file content hash as of the last first-open reanchor check — lets a reopen skip
   * per-comment re-anchoring entirely when the file hasn't changed since we last looked (§4/§9). */
  contentHashAtLastCheck?: string;
}

export interface ArchivedComment extends StoredComment {
  filePath: string;
  archivedAt: string;
}

export interface FileIndexEntry {
  unresolvedCount: number;
  lastModified: string;
  fileStatus: FileStatus;
}

export interface ToolCommentView {
  id: string;
  file: string;
  fileStatus: FileStatus;
  line: number;
  endLine?: number;
  anchorStatus: AnchorStatus;
  author: Author;
  text: string;
  createdAt: string;
  status?: CommentStatus;
  resolvedBy?: Author | null;
}
