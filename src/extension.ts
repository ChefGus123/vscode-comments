import * as vscode from 'vscode';
import { CommentStore } from './storage/store';
import { AgentCommentsController } from './comments/controller';
import { AgentCommentsTreeProvider, CommentNode } from './ui/treeView';
import { AgentCommentsDecorationProvider } from './ui/decorations';
import { AgentCommentsMcpServer, AUTH_HEADER } from './mcp/server';

function wrapCommand<Args extends unknown[]>(
  name: string,
  handler: (...args: Args) => unknown
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      vscode.window.showErrorMessage(`Agentic Comments: "${name}" failed — ${message}`);
    }
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!context.storageUri) {
    vscode.window.showWarningMessage(
      'Agentic Comments: open a folder/workspace to use inline comments (no storage location without one).'
    );
    return;
  }

  const store = new CommentStore(context.storageUri);
  await store.initialize();

  const controller = new AgentCommentsController(store, context.extensionUri);
  context.subscriptions.push(controller);

  const treeProvider = new AgentCommentsTreeProvider(store);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('agentCommentsView', treeProvider));

  const decorationProvider = new AgentCommentsDecorationProvider(store);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

  const mcpServer = new AgentCommentsMcpServer(store);
  context.subscriptions.push(mcpServer);
  try {
    const port = await mcpServer.start();
    const onDidChangeMcpServerDefinitionsEmitter = new vscode.EventEmitter<void>();
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('agentComments.mcpProvider', {
        onDidChangeMcpServerDefinitions: onDidChangeMcpServerDefinitionsEmitter.event,
        provideMcpServerDefinitions: () => [
          new vscode.McpHttpServerDefinition(
            'Agentic Comments',
            vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`),
            { [AUTH_HEADER]: mcpServer.token }
          ),
        ],
      })
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Agentic Comments: failed to start MCP server: ${String(err)}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agentComments.addComment',
      wrapCommand('addComment', (reply?: vscode.CommentReply) => controller.createComment(reply, 'user'))
    ),
    vscode.commands.registerCommand(
      'agentComments.resolveComment',
      wrapCommand('resolveComment', (thread?: vscode.CommentThread) => controller.resolveThread(thread, 'user'))
    ),
    vscode.commands.registerCommand(
      'agentComments.reopenComment',
      wrapCommand('reopenComment', (thread?: vscode.CommentThread) => controller.reopenThread(thread))
    ),
    vscode.commands.registerCommand(
      'agentComments.deleteComment',
      wrapCommand('deleteComment', (thread?: vscode.CommentThread) => controller.deleteThread(thread))
    ),
    vscode.commands.registerCommand(
      'agentComments.revealComment',
      wrapCommand('revealComment', (file?: string, line?: number, commentId?: string) =>
        controller.revealComment(file, line, commentId)
      )
    ),
    vscode.commands.registerCommand(
      'agentComments.addCommentAtSelection',
      wrapCommand('addCommentAtSelection', () => controller.addCommentAtSelection())
    ),
    vscode.commands.registerCommand(
      'agentComments.refreshTree',
      wrapCommand('refreshTree', () => treeProvider.refresh())
    ),
    vscode.commands.registerCommand(
      'agentComments.showResolved',
      wrapCommand('showResolved', () => treeProvider.setShowResolved(true))
    ),
    vscode.commands.registerCommand(
      'agentComments.hideResolved',
      wrapCommand('hideResolved', () => treeProvider.setShowResolved(false))
    ),
    vscode.commands.registerCommand(
      'agentComments.resolveCommentInTree',
      wrapCommand('resolveCommentInTree', (node?: CommentNode) =>
        node ? store.resolveComment(node.comment.file, node.comment.id, { type: 'user' }) : undefined
      )
    ),
    vscode.commands.registerCommand(
      'agentComments.reopenCommentInTree',
      wrapCommand('reopenCommentInTree', (node?: CommentNode) =>
        node ? store.reopenComment(node.comment.file, node.comment.id) : undefined
      )
    ),
    vscode.commands.registerCommand(
      'agentComments.deleteCommentInTree',
      wrapCommand('deleteCommentInTree', (node?: CommentNode) =>
        node ? store.deleteComment(node.comment.file, node.comment.id) : undefined
      )
    ),
    vscode.commands.registerCommand(
      'agentComments.clearStorage',
      wrapCommand('clearStorage', async () => {
        const choice = await vscode.window.showWarningMessage(
          'Delete all Agentic Comments data for this workspace? This cannot be undone.',
          { modal: true },
          'Delete'
        );
        if (choice === 'Delete') {
          await store.clearAll();
          vscode.window.showInformationMessage('Agentic Comments: workspace comment data cleared.');
        }
      })
    )
  );
}

export function deactivate(): void {
  // All resources are disposed via context.subscriptions.
}
