import * as vscode from 'vscode';
import { CommentStore } from '../storage/store';
import { resolveWorkspaceRelativePath, toWorkspaceRelativePath } from '../storage/paths';

export class AgentCommentsDecorationProvider implements vscode.FileDecorationProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;

  constructor(private readonly store: CommentStore) {
    store.onDidChangeFile((event) => {
      if (event.filePath === '*') {
        this.onDidChangeEmitter.fire(undefined);
        return;
      }
      const uri = resolveWorkspaceRelativePath(event.filePath);
      if (uri) {
        this.onDidChangeEmitter.fire(uri);
      }
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const filePath = toWorkspaceRelativePath(uri);
    const entry = this.store.getIndexSnapshot().get(filePath);
    if (!entry || entry.unresolvedCount === 0) {
      return undefined;
    }
    if (entry.fileStatus === 'file-not-found') {
      return {
        badge: '!',
        color: new vscode.ThemeColor('problemsWarningIcon.foreground'),
        tooltip: 'Agent Comments: file missing, comments preserved',
      };
    }
    return {
      badge: entry.unresolvedCount > 9 ? '9+' : `${entry.unresolvedCount}`,
      color: new vscode.ThemeColor('problemsInfoIcon.foreground'),
      tooltip: `${entry.unresolvedCount} unresolved comment${entry.unresolvedCount === 1 ? '' : 's'}`,
    };
  }
}
