import * as vscode from 'vscode';
import { CommentStore } from './storage/store';
import { AgentCommentsController } from './comments/controller';
import { AgentCommentsTreeProvider } from './ui/treeView';
import { AgentCommentsDecorationProvider } from './ui/decorations';
import { AgentCommentsMcpServer } from './mcp/server';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!context.storageUri) {
    vscode.window.showWarningMessage(
      'Agent Comments: open a folder/workspace to use inline comments (no storage location without one).'
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
          new vscode.McpHttpServerDefinition('Agent Comments', vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`)),
        ],
      })
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Agent Comments: failed to start MCP server: ${String(err)}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('agentComments.addComment', (reply: vscode.CommentReply) =>
      controller.createComment(reply, 'user')
    ),
    vscode.commands.registerCommand('agentComments.resolveComment', (thread: vscode.CommentThread) =>
      controller.resolveThread(thread, 'user')
    ),
    vscode.commands.registerCommand('agentComments.reopenComment', (thread: vscode.CommentThread) =>
      controller.reopenThread(thread)
    ),
    vscode.commands.registerCommand('agentComments.revealComment', (file: string, line: number) =>
      controller.revealComment(file, line)
    ),
    vscode.commands.registerCommand('agentComments.refreshTree', () => treeProvider.refresh()),
    vscode.commands.registerCommand('agentComments.clearStorage', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Delete all Agent Comments data for this workspace? This cannot be undone.',
        { modal: true },
        'Delete'
      );
      if (choice === 'Delete') {
        await store.clearAll();
        vscode.window.showInformationMessage('Agent Comments: workspace comment data cleared.');
      }
    })
  );
}

export function deactivate(): void {
  // All resources are disposed via context.subscriptions.
}
