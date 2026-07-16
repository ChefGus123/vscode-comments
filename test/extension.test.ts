import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { AgentCommentsTreeProvider, CommentNode } from '../src/ui/treeView';
import { AgentCommentsMcpServer } from '../src/mcp/server';
import { CommentStore } from '../src/storage/store';

const mockVscode = vscode as unknown as { __reset(): void };
const repoUri = vscode.Uri.file('/repo');

function makeContext(storageUri: vscode.Uri | undefined) {
  return {
    storageUri,
    extensionUri: vscode.Uri.file('/ext'),
    subscriptions: [] as vscode.Disposable[],
  } as unknown as vscode.ExtensionContext;
}

function commandHandler(name: string): (...args: unknown[]) => Promise<void> {
  const registerCommand = vscode.commands.registerCommand as jest.Mock;
  const call = registerCommand.mock.calls.find(([n]) => n === name);
  if (!call) {
    throw new Error(`command not registered: ${name}`);
  }
  return call[1];
}

async function activateNormally() {
  vscode.workspace.workspaceFolders = [{ uri: repoUri, name: 'repo', index: 0 }];
  const context = makeContext(vscode.Uri.file('/storage'));
  await activate(context);
  return context;
}

afterEach(async () => {
  jest.restoreAllMocks();
  mockVscode.__reset();
});

describe('activate — no workspace storage', () => {
  it('warns and exits early when there is no context.storageUri', async () => {
    const context = makeContext(undefined);
    await activate(context);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('open a folder/workspace'));
    expect(vscode.window.registerTreeDataProvider).not.toHaveBeenCalled();
  });
});

describe('activate — normal wiring', () => {
  it('registers the tree view, decoration provider, and MCP server definition provider', async () => {
    const context = await activateNormally();
    expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith('agentCommentsView', expect.any(Object));
    expect(vscode.window.registerFileDecorationProvider).toHaveBeenCalled();

    const registerMcp = vscode.lm.registerMcpServerDefinitionProvider as jest.Mock;
    expect(registerMcp).toHaveBeenCalledWith('agentComments.mcpProvider', expect.any(Object));
    const provider = registerMcp.mock.calls[0][1];
    const defs = provider.provideMcpServerDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].uri.toString()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(defs[0].headers['x-agent-comments-token']).toEqual(expect.any(String));

    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('shows an error message when the MCP server fails to start', async () => {
    jest.spyOn(AgentCommentsMcpServer.prototype, 'start').mockRejectedValueOnce(new Error('port busy'));
    const context = await activateNormally();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('failed to start MCP server'));
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });
});

describe('wrapCommand error handling (via any registered command)', () => {
  it('reports the error stack when the handler throws a normal Error', async () => {
    jest.spyOn(AgentCommentsTreeProvider.prototype, 'refresh').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const context = await activateNormally();
    await commandHandler('agentComments.refreshTree')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('refreshTree'));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('boom'));
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('falls back to err.message when a thrown Error has no stack', async () => {
    jest.spyOn(AgentCommentsTreeProvider.prototype, 'refresh').mockImplementationOnce(() => {
      const err = new Error('no-stack-here');
      delete (err as { stack?: string }).stack;
      throw err;
    });
    const context = await activateNormally();
    await commandHandler('agentComments.refreshTree')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no-stack-here'));
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('stringifies a thrown non-Error value', async () => {
    jest.spyOn(AgentCommentsTreeProvider.prototype, 'refresh').mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain string failure';
    });
    const context = await activateNormally();
    await commandHandler('agentComments.refreshTree')();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('plain string failure'));
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });
});

describe('registered commands delegate to the right collaborator', () => {
  it('addComment / resolveComment / reopenComment / deleteComment / addCommentAtSelection delegate to the controller', async () => {
    const context = await activateNormally();
    await commandHandler('agentComments.addComment')(undefined);
    await commandHandler('agentComments.resolveComment')(undefined);
    await commandHandler('agentComments.reopenComment')(undefined);
    await commandHandler('agentComments.deleteComment')(undefined);
    commandHandler('agentComments.addCommentAtSelection')();
    // Each of these hits the controller's own "no thread/editor" warning path, proving the wiring runs end to end.
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('editComment / saveComment / cancelEditComment delegate to the controller', async () => {
    const context = await activateNormally();
    commandHandler('agentComments.editComment')(undefined);
    await commandHandler('agentComments.saveComment')(undefined);
    await commandHandler('agentComments.cancelEditComment')(undefined);
    // Each of these hits the controller's own "no parent comment" warning path, proving the wiring runs end to end.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(3);
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('revealComment forwards file/line/commentId to the controller', async () => {
    const context = await activateNormally();
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(repoUri, 'a.ts'), Buffer.from('one\ntwo', 'utf8'));
    await commandHandler('agentComments.revealComment')('a.ts', 1, undefined);
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('showResolved / hideResolved toggle the tree provider', async () => {
    const context = await activateNormally();
    const setShowResolvedSpy = jest.spyOn(AgentCommentsTreeProvider.prototype, 'setShowResolved');
    await commandHandler('agentComments.showResolved')();
    await commandHandler('agentComments.hideResolved')();
    expect(setShowResolvedSpy).toHaveBeenNthCalledWith(1, true);
    expect(setShowResolvedSpy).toHaveBeenNthCalledWith(2, false);
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('resolveCommentInTree / reopenCommentInTree / deleteCommentInTree no-op without a node and act on the store with one', async () => {
    const context = await activateNormally();
    await commandHandler('agentComments.resolveCommentInTree')(undefined);
    await commandHandler('agentComments.reopenCommentInTree')(undefined);
    await commandHandler('agentComments.deleteCommentInTree')(undefined);

    const resolveSpy = jest.spyOn(CommentStore.prototype, 'resolveComment').mockResolvedValue(undefined);
    const reopenSpy = jest.spyOn(CommentStore.prototype, 'reopenComment').mockResolvedValue(undefined);
    const deleteSpy = jest.spyOn(CommentStore.prototype, 'deleteComment').mockResolvedValue(undefined);
    const node: CommentNode = { kind: 'comment', comment: { id: 'c1', file: 'a.ts' } as any };
    await commandHandler('agentComments.resolveCommentInTree')(node);
    await commandHandler('agentComments.reopenCommentInTree')(node);
    await commandHandler('agentComments.deleteCommentInTree')(node);
    expect(resolveSpy).toHaveBeenCalledWith('a.ts', 'c1', { type: 'user' });
    expect(reopenSpy).toHaveBeenCalledWith('a.ts', 'c1');
    expect(deleteSpy).toHaveBeenCalledWith('a.ts', 'c1');
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });

  it('clearStorage clears the store only when the user confirms "Delete"', async () => {
    const context = await activateNormally();
    const clearAllSpy = jest.spyOn(CommentStore.prototype, 'clearAll').mockResolvedValue(undefined);

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await commandHandler('agentComments.clearStorage')();
    expect(clearAllSpy).not.toHaveBeenCalled();

    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Delete');
    await commandHandler('agentComments.clearStorage')();
    expect(clearAllSpy).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('cleared'));
    await Promise.all(context.subscriptions.map((d) => d.dispose()));
  });
});

describe('deactivate', () => {
  it('is a no-op', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
