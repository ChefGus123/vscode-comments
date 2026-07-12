import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Normalizes a filesystem URI to a workspace-relative, forward-slash path used as the stable
 * comment key. Only prefixed with the workspace folder name in multi-root workspaces (to avoid
 * same-named-file collisions across roots, §3) — single-root workspaces use the plain path, which
 * is also what MCP tool callers (agents) pass, so both sides must agree on this or comments
 * silently split into two different keys for the same file.
 */
export function toWorkspaceRelativePath(uri: vscode.Uri): string {
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const rel = vscode.workspace.asRelativePath(uri, multiRoot);
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

/**
 * Round-trips a caller-supplied path (as given by an MCP tool caller, in whatever form — OS-native
 * backslashes, a missing multi-root prefix, etc.) through the same resolution the UI uses, so both
 * sides provably agree on one storage key. Returns undefined if it can't be resolved to a file in
 * the current workspace at all.
 */
export function canonicalizeRelativePath(relativePath: string): string | undefined {
  const uri = resolveWorkspaceRelativePath(relativePath);
  if (!uri) {
    return undefined;
  }
  return toWorkspaceRelativePath(uri);
}
