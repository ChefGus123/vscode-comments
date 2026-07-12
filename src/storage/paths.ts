import * as crypto from 'crypto';
import * as vscode from 'vscode';

/** Normalizes a filesystem URI to a workspace-relative, forward-slash path used as the stable comment key. */
export function toWorkspaceRelativePath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, true);
  return rel.replace(/\\/g, '/');
}

export function hashRelativePath(relativePath: string): string {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 32);
}

export function commentsFileUri(storageUri: vscode.Uri, relativePath: string): vscode.Uri {
  const hash = hashRelativePath(relativePath);
  return vscode.Uri.joinPath(storageUri, 'comments', `${hash}.json`);
}

export function archiveFileUri(storageUri: vscode.Uri, relativePath: string): vscode.Uri {
  const hash = hashRelativePath(relativePath);
  return vscode.Uri.joinPath(storageUri, 'archive', `${hash}.jsonl`);
}

export function commentsDirUri(storageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, 'comments');
}

export function archiveDirUri(storageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, 'archive');
}

/** Resolves a workspace-relative path (as used by comment storage/MCP tools) back to an absolute file URI. */
export function resolveWorkspaceRelativePath(relativePath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const slashIdx = normalized.indexOf('/');
  if (folders.length > 1 && slashIdx > 0) {
    const maybeFolderName = normalized.slice(0, slashIdx);
    const match = folders.find((f) => f.name === maybeFolderName);
    if (match) {
      return vscode.Uri.joinPath(match.uri, normalized.slice(slashIdx + 1));
    }
  }
  return vscode.Uri.joinPath(folders[0].uri, normalized);
}
