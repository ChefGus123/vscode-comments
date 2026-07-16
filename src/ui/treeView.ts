import * as vscode from 'vscode';
import { CommentStore } from '../storage/store';
import { formatOriginalSnippet, UI_SNIPPET_MAX_CHARS } from '../anchoring/snippet';
import { ToolCommentView } from '../types';

type Node = FileNode | CommentNode;

interface FileNode {
  kind: 'file';
  filePath: string;
  unresolvedCount: number;
  fileStatus: 'ok' | 'file-not-found';
}

export interface CommentNode {
  kind: 'comment';
  comment: ToolCommentView;
}

const SHOW_RESOLVED_CONTEXT_KEY = 'agentComments.showResolved';

export class AgentCommentsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private showResolved = false;

  constructor(private readonly store: CommentStore) {
    store.onDidChangeFile(() => this.refresh());
    void vscode.commands.executeCommand('setContext', SHOW_RESOLVED_CONTEXT_KEY, false);
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  setShowResolved(value: boolean): void {
    this.showResolved = value;
    void vscode.commands.executeCommand('setContext', SHOW_RESOLVED_CONTEXT_KEY, value);
    this.refresh();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.filePath, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.unresolvedCount} unresolved`;
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
    const descriptionParts = [lineLabel, comment.author.type];
    if (comment.status === 'resolved') {
      descriptionParts.push(`resolved by ${comment.resolvedBy?.type ?? 'unknown'}`);
    }
    item.description = descriptionParts.join(' · ');
    let tooltipValue = `**${comment.author.type === 'user' ? 'You' : 'Agent'}** (${comment.anchorStatus})\n\n${comment.text}`;
    if (comment.anchorStatus !== 'exact' && comment.originalContent) {
      tooltipValue += formatOriginalSnippet(comment.originalContent, UI_SNIPPET_MAX_CHARS);
    }
    item.tooltip = new vscode.MarkdownString(tooltipValue);
    if (comment.status === 'resolved') {
      item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    } else if (comment.anchorStatus === 'orphaned') {
      item.iconPath = new vscode.ThemeIcon('warning');
    } else {
      item.iconPath = new vscode.ThemeIcon(comment.author.type === 'user' ? 'account' : 'hubot');
    }
    if (comment.fileStatus === 'ok') {
      item.command = {
        command: 'agentComments.revealComment',
        title: 'Reveal Comment',
        arguments: [comment.file, comment.line, comment.id],
      };
    }
    item.contextValue = comment.status === 'resolved' ? 'agentCommentsCommentResolved' : 'agentCommentsCommentUnresolved';
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      const fileMap = new Map<string, FileNode>();
      for (const [filePath, entry] of this.store.getIndexSnapshot()) {
        fileMap.set(filePath, {
          kind: 'file',
          filePath,
          unresolvedCount: entry.unresolvedCount,
          fileStatus: entry.fileStatus,
        });
      }

      if (this.showResolved) {
        const archived = await this.store.listArchivedFilePaths();
        const missing = Array.from(archived.keys()).filter((fp) => !fileMap.has(fp));
        const loaded = await Promise.all(missing.map((fp) => this.store.loadFile(fp)));
        for (const data of loaded) {
          fileMap.set(data.filePath, { kind: 'file', filePath: data.filePath, unresolvedCount: 0, fileStatus: data.fileStatus });
        }
      }

      return Array.from(fileMap.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
    }

    if (element.kind === 'file') {
      const comments = this.showResolved
        ? await this.store.getComments(element.filePath, true)
        : await this.store.listUnresolved(element.filePath);
      return comments.sort((a, b) => a.line - b.line).map((comment) => ({ kind: 'comment' as const, comment }));
    }

    return [];
  }
}

function truncate(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}
