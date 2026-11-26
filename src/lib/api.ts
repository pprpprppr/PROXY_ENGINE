import type { ServerBootstrapConfig } from '../types/proxy';

let sessionToken: string | null = null;
let bootstrapPromise: Promise<ServerBootstrapConfig> | null = null;

export async function bootstrapSession(): Promise<ServerBootstrapConfig> {
  if (!bootstrapPromise) {
    bootstrapPromise = fetch('/api/bootstrap', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Bootstrap failed (${res.status})`);
        }
        const data = (await res.json()) as ServerBootstrapConfig;
        sessionToken = data.token;
        return data;
      })
      .catch((err) => {
        bootstrapPromise = null;
        throw err;
      });
  }
  return bootstrapPromise;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!sessionToken) {
    await bootstrapSession();
  }
  const headers = new Headers(init.headers);
  if (sessionToken) {
    headers.set('X-ProxySuite-Token', sessionToken);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // Re-bootstrap once in case server restarted
    bootstrapPromise = null;
    await bootstrapSession();
    if (sessionToken) {
      headers.set('X-ProxySuite-Token', sessionToken);
    }
    return fetch(input, { ...init, headers });
  }
  return res;
}

export function getAuthenticatedDownloadUrl(basePath: string): string {
  const sep = basePath.includes('?') ? '&' : '?';
  return sessionToken ? `${basePath}${sep}token=${encodeURIComponent(sessionToken)}` : basePath;
}

export function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${protocol}//${window.location.host}/api/ws`;
  return sessionToken ? `${base}?token=${encodeURIComponent(sessionToken)}` : base;
}
