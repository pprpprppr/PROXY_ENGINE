import dotenv from 'dotenv';
dotenv.config();

import http from 'node:http';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, type AppConfig } from './server/config.js';
import { DatabaseClient } from './server/db/databaseClient.js';
import { ProxyEngine } from './server/proxy/mitmEngine.js';
import { GeminiSecurityService } from './server/ai/geminiService.js';
import { IntruderEngine } from './server/proxy/intruderEngine.js';
import { createLocalSecurityMiddleware, verifyWebSocketUpgradeRequest } from './server/security.js';
import { createApiRouter } from './server/routes/apiRouter.js';
import { logEvent } from './server/logger.js';

export interface AppRuntime {
  config: AppConfig;
  db: DatabaseClient;
  proxy: ProxyEngine;
  server: http.Server;
  uiPort: number;
  proxyPort: number;
  shutdown: () => Promise<void>;
}

export async function startProxySuiteServer(overrides?: Partial<AppConfig>): Promise<AppRuntime> {
  const baseConfig = loadConfig();
  const config: AppConfig = {
    ...baseConfig,
    ...overrides,
    defaults: {
      ...baseConfig.defaults,
      ...(overrides?.defaults || {}),
    },
  };

  // Monitor event loop lag without high-frequency timers
  const elHistogram = monitorEventLoopDelay({ resolution: 20 });
  elHistogram.enable();

  const db = new DatabaseClient(config.dbPath, config.legacyJsonDbPath);
  await db.waitUntilReady();

  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);

  let boundUiPort = config.port;
  let boundProxyPort = config.proxyPort;

  const uiClients = new Set<WebSocket>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.wsMaxPayloadBytes,
  });

  const broadcastToUI = (messageType: string, payload: unknown) => {
    if (uiClients.size === 0) return;
    let uiPayload = payload;
    if (messageType === 'requestCaptured' || messageType === 'PENDING_REVIEW') {
      const p = payload as Record<string, unknown>;
      uiPayload = {
        ...p,
        headers: p.req_headers || p.headers,
        body: p.req_body || p.body,
      };
    }
    const serialized = JSON.stringify({ type: messageType, payload: uiPayload });
    for (const client of uiClients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 4 * 1024 * 1024) {
        client.send(serialized);
      }
    }
  };

  const proxy = new ProxyEngine(config, db, broadcastToUI);
  await proxy.init();

  const gemini = new GeminiSecurityService(config);
  const intruder = new IntruderEngine(broadcastToUI);

  server.on('upgrade', (req, socket, head) => {
    const reqPath = (req.url || '').split('?')[0];
    if (reqPath !== '/api/ws') {
      socket.destroy();
      return;
    }
    const authCheck = verifyWebSocketUpgradeRequest(req, {
      port: boundUiPort,
      host: config.host,
      apiToken: config.apiToken,
      requireToken: config.requireApiToken,
    });
    if (!authCheck.ok) {
      logEvent('warn', 'ws', 'Rejected WebSocket connection', { reason: authCheck.reason });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    uiClients.add(ws);
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 25_000);
    pingInterval.unref();

    ws.on('message', (raw) => {
      try {
        const text = raw.toString();
        if (text.length > 2 * 1024 * 1024) return;
        const message = JSON.parse(text);
        if (!message || typeof message.type !== 'string') return;
        const payload = message.payload || {};

        if (message.type === 'ACTION_FORWARD' && typeof payload.id === 'string') {
          proxy.resolveIntercept(payload.id, {
            action: 'forward',
            modifiedMethod: typeof payload.modifiedMethod === 'string' ? payload.modifiedMethod : undefined,
            modifiedUrl: typeof payload.modifiedUrl === 'string' ? payload.modifiedUrl : undefined,
            modifiedHeaders:
              payload.modifiedHeaders && typeof payload.modifiedHeaders === 'object'
                ? payload.modifiedHeaders
                : undefined,
            modifiedBody: typeof payload.modifiedBody === 'string' ? payload.modifiedBody : undefined,
            interceptResponse: Boolean(payload.interceptResponse),
          });
        } else if (message.type === 'ACTION_DROP' && typeof payload.id === 'string') {
          proxy.resolveIntercept(payload.id, { action: 'drop' });
        } else if (message.type === 'TOGGLE_INTERCEPT') {
          proxy.gateEnabled = Boolean(payload.enabled);
          broadcastToUI('interceptStatus', {
            enabled: proxy.gateEnabled,
            responseEnabled: proxy.responseGateEnabled,
          });
        } else if (message.type === 'TOGGLE_RESPONSE_INTERCEPT') {
          proxy.responseGateEnabled = Boolean(payload.enabled);
          broadcastToUI('interceptStatus', {
            enabled: proxy.gateEnabled,
            responseEnabled: proxy.responseGateEnabled,
          });
        } else if (message.type === 'UPDATE_IGNORED_DOMAINS' && Array.isArray(payload)) {
          proxy.ignoredDomains = payload
            .map((d) => String(d).trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 500);
          void db.setSetting('ignoredDomains', proxy.ignoredDomains);
        }
      } catch (err) {
        logEvent('warn', 'ws', 'Malformed WS client message', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const cleanup = () => {
      clearInterval(pingInterval);
      uiClients.delete(ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  // Security middleware for local API & Host/Origin validation
  app.use((req, res, next) =>
    createLocalSecurityMiddleware({
      port: boundUiPort,
      host: config.host,
      apiToken: config.apiToken,
      requireToken: config.requireApiToken,
    })(req, res, next)
  );

  // Mount modular API routes
  app.use(
    '/api',
    createApiRouter({
      config,
      db,
      proxy,
      gemini,
      intruder,
      broadcast: broadcastToUI,
      getBoundPorts: () => ({ uiPort: boundUiPort, proxyPort: boundProxyPort }),
      health: {
        getEventLoopStats: () => ({
          mean: Math.round((elHistogram.mean / 1e6) * 100) / 100,
          p95: Math.round((elHistogram.percentile(95) / 1e6) * 100) / 100,
          max: Math.round((elHistogram.max / 1e6) * 100) / 100,
        }),
        getWsClientCount: () => uiClients.size,
      },
    })
  );

  // Serve frontend (Vite dev middleware in dev, dist/ static assets in prod)
  let viteServer: { close: () => Promise<void>; middlewares: any } | null = null;
  const distPath = path.resolve(process.env.PROXYSUITE_DIST_DIR || path.join(process.cwd(), 'dist'));

  if (process.env.NODE_ENV !== 'production' && process.env.PROXYSUITE_DISABLE_VITE !== '1') {
    const { createServer: createViteServer } = await import('vite');
    viteServer = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(viteServer.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Start MITM proxy and HTTP UI server
  const proxyBound = await proxy.listen();
  boundProxyPort = proxyBound.port;

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => reject(err);
    server.once('error', onErr);
    server.listen(config.port, config.host, () => {
      server.off('error', onErr);
      const addr = server.address();
      if (typeof addr === 'object' && addr?.port) {
        boundUiPort = addr.port;
      }
      resolve();
    });
  });

  logEvent('info', 'server', 'ProxySuite UI & API listening', {
    url: `http://${config.host}:${boundUiPort}`,
    proxy: `${config.proxyHost}:${boundProxyPort}`,
    dbPath: config.dbPath,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logEvent('info', 'server', 'Graceful shutdown initiated (preserving database)');

    elHistogram.disable();
    for (const ws of uiClients) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    uiClients.clear();
    wss.close();

    if (viteServer) {
      await viteServer.close();
    }
    await proxy.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };

  return {
    config,
    db,
    proxy,
    server,
    uiPort: boundUiPort,
    proxyPort: boundProxyPort,
    shutdown,
  };
}

// Run directly as entrypoint (skip if imported by tests)
const isDirectMain =
  process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectMain && process.env.PROXYSUITE_NO_AUTOSTART !== '1') {
  startProxySuiteServer()
    .then((runtime) => {
      const handleSignal = async (signal: string) => {
        logEvent('info', 'server', `Signal received: ${signal}`);
        await runtime.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => void handleSignal('SIGINT'));
      process.on('SIGTERM', () => void handleSignal('SIGTERM'));
    })
    .catch((err) => {
      logEvent('error', 'server', 'Fatal startup error', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
