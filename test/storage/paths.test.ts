import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  archiveDirUri,
  archiveFileUri,
  canonicalizeRelativePath,
  commentsDirUri,
  commentsFileUri,
  hashRelativePath,
  resolveWorkspaceRelativePath,
  toWorkspaceRelativePath,
} from '../../src/storage/paths';

const mockVscode = vscode as unknown as { __reset(): void };

afterEach(() => {
  mockVscode.__reset();
});

describe('toWorkspaceRelativePath', () => {
  it('returns a plain forward-slash relative path in a single-root workspace', () => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
    const uri = vscode.Uri.file('/repo/src/foo.ts');
    expect(toWorkspaceRelativePath(uri)).toBe('src/foo.ts');
  });

  it('treats an undefined workspaceFolders as zero folders (single-root style output)', () => {
    vscode.workspace.workspaceFolders = undefined;
    const uri = vscode.Uri.file('/repo/src/foo.ts');
    expect(toWorkspaceRelativePath(uri)).toBe('repo/src/foo.ts');
  });

  it('prefixes with the workspace folder name in a multi-root workspace', () => {
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/repoA'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repoB'), name: 'repoB', index: 1 },
    ];
    const uri = vscode.Uri.file('/repoB/src/foo.ts');
    expect(toWorkspaceRelativePath(uri)).toBe('repoB/src/foo.ts');
  });
});

describe('hashRelativePath', () => {
  it('produces a 32-char hex prefix of the sha256 digest', () => {
    const expected = crypto.createHash('sha256').update('src/foo.ts').digest('hex').slice(0, 32);
    expect(hashRelativePath('src/foo.ts')).toBe(expected);
    expect(hashRelativePath('src/foo.ts')).toHaveLength(32);
  });

  it('is stable for the same input and differs for different input', () => {
    expect(hashRelativePath('a')).toBe(hashRelativePath('a'));
    expect(hashRelativePath('a')).not.toBe(hashRelativePath('b'));
  });
});

describe('uri builders', () => {
  const storageUri = vscode.Uri.file('/storage');

  it('commentsFileUri builds comments/<hash>.json under the storage root', () => {
    const uri = commentsFileUri(storageUri, 'src/foo.ts');
    expect(uri.toString()).toBe(`file:///storage/comments/${hashRelativePath('src/foo.ts')}.json`);
  });

  it('archiveFileUri builds archive/<hash>.jsonl under the storage root', () => {
    const uri = archiveFileUri(storageUri, 'src/foo.ts');
    expect(uri.toString()).toBe(`file:///storage/archive/${hashRelativePath('src/foo.ts')}.jsonl`);
  });

  it('commentsDirUri / archiveDirUri point at the comments/ and archive/ subfolders', () => {
    expect(commentsDirUri(storageUri).toString()).toBe('file:///storage/comments');
    expect(archiveDirUri(storageUri).toString()).toBe('file:///storage/archive');
  });
});

describe('resolveWorkspaceRelativePath', () => {
  it('returns undefined when no workspace folder is open', () => {
    vscode.workspace.workspaceFolders = undefined;
    expect(resolveWorkspaceRelativePath('src/foo.ts')).toBeUndefined();
  });

  it('returns undefined when workspaceFolders is an empty array', () => {
    vscode.workspace.workspaceFolders = [];
    expect(resolveWorkspaceRelativePath('src/foo.ts')).toBeUndefined();
  });

  it('resolves against the single folder in a single-root workspace', () => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
    const uri = resolveWorkspaceRelativePath('src/foo.ts');
    expect(uri?.toString()).toBe('file:///repo/src/foo.ts');
  });

  it('normalizes OS-native backslashes before resolving', () => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
    const uri = resolveWorkspaceRelativePath('src\\foo.ts');
    expect(uri?.toString()).toBe('file:///repo/src/foo.ts');
  });

  it('strips a matching folder-name prefix in a multi-root workspace', () => {
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/repoA'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repoB'), name: 'repoB', index: 1 },
    ];
    const uri = resolveWorkspaceRelativePath('repoB/src/foo.ts');
    expect(uri?.toString()).toBe('file:///repoB/src/foo.ts');
  });

  it('falls back to the first folder in a multi-root workspace when the prefix does not match any folder name', () => {
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/repoA'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repoB'), name: 'repoB', index: 1 },
    ];
    const uri = resolveWorkspaceRelativePath('unknownRoot/src/foo.ts');
    expect(uri?.toString()).toBe('file:///repoA/unknownRoot/src/foo.ts');
  });

  it('falls back to the first folder when there is no slash in the path at all (multi-root)', () => {
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file('/repoA'), name: 'repoA', index: 0 },
      { uri: vscode.Uri.file('/repoB'), name: 'repoB', index: 1 },
    ];
    const uri = resolveWorkspaceRelativePath('toplevel.ts');
    expect(uri?.toString()).toBe('file:///repoA/toplevel.ts');
  });
});

describe('canonicalizeRelativePath', () => {
  it('round-trips a resolvable path back through toWorkspaceRelativePath', () => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/repo'), name: 'repo', index: 0 }];
    expect(canonicalizeRelativePath('src\\foo.ts')).toBe('src/foo.ts');
  });

  it('returns undefined when the path cannot be resolved (no workspace open)', () => {
    vscode.workspace.workspaceFolders = undefined;
    expect(canonicalizeRelativePath('src/foo.ts')).toBeUndefined();
  });
});
