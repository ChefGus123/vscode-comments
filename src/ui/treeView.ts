import * as vscode from 'vscode';
import { CommentStore } from '../storage/store';
import { ToolCommentView } from '../types';

type Node = FileNode | CommentNode;

interface FileNode {
  kind: 'file';
  filePath: string;
  unresolvedCount: number;
  fileStatus: 'ok' | 'file-not-found';
}

interface CommentNode {
  kind: 'comment';
  comment: ToolCommentView;
}

export class AgentCommentsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly store: CommentStore) {
    store.onDidChangeFile(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.filePath, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.unresolvedCount}`;
      if (element.fileStatus === 'file-not-found') {
        item.iconPath = new vscode.ThemeIcon('warning');
        item.tooltip = 'File not found at this path — comments preserved, not auto-relocated.';
        item.contextValue = 'agentCommentsFileMissing';
      } else {
        item.iconPath = new vscode.ThemeIcon('file');
        item.contextValue = 'agentCommentsFile';
      }
      return item;
    }

    const { comment } = element;
    const item = new vscode.TreeItem(truncate(comment.text), vscode.TreeItemCollapsibleState.None);
    const lineLabel = comment.endLine ? `L${comment.line}-${comment.endLine}` : `L${comment.line}`;
    item.description = `${lineLabel} · ${comment.author.type}`;
    item.tooltip = new vscode.MarkdownString(
      `**${comment.author.type === 'user' ? 'You' : 'Agent'}** (${comment.anchorStatus})\n\n${comment.text}`
    );
    item.iconPath = new vscode.ThemeIcon(
      comment.anchorStatus === 'orphaned' ? 'warning' : comment.author.type === 'user' ? 'account' : 'hubot'
    );
    if (comment.fileStatus === 'ok') {
      item.command = {
        command: 'agentComments.revealComment',
        title: 'Reveal Comment',
        arguments: [comment.file, comment.line],
      };
    }
    item.contextValue = 'agentCommentsComment';
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      const index = this.store.getIndexSnapshot();
      const files: FileNode[] = Array.from(index.entries())
        .filter(([, entry]) => entry.unresolvedCount > 0)
        .map(
          ([filePath, entry]): FileNode => ({
            kind: 'file',
            filePath,
            unresolvedCount: entry.unresolvedCount,
            fileStatus: entry.fileStatus,
          })
        )
        .sort((a, b) => a.filePath.localeCompare(b.filePath));
      return files;
    }

    if (element.kind === 'file') {
      const comments = await this.store.listUnresolved(element.filePath);
      return comments
        .sort((a, b) => a.line - b.line)
        .map((comment) => ({ kind: 'comment' as const, comment }));
    }

    return [];
  }
}

function truncate(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}
