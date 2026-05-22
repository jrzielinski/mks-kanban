/**
 * OAuth 2.1 Authorization Code + PKCE loopback flow.
 *
 * Usage:
 *   const result = await startOAuthFlow(identityUrl, 'mks-kanban', shell.openExternal)
 *
 * Requires mks-identity to expose:
 *   GET  /oauth/authorize   — redirect to user login, then back to redirect_uri?code=...
 *   POST /api/v1/oauth/token — exchange code+verifier for { token, refreshToken, tokenExpires, user }
 */
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

function httpPost(
  urlStr: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        method: 'POST',
        host: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('token exchange timed out')));
    req.write(payload);
    req.end();
  });
}

export interface OAuthResult {
  accessToken: string;
  refreshToken: string;
  /** Unix timestamp (seconds) when the access token expires. */
  tokenExpires: number;
  user: Record<string, unknown>;
}

/**
 * Start the loopback OAuth flow.
 *
 * @param identityUrl  Base URL of mks-identity, e.g. "http://localhost:3030"
 * @param clientId     OAuth client_id registered in mks-identity
 * @param openUrl      Called with the authorization URL — typically `shell.openExternal`
 */
export async function startOAuthFlow(
  identityUrl: string,
  clientId: string,
  openUrl: (url: string) => void,
): Promise<OAuthResult> {
  const port = await pickFreePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  const state = base64url(crypto.randomBytes(16));

  const authUrl = new URL('/oauth/authorize', identityUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');

      const html = (msg: string) =>
        `<html><body style="font-family:sans-serif;padding:40px"><h2>${msg}</h2><p>You can close this window and return to MakeStudio Kanban.</p></body></html>`;

      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(html(`Login failed: ${oauthError}`));
        server.close();
        reject(new Error(`oauth error: ${oauthError}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(html('Invalid state parameter.'));
        server.close();
        reject(new Error('state mismatch'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(html('No authorization code received.'));
        server.close();
        reject(new Error('no code in callback'));
        return;
      }

      try {
        const data = (await httpPost(`${identityUrl}/api/v1/oauth/token`, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          client_id: clientId,
        })) as any;

        res.writeHead(200, { 'Content-Type': 'text/html' }).end(html('Login successful!'));
        server.close();
        resolve({
          accessToken: data.token,
          refreshToken: data.refreshToken,
          tokenExpires: data.tokenExpires,
          user: data.user,
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' }).end(html('Token exchange failed.'));
        server.close();
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => openUrl(authUrl.toString()));
    server.on('error', reject);
  });
}
