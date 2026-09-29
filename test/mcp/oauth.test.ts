import * as vscode from 'vscode';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AgentCommentsOAuthProvider, MCP_OAUTH_SCOPE } from '../../src/mcp/oauth';

const resourceUrl = new URL('http://127.0.0.1:43123/mcp');
const client: OAuthClientInformationFull = {
  client_id: 'client-a',
  client_id_issued_at: 1,
  redirect_uris: ['http://127.0.0.1:4567/callback'],
  token_endpoint_auth_method: 'none',
};
const otherClient: OAuthClientInformationFull = { ...client, client_id: 'client-b' };

function memorySecrets(initial?: string): vscode.SecretStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set('oauth', initial);
  }
  return {
    values,
    get: jest.fn(async (key: string) => values.get(key)),
    store: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: jest.fn(async (key: string) => { values.delete(key); }),
    onDidChange: () => ({ dispose() {} }),
  } as vscode.SecretStorage & { values: Map<string, string> };
}

async function authorize(
  provider: AgentCommentsOAuthProvider,
  targetClient = client,
  overrides: Partial<Parameters<AgentCommentsOAuthProvider['authorize']>[1]> = {}
): Promise<string> {
  let location = '';
  await provider.authorize(targetClient, {
    codeChallenge: 'challenge',
    redirectUri: targetClient.redirect_uris[0],
    ...overrides,
  }, {
    redirect: (_status: number, value: string) => { location = value; },
  } as any);
  return new URL(location).searchParams.get('code')!;
}

describe('AgentCommentsOAuthProvider', () => {
  beforeEach(() => {
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Allow');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('persists clients and tokens, restores unexpired credentials, and omits expired credentials', async () => {
    const secrets = memorySecrets();
    const provider = new AgentCommentsOAuthProvider(secrets, 'oauth', resourceUrl);
    await provider.initialize();
    await provider.clientsStore.registerClient!(client as any);
    expect(await provider.clientsStore.getClient(client.client_id)).toEqual(client);

    const code = await authorize(provider, client, { state: 'state-1' });
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe('challenge');
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resourceUrl);
    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth).toMatchObject({ clientId: client.client_id, scopes: [MCP_OAUTH_SCOPE] });
    expect(auth.resource?.href).toBe(resourceUrl.href);

    const saved = JSON.parse(secrets.values.get('oauth')!);
    saved.accessTokens.push(['expired-access', {
      clientId: client.client_id,
      scopes: [MCP_OAUTH_SCOPE],
      resource: resourceUrl.href,
      expiresAt: Date.now() - 1,
    }]);
    saved.refreshTokens.push(['expired-refresh', {
      clientId: client.client_id,
      scopes: [MCP_OAUTH_SCOPE],
      resource: resourceUrl.href,
      expiresAt: Date.now() - 1,
    }]);
    saved.accessTokens.push(['other-resource-access', {
      clientId: client.client_id,
      scopes: [MCP_OAUTH_SCOPE],
      resource: 'http://127.0.0.1:43124/mcp',
      expiresAt: Date.now() + 60_000,
    }]);
    saved.refreshTokens.push(['other-resource-refresh', {
      clientId: client.client_id,
      scopes: [MCP_OAUTH_SCOPE],
      resource: 'http://127.0.0.1:43124/mcp',
      expiresAt: Date.now() + 60_000,
    }]);
    secrets.values.set('oauth', JSON.stringify(saved));

    const restored = new AgentCommentsOAuthProvider(secrets, 'oauth', resourceUrl);
    await restored.initialize();
    expect(await restored.clientsStore.getClient(client.client_id)).toEqual(client);
    await expect(restored.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({ clientId: client.client_id });
    await expect(restored.verifyAccessToken('expired-access')).rejects.toThrow('Invalid or expired');
    await expect(restored.verifyAccessToken('other-resource-access')).rejects.toThrow('Invalid or expired');
    expect(secrets.values.get('oauth')).not.toContain('other-resource-refresh');

    const refreshOnlyStale = JSON.parse(secrets.values.get('oauth')!);
    refreshOnlyStale.refreshTokens.push(['expired-refresh-only', {
      clientId: client.client_id,
      scopes: [MCP_OAUTH_SCOPE],
      resource: resourceUrl.href,
      expiresAt: Date.now() - 1,
    }]);
    secrets.values.set('oauth', JSON.stringify(refreshOnlyStale));
    await new AgentCommentsOAuthProvider(secrets, 'oauth', resourceUrl).initialize();
    await new AgentCommentsOAuthProvider(secrets, 'oauth', resourceUrl).initialize();
  });

  it('requires the user to approve authorization requests', async () => {
    const provider = new AgentCommentsOAuthProvider(memorySecrets(), 'oauth', resourceUrl);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await expect(authorize(provider)).rejects.toThrow('Authorization denied by the user');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      `Allow "${client.client_id}" to access Agentic Comments?`,
      { modal: true, detail: `Requested OAuth scope: ${MCP_OAUTH_SCOPE}` },
      'Allow'
    );
  });

  it('validates authorization codes, redirect URIs, resources, and scopes', async () => {
    const provider = new AgentCommentsOAuthProvider(memorySecrets(), 'oauth', resourceUrl);
    await expect(provider.clientsStore.registerClient!({
      ...client,
      token_endpoint_auth_method: undefined,
      client_secret: 'remove-me',
      client_secret_expires_at: 123,
    } as any)).rejects.toThrow('must explicitly be');
    await expect(provider.clientsStore.registerClient!({ ...client, token_endpoint_auth_method: 'client_secret_basic' } as any))
      .rejects.toThrow('must explicitly be');
    const publicClient = await provider.clientsStore.registerClient!({
      ...client,
      client_secret: 'remove-me',
      client_secret_expires_at: 123,
    } as any);
    expect(publicClient).toMatchObject({ token_endpoint_auth_method: 'none' });
    expect('client_secret' in publicClient).toBe(false);
    expect('client_secret_expires_at' in publicClient).toBe(false);
    await expect(provider.clientsStore.registerClient!({
      ...client,
      client_id: 'confidential',
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 'keep-me',
    } as any)).resolves.toMatchObject({ client_secret: 'keep-me' });

    await expect(authorize(provider, client, { scopes: ['other'] })).rejects.toThrow('Only mcp:tools');
    await expect(authorize(provider, client, { resource: new URL('http://127.0.0.1:43123/other') }))
      .rejects.toThrow('Expected resource');
    await expect(provider.challengeForAuthorizationCode(client, 'missing')).rejects.toThrow('Invalid or expired');

    const wrongClientCode = await authorize(provider);
    await expect(provider.challengeForAuthorizationCode(otherClient, wrongClientCode)).rejects.toThrow('Invalid or expired');

    jest.useFakeTimers({ now: Date.now() });
    const expiredCode = await authorize(provider);
    const prunedCode = await authorize(provider);
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    await expect(provider.challengeForAuthorizationCode(client, expiredCode)).rejects.toThrow('Invalid or expired');
    await authorize(provider);
    expect((provider as any).authorizationCodes.has(expiredCode)).toBe(false);
    expect((provider as any).authorizationCodes.has(prunedCode)).toBe(false);
    jest.useRealTimers();

    const redirectCode = await authorize(provider);
    await expect(provider.exchangeAuthorizationCode(client, redirectCode, undefined, 'http://127.0.0.1:4567/wrong'))
      .rejects.toThrow('redirect_uri');
    const missingRedirectCode = await authorize(provider);
    await expect(provider.exchangeAuthorizationCode(client, missingRedirectCode))
      .rejects.toThrow('redirect_uri');
    const missingResourceCode = await authorize(provider);
    await expect(provider.exchangeAuthorizationCode(client, missingResourceCode, undefined, client.redirect_uris[0]))
      .rejects.toThrow('resource');
    const resourceCode = await authorize(provider);
    await expect(provider.exchangeAuthorizationCode(client, resourceCode, undefined, client.redirect_uris[0], new URL('http://127.0.0.1:43123/other')))
      .rejects.toThrow('resource');

    const validCode = await authorize(provider, client, { scopes: [MCP_OAUTH_SCOPE], resource: resourceUrl });
    await expect(provider.exchangeAuthorizationCode(
      client,
      validCode,
      undefined,
      client.redirect_uris[0],
      resourceUrl
    )).resolves.toMatchObject({ token_type: 'Bearer', scope: MCP_OAUTH_SCOPE });
  });

  it('rotates refresh tokens, validates grants, expires access tokens, and revokes either token type', async () => {
    const secrets = memorySecrets();
    const provider = new AgentCommentsOAuthProvider(secrets, 'oauth', resourceUrl);
    const code = await authorize(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, client.redirect_uris[0], resourceUrl);

    await expect(provider.exchangeRefreshToken(client, 'missing')).rejects.toThrow('Invalid or expired');
    await expect(provider.exchangeRefreshToken(otherClient, tokens.refresh_token!)).rejects.toThrow('Invalid or expired');
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, ['other']))
      .rejects.toThrow('exceeds');
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!, undefined, new URL('http://127.0.0.1:43123/other')))
      .rejects.toThrow('resource');

    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!, [MCP_OAUTH_SCOPE], resourceUrl);
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('Invalid or expired');
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    const defaultRefresh = await provider.exchangeRefreshToken(client, refreshed.refresh_token!);
    expect(defaultRefresh.scope).toBe(MCP_OAUTH_SCOPE);

    const expiredRefresh = defaultRefresh.refresh_token!;
    (provider as any).refreshTokens.get(expiredRefresh).expiresAt = Date.now() - 1;
    await expect(provider.exchangeRefreshToken(client, expiredRefresh)).rejects.toThrow('Invalid or expired');
    expect((provider as any).refreshTokens.has(expiredRefresh)).toBe(false);

    (provider as any).accessTokens.get(tokens.access_token).expiresAt = Date.now() - 1;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow('Invalid or expired');

    const revocable = await provider.exchangeAuthorizationCode(
      client,
      await authorize(provider),
      undefined,
      client.redirect_uris[0],
      resourceUrl
    );
    await provider.revokeToken(otherClient, { token: revocable.access_token });
    await expect(provider.verifyAccessToken(revocable.access_token)).resolves.toMatchObject({ clientId: client.client_id });
    await provider.revokeToken(client, { token: revocable.access_token });
    await expect(provider.verifyAccessToken(revocable.access_token)).rejects.toThrow('Invalid or expired');
    await provider.revokeToken(otherClient, { token: revocable.refresh_token! });
    const afterForeignRevoke = await provider.exchangeRefreshToken(client, revocable.refresh_token!);
    await provider.revokeToken(client, { token: afterForeignRevoke.refresh_token! });
    await expect(provider.exchangeRefreshToken(client, afterForeignRevoke.refresh_token!)).rejects.toThrow('Invalid or expired');
    const storesBefore = (secrets.store as jest.Mock).mock.calls.length;
    await provider.revokeToken(client, { token: 'already-gone' });
    expect(secrets.store).toHaveBeenCalledTimes(storesBefore);
  });
});
