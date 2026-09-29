import { randomBytes, randomUUID } from 'crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidClientMetadataError,
  AccessDeniedError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import * as vscode from 'vscode';

export const MCP_OAUTH_SCOPE = 'mcp:tools';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

interface AuthorizationCode {
  clientId: string;
  params: AuthorizationParams;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface StoredToken {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface StoredOAuthState {
  clients: OAuthClientInformationFull[];
  accessTokens: Array<[string, StoredToken]>;
  refreshTokens: Array<[string, StoredToken]>;
}

export class AgentCommentsOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, StoredToken>();
  private readonly refreshTokens = new Map<string, StoredToken>();
  private persistQueue = Promise.resolve();

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => this.clients.get(clientId),
    registerClient: async (client) => {
      const method = client.token_endpoint_auth_method;
      if (method !== 'none' && method !== 'client_secret_post') {
        throw new InvalidClientMetadataError(
          'token_endpoint_auth_method must explicitly be none or client_secret_post'
        );
      }
      const registered = { ...client, token_endpoint_auth_method: method } as OAuthClientInformationFull;
      if (method === 'none') {
        delete registered.client_secret;
        delete registered.client_secret_expires_at;
      }
      this.clients.set(registered.client_id, registered);
      await this.persist();
      return registered;
    },
  };

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly storageKey: string,
    private readonly resourceUrl: URL
  ) {}

  async initialize(): Promise<void> {
    const raw = await this.secrets.get(this.storageKey);
    if (!raw) {
      return;
    }
    const state = JSON.parse(raw) as StoredOAuthState;
    for (const client of state.clients) {
      this.clients.set(client.client_id, client);
    }
    const removedStaleAccessTokens = this.restoreTokens(this.accessTokens, state.accessTokens);
    const removedStaleRefreshTokens = this.restoreTokens(this.refreshTokens, state.refreshTokens);
    if (removedStaleAccessTokens || removedStaleRefreshTokens) {
      await this.persist();
    }
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Parameters<OAuthServerProvider['authorize']>[2]
  ): Promise<void> {
    for (const [code, stored] of this.authorizationCodes) {
      if (stored.expiresAt <= Date.now()) {
        this.authorizationCodes.delete(code);
      }
    }
    const scopes = params.scopes?.length ? params.scopes : [MCP_OAUTH_SCOPE];
    if (scopes.some((scope) => scope !== MCP_OAUTH_SCOPE)) {
      throw new InvalidScopeError(`Only ${MCP_OAUTH_SCOPE} is supported`);
    }
    const resource = params.resource ?? this.resourceUrl;
    this.assertResource(resource);
    const clientName = client.client_name ?? client.client_id;
    const choice = await vscode.window.showWarningMessage(
      `Allow "${clientName}" to access Agentic Comments?`,
      { modal: true, detail: `Requested OAuth scope: ${scopes.join(' ')}` },
      'Allow'
    );
    if (choice !== 'Allow') {
      throw new AccessDeniedError('Authorization denied by the user');
    }

    const code = randomUUID();
    this.authorizationCodes.set(code, {
      clientId: client.client_id,
      params,
      scopes,
      resource: resource.href,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) {
      redirect.searchParams.set('state', params.state);
    }
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    return this.getAuthorizationCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.getAuthorizationCode(client, authorizationCode);
    if (redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource?.href !== code.resource) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }
    this.authorizationCodes.delete(authorizationCode);
    return this.issueTokens(client.client_id, code.scopes, code.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const stored = this.refreshTokens.get(refreshToken);
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (stored.expiresAt <= Date.now()) {
      this.refreshTokens.delete(refreshToken);
      await this.persist();
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    const requestedScopes = scopes?.length ? scopes : stored.scopes;
    if (requestedScopes.some((scope) => !stored.scopes.includes(scope))) {
      throw new InvalidScopeError('Requested scope exceeds the original grant');
    }
    if (resource !== undefined && resource.href !== stored.resource) {
      throw new InvalidTargetError('resource does not match the original grant');
    }
    this.refreshTokens.delete(refreshToken);
    return this.issueTokens(client.client_id, requestedScopes, stored.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.accessTokens.get(token);
    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored) {
        this.accessTokens.delete(token);
        await this.persist();
      }
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: new URL(stored.resource),
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const access = this.accessTokens.get(request.token);
    const refresh = this.refreshTokens.get(request.token);
    const changed = (access?.clientId === client.client_id && this.accessTokens.delete(request.token)) ||
      (refresh?.clientId === client.client_id && this.refreshTokens.delete(request.token));
    if (changed) {
      await this.persist();
    }
  }

  private getAuthorizationCode(client: OAuthClientInformationFull, code: string): AuthorizationCode {
    const stored = this.authorizationCodes.get(code);
    if (stored?.expiresAt !== undefined && stored.expiresAt <= Date.now()) {
      this.authorizationCodes.delete(code);
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (!stored || stored.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return stored;
  }

  private assertResource(resource: URL): void {
    if (resource.href !== this.resourceUrl.href) {
      throw new InvalidTargetError(`Expected resource ${this.resourceUrl.href}`);
    }
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const now = Date.now();
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
    await this.persist();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  private restoreTokens(target: Map<string, StoredToken>, entries: Array<[string, StoredToken]>): boolean {
    let removed = false;
    for (const [token, data] of entries) {
      if (data.expiresAt > Date.now() && data.resource === this.resourceUrl.href) {
        target.set(token, data);
      } else {
        removed = true;
      }
    }
    return removed;
  }

  private persist(): Promise<void> {
    const state: StoredOAuthState = {
      clients: [...this.clients.values()],
      accessTokens: [...this.accessTokens.entries()],
      refreshTokens: [...this.refreshTokens.entries()],
    };
    this.persistQueue = this.persistQueue.then(() => this.secrets.store(this.storageKey, JSON.stringify(state)));
    return this.persistQueue;
  }
}
