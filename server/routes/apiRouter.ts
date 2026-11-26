import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/databaseClient.js';
import type { ProxyEngine } from '../proxy/mitmEngine.js';
import type { GeminiSecurityService } from '../ai/geminiService.js';
import type { IntruderEngine } from '../proxy/intruderEngine.js';
import type {
  BreakpointRule,
  HistoryQuery,
  IntruderJobConfig,
  RetentionPolicy,
  TargetScopeConfig,
} from '../types.js';
import {
  isAllowedHostHeader,
  isLocalOrigin,
  validateOutboundTarget,
  validateReplaceRules,
} from '../security.js';
import { exportPacketsToHar, importHarToRecords } from '../proxy/harConverter.js';
import { logEvent } from '../logger.js';

const ALLOWED_HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
]);

export interface HealthTracker {
  getEventLoopStats: () => { mean: number; p95: number; max: number };
  getWsClientCount: () => number;
}

async function sendViaProxyTunnel(opts: {
  targetUrl: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  proxyHost: string;
  proxyPort: number;
  caPemPath: string;
  timeoutMs: number;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const parsed = new URL(opts.targetUrl);
  const isHttps = parsed.protocol === 'https:';

  if (!isHttps) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: opts.proxyHost,
          port: opts.proxyPort,
          path: opts.targetUrl,
          method: opts.method,
          headers: {
            ...opts.headers,
            host: parsed.host,
          },
          timeout: opts.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (c: Buffer) => {
            if (total < 1024 * 1024) {
              chunks.push(c);
              total += c.length;
            }
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: Object.fromEntries(
                Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])
              ),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Simulator request timed out')));
      req.on('error', reject);
      if (opts.body && opts.method !== 'GET' && opts.method !== 'HEAD') {
        req.write(opts.body);
      }
      req.end();
    });
  }

  // HTTPS via HTTP CONNECT tunnel to our local MITM proxy
  const targetPort = parsed.port ? Number(parsed.port) : 443;
  const caCert = fs.existsSync(opts.caPemPath) ? fs.readFileSync(opts.caPemPath) : undefined;

  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      hostname: opts.proxyHost,
      port: opts.proxyPort,
      method: 'CONNECT',
      path: `${parsed.hostname}:${targetPort}`,
      headers: { host: `${parsed.hostname}:${targetPort}` },
      timeout: opts.timeoutMs,
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        host: parsed.hostname,
        socket,
        ...(net.isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
        ca: caCert,
        rejectUnauthorized: Boolean(caCert),
      });

      const req = https.request(
        {
          createConnection: () => tlsSocket,
          hostname: parsed.hostname,
          port: targetPort,
          path: `${parsed.pathname}${parsed.search}`,
          method: opts.method,
          headers: {
            ...opts.headers,
            host: parsed.host,
          },
          timeout: opts.timeoutMs,
        },
        (proxyRes) => {
          const chunks: Buffer[] = [];
          let total = 0;
          proxyRes.on('data', (c: Buffer) => {
            if (total < 1024 * 1024) {
              chunks.push(c);
              total += c.length;
            }
          });
          proxyRes.on('end', () => {
            resolve({
              statusCode: proxyRes.statusCode || 0,
              headers: Object.fromEntries(
                Object.entries(proxyRes.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])
              ),
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error('Simulator HTTPS request timed out')));
      req.on('error', reject);
      if (opts.body && opts.method !== 'GET' && opts.method !== 'HEAD') {
        req.write(opts.body);
      }
      req.end();
    });

    connectReq.on('timeout', () => connectReq.destroy(new Error('Proxy CONNECT timed out')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}

export function createApiRouter(deps: {
  config: AppConfig;
  db: DatabaseClient;
  proxy: ProxyEngine;
  gemini: GeminiSecurityService;
  intruder: IntruderEngine;
  health: HealthTracker;
  broadcast: (type: string, payload: unknown) => void;
  getBoundPorts: () => { uiPort: number; proxyPort: number };
}) {
  const router = express.Router();
  const { config, db, proxy, gemini, intruder, health, broadcast, getBoundPorts } = deps;

  // Bootstrap endpoint: supplies runtime token to same-origin UI clients
  router.get('/bootstrap', (req, res) => {
    const { uiPort, proxyPort } = getBoundPorts();
    if (!isAllowedHostHeader(req.headers.host, uiPort, config.host)) {
      return res.status(403).json({ error: 'Forbidden host' });
    }
    if (req.headers.origin && !isLocalOrigin(req.headers.origin, uiPort, config.host)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ error: 'Cross-site access denied' });
    }
    res.json({
      token: config.apiToken,
      port: uiPort,
      host: config.host,
      proxyPort,
      proxyHost: config.proxyHost,
      proxyStatus: proxy.proxyRunning ? 'UP' : 'DOWN',
      geminiConfigured: gemini.isConfigured(),
      geminiModel: gemini.getModel(),
    });
  });

  router.get('/config', (_req, res) => {
    const { uiPort, proxyPort } = getBoundPorts();
    res.json({
      port: uiPort,
      host: config.host,
      proxyPort,
      proxyHost: config.proxyHost,
      proxyStatus: proxy.proxyRunning ? 'UP' : 'DOWN',
      allowInsecureTls: proxy.settings.allowInsecureTls,
      geminiConfigured: gemini.isConfigured(),
      geminiModel: gemini.getModel(),
      gateEnabled: proxy.gateEnabled,
      responseGateEnabled: proxy.responseGateEnabled,
    });
  });

  router.get('/health', async (_req, res) => {
    const { uiPort, proxyPort } = getBoundPorts();
    const mem = process.memoryUsage();
    const dbStatus = await db.getStatus();
    const counts = proxy.getActiveCounts();
    res.json({
      timestamp: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      proxyStatus: proxy.proxyRunning ? 'UP' : 'DOWN',
      proxyHost: config.proxyHost,
      proxyPort,
      uiHost: config.host,
      uiPort,
      allowInsecureTls: proxy.settings.allowInsecureTls,
      memory: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
      },
      eventLoopLagMs: health.getEventLoopStats(),
      connections: {
        ...counts,
        wsUiClients: health.getWsClientCount(),
      },
      database: {
        path: dbStatus.dbPath,
        totalPackets: dbStatus.totalPackets,
        queueDepth: dbStatus.queueDepth,
        droppedWrites: dbStatus.droppedWrites,
        integrityOk: dbStatus.integrityOk,
        totalBytesCaptured: dbStatus.totalBytesCaptured,
      },
      trafficStats: proxy.stats,
    });
  });

  router.get('/ca-cert', (_req, res) => {
    const caCertPath = path.join(config.certDir, 'certs', 'ca.pem');
    if (fs.existsSync(caCertPath)) {
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename=ProxySuiteRootCA.pem');
      fs.createReadStream(caCertPath).pipe(res);
    } else {
      res.status(404).json({ error: 'CA certificate not yet generated. Please wait and try again.' });
    }
  });

  // Settings & Scope
  router.get('/settings', (_req, res) => {
    res.json({
      settings: proxy.settings,
      ignoredDomains: proxy.ignoredDomains,
      breakpointRules: proxy.breakpointRules,
    });
  });

  router.put('/settings', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.allowInsecureTls === 'boolean') {
        proxy.settings.allowInsecureTls = body.allowInsecureTls;
      }
      if (typeof body.maxReqBodyCaptureBytes === 'number') {
        proxy.settings.maxReqBodyCaptureBytes = Math.min(32 * 1024 * 1024, Math.max(1024, body.maxReqBodyCaptureBytes));
      }
      if (typeof body.maxResBodyCaptureBytes === 'number') {
        proxy.settings.maxResBodyCaptureBytes = Math.min(64 * 1024 * 1024, Math.max(1024, body.maxResBodyCaptureBytes));
      }
      if (typeof body.maxInterceptBodyBytes === 'number') {
        proxy.settings.maxInterceptBodyBytes = Math.min(32 * 1024 * 1024, Math.max(4096, body.maxInterceptBodyBytes));
      }
      if (typeof body.maxActiveRequests === 'number') {
        proxy.settings.maxActiveRequests = Math.min(5000, Math.max(10, body.maxActiveRequests));
      }
      if (typeof body.maxPendingIntercepts === 'number') {
        proxy.settings.maxPendingIntercepts = Math.min(1000, Math.max(5, body.maxPendingIntercepts));
      }
      if (body.retention && typeof body.retention === 'object') {
        const ret = body.retention as Partial<RetentionPolicy>;
        proxy.settings.retention = {
          enabled: Boolean(ret.enabled),
          maxRecords: Math.min(200_000, Math.max(100, Number(ret.maxRecords) || proxy.settings.retention.maxRecords)),
          maxAgeHours: Math.min(8760, Math.max(1, Number(ret.maxAgeHours) || proxy.settings.retention.maxAgeHours)),
        };
        await db.setSetting('retention', proxy.settings.retention);
      }
      if (body.targetScope && typeof body.targetScope === 'object') {
        const sc = body.targetScope as Partial<TargetScopeConfig>;
        proxy.settings.targetScope = {
          enforceScope: sc.enforceScope !== undefined ? Boolean(sc.enforceScope) : proxy.settings.targetScope.enforceScope,
          allowLocalhost: sc.allowLocalhost !== undefined ? Boolean(sc.allowLocalhost) : proxy.settings.targetScope.allowLocalhost,
          allowPrivateNetworks:
            sc.allowPrivateNetworks !== undefined
              ? Boolean(sc.allowPrivateNetworks)
              : proxy.settings.targetScope.allowPrivateNetworks,
          allowedHosts: Array.isArray(sc.allowedHosts)
            ? sc.allowedHosts.map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
            : proxy.settings.targetScope.allowedHosts,
          excludedHosts: Array.isArray(sc.excludedHosts)
            ? sc.excludedHosts.map((s) => String(s).trim()).filter(Boolean).slice(0, 200)
            : proxy.settings.targetScope.excludedHosts,
          maxRepeaterRedirects: Math.min(
            10,
            Math.max(0, Number(sc.maxRepeaterRedirects ?? proxy.settings.targetScope.maxRepeaterRedirects))
          ),
        };
        await db.setSetting('targetScope', proxy.settings.targetScope);
      }
      if (Array.isArray(body.ignoredDomains)) {
        proxy.ignoredDomains = body.ignoredDomains.map((d: unknown) => String(d).trim().toLowerCase()).filter(Boolean).slice(0, 500);
        await db.setSetting('ignoredDomains', proxy.ignoredDomains);
      }
      if (Array.isArray(body.breakpointRules)) {
        proxy.breakpointRules = (body.breakpointRules as BreakpointRule[]).slice(0, 50);
        await db.setSetting('breakpointRules', proxy.breakpointRules);
      }
      broadcast('settingsUpdated', {
        settings: proxy.settings,
        ignoredDomains: proxy.ignoredDomains,
        breakpointRules: proxy.breakpointRules,
      });
      res.json({ success: true, settings: proxy.settings });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save settings' });
    }
  });

  // Match & Replace Rules (validated against ReDoS)
  router.get('/rules', (_req, res) => {
    res.json(proxy.replacementRules);
  });

  router.post('/rules', express.json({ limit: '256kb' }), async (req, res) => {
    const validation = validateReplaceRules(req.body);
    if (!validation.valid || !validation.rules) {
      return res.status(400).json({ error: validation.error || 'Invalid rules payload' });
    }
    proxy.replacementRules = validation.rules;
    await db.setSetting('replacementRules', validation.rules);
    res.json({ success: true, rules: validation.rules });
  });

  // Intercept controls
  router.post('/intercept/toggle', express.json({ limit: '16kb' }), (req, res) => {
    proxy.gateEnabled = Boolean(req.body?.enabled);
    broadcast('interceptStatus', { enabled: proxy.gateEnabled, responseEnabled: proxy.responseGateEnabled });
    res.json({ success: true, enabled: proxy.gateEnabled });
  });

  router.post('/intercept/response/toggle', express.json({ limit: '16kb' }), (req, res) => {
    proxy.responseGateEnabled = Boolean(req.body?.enabled);
    broadcast('interceptStatus', { enabled: proxy.gateEnabled, responseEnabled: proxy.responseGateEnabled });
    res.json({ success: true, enabled: proxy.responseGateEnabled });
  });

  router.post('/intercept/action', express.json({ limit: '6mb' }), (req, res) => {
    const { id, action, modifiedMethod, modifiedUrl, modifiedHeaders, modifiedBody, interceptResponse } = req.body || {};
    if (typeof id !== 'string' || (action !== 'forward' && action !== 'drop')) {
      return res.status(400).json({ error: 'Invalid intercept action payload' });
    }
    const resolved = proxy.resolveIntercept(id, {
      action,
      modifiedMethod,
      modifiedUrl,
      modifiedHeaders,
      modifiedBody,
      interceptResponse,
    });
    if (!resolved) {
      return res.status(404).json({ error: 'Proxy intercept entry not found or already released' });
    }
    res.json({ success: true });
  });

  // Traffic History (paginated summaries + lazy detail load)
  router.get('/history', async (req, res) => {
    try {
      const q: HistoryQuery = {
        limit: Math.min(500, Math.max(1, Number(req.query.limit) || 100)),
        offset: Math.max(0, Number(req.query.offset) || 0),
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        bodySearch: typeof req.query.bodySearch === 'string' ? req.query.bodySearch : undefined,
        method: typeof req.query.method === 'string' ? req.query.method : undefined,
        host: typeof req.query.host === 'string' ? req.query.host : undefined,
        statusGroup: typeof req.query.statusGroup === 'string' ? req.query.statusGroup : undefined,
        contentType: typeof req.query.contentType === 'string' ? req.query.contentType : undefined,
        bookmarkedOnly: req.query.bookmarkedOnly === 'true',
        tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
        collectionId: typeof req.query.collectionId === 'string' ? req.query.collectionId : undefined,
        sortBy: (req.query.sortBy as HistoryQuery['sortBy']) || 'timestamp',
        sortDir: req.query.sortDir === 'asc' ? 'asc' : 'desc',
      };
      const result = await db.queryPackets(q);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'History query failed' });
    }
  });

  router.get('/history/stats', async (_req, res) => {
    try {
      const stats = await db.getTrafficStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stats query failed' });
    }
  });

  router.get('/history/:id', async (req, res) => {
    try {
      const packet = await db.getPacketById(req.params.id);
      if (!packet) {
        return res.status(404).json({ error: 'Packet not found' });
      }
      res.json(packet);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to fetch packet detail' });
    }
  });

  router.patch('/history/:id/meta', express.json({ limit: '32kb' }), (req, res) => {
    const { tags, bookmarked, collectionId } = req.body || {};
    const safeTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    db.enqueueUpdateMeta(req.params.id, safeTags, Boolean(bookmarked), collectionId || null);
    res.json({ success: true });
  });

  router.delete('/history', async (_req, res) => {
    try {
      await db.clearHistory();
      broadcast('REFRESH_DATA', { reason: 'user_cleared' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Clear history failed' });
    }
  });

  // Collections
  router.get('/collections', async (_req, res) => {
    try {
      const data = await db.listCollections();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load collections' });
    }
  });

  router.post('/collections', express.json({ limit: '64kb' }), async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Collection name is required' });
    const item = {
      id: uuidv4(),
      name: name.slice(0, 120),
      description: typeof req.body?.description === 'string' ? req.body.description.slice(0, 500) : '',
      createdAt: Date.now(),
    };
    await db.createCollection(item);
    res.json(item);
  });

  router.delete('/collections/:id', async (req, res) => {
    await db.deleteCollection(req.params.id);
    res.json({ success: true });
  });

  router.post('/collections/:id/requests', express.json({ limit: '1mb' }), async (req, res) => {
    const { name, method, url: reqUrl, headers, body } = req.body || {};
    if (typeof reqUrl !== 'string' || !reqUrl) {
      return res.status(400).json({ error: 'Request URL is required' });
    }
    const saved = {
      id: uuidv4(),
      collectionId: req.params.id,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : reqUrl.slice(0, 80),
      method: typeof method === 'string' ? method.toUpperCase() : 'GET',
      url: reqUrl,
      headers: headers && typeof headers === 'object' ? headers : {},
      body: typeof body === 'string' ? body : '',
      createdAt: Date.now(),
    };
    await db.saveRequestToCollection(saved);
    res.json(saved);
  });

  router.delete('/collections/requests/:reqId', async (req, res) => {
    await db.deleteSavedRequest(req.params.reqId);
    res.json({ success: true });
  });

  // Session Export / Import / Backup (JSON & HAR 1.2)
  router.get('/session/export', async (req, res) => {
    try {
      const format = req.query.format === 'har' ? 'har' : 'json';
      const redact = req.query.redact === 'true';
      const records = await db.exportSession(10000);
      const dateStr = new Date().toISOString().split('T')[0];

      if (format === 'har') {
        const har = exportPacketsToHar(records, redact);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=proxysuite_${dateStr}.har`);
        return res.send(JSON.stringify(har, null, 2));
      }

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=audit_session_${dateStr}.json`);
      res.send(JSON.stringify(records, null, 2));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  router.post('/session/import', express.json({ limit: '50mb' }), async (req, res) => {
    try {
      const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
      const payload = req.body;
      let recordsToImport: any[];

      if (Array.isArray(payload)) {
        const valid = payload.every((p) => p && typeof p.id === 'string' && typeof p.url === 'string');
        if (!valid && payload.length > 0) {
          return res.status(400).json({ error: 'Invalid session schema: each packet requires string id and url' });
        }
        recordsToImport = payload;
      } else if (payload && typeof payload === 'object' && payload.log?.entries) {
        const harRes = importHarToRecords(payload);
        if (!harRes.valid || !harRes.records) {
          return res.status(400).json({ error: harRes.error || 'Invalid HAR payload' });
        }
        recordsToImport = harRes.records;
      } else {
        return res.status(400).json({ error: 'Expected JSON array of packets or HAR 1.2 object' });
      }

      const result = await db.importSession(recordsToImport, mode);
      broadcast('SESSION_RELOADED', result);
      res.json({ success: true, count: result.imported, skipped: result.skipped });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  });

  router.post('/session/backup', async (_req, res) => {
    try {
      const result = await db.backup();
      res.json({ success: true, backupPath: result.backupPath });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
    }
  });

  // Repeater (SSRF + Target Scope + Redirect hop validation + Bounded response)
  router.post('/repeater', express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const { method: rawMethod, url: rawUrl, headers, body } = req.body || {};
      const method = String(rawMethod || 'GET').toUpperCase();
      if (!ALLOWED_HTTP_METHODS.has(method)) {
        return res.status(400).json({ error: `Unsupported HTTP method: ${method}` });
      }
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        return res.status(400).json({ error: 'Target URL is required' });
      }

      let currentUrl = rawUrl.trim();
      const cleanHeaders: Record<string, string> = {};
      if (headers && typeof headers === 'object') {
        for (const [key, val] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding') {
            continue;
          }
          cleanHeaders[key] = String(val);
        }
      }

      const reqBodyStr =
        body && method !== 'GET' && method !== 'HEAD'
          ? typeof body === 'string'
            ? body
            : JSON.stringify(body)
          : undefined;

      const startTime = Date.now();
      let hops = 0;
      const maxHops = proxy.settings.targetScope.maxRepeaterRedirects;
      let response: globalThis.Response | null = null;

      while (true) {
        const check = await validateOutboundTarget(currentUrl, proxy.settings.targetScope);
        if (!check.allowed || !check.normalizedUrl) {
          return res.status(403).json({ error: check.reason || 'Blocked by target scope / SSRF guard' });
        }
        currentUrl = check.normalizedUrl;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), proxy.settings.upstreamTimeoutMs);
        try {
          response = await fetch(currentUrl, {
            method: hops === 0 ? method : 'GET',
            headers: cleanHeaders,
            body: hops === 0 ? reqBodyStr : undefined,
            redirect: 'manual',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        const location = response.headers.get('location');
        if (
          location &&
          response.status >= 300 &&
          response.status < 400 &&
          hops < maxHops
        ) {
          hops++;
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        break;
      }

      const rawText = await response.text();
      const maxCap = proxy.settings.maxResBodyCaptureBytes;
      const bodyTruncated = rawText.length > maxCap;
      const resBody = bodyTruncated ? rawText.slice(0, maxCap) : rawText;
      const durationMs = Date.now() - startTime;
      const resHeaders = Object.fromEntries(response.headers.entries());

      const reqId = uuidv4();
      const parsedFinal = new URL(currentUrl);
      const packet = {
        id: reqId,
        timestamp: Date.now(),
        method,
        url: currentUrl,
        host: parsedFinal.host,
        path: `${parsedFinal.pathname}${parsedFinal.search}`,
        headers: cleanHeaders,
        body: reqBodyStr || '',
        bodySize: reqBodyStr ? Buffer.byteLength(reqBodyStr, 'utf8') : 0,
        bodyTruncated: false,
        isBinary: false,
        status: 'completed' as const,
        tags: ['repeater'],
        bookmarked: false,
        response: {
          statusCode: response.status,
          headers: resHeaders,
          body: resBody,
          bodySize: Buffer.byteLength(rawText, 'utf8'),
          bodyTruncated,
          isBinary: false,
          timestamp: Date.now(),
          duration: durationMs,
        },
      };

      db.enqueueUpsertPacket({ ...packet, contentType: resHeaders['content-type'] });
      broadcast('requestCaptured', packet);
      broadcast('responseCaptured', { id: reqId, ...packet.response });

      res.json({
        id: reqId,
        finalUrl: currentUrl,
        redirectsFollowed: hops,
        status_code: response.status,
        headers: resHeaders,
        body: resBody,
        bodySize: Buffer.byteLength(rawText, 'utf8'),
        bodyTruncated,
        duration_ms: durationMs,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Repeater request failed' });
    }
  });

  // Simulator (routes through MITM proxy with SSRF + target scope protection)
  router.post('/simulate-request', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const { targetUrl, method: rawMethod = 'GET', body } = req.body || {};
      const method = String(rawMethod).toUpperCase();
      if (!ALLOWED_HTTP_METHODS.has(method)) {
        return res.status(400).json({ error: `Unsupported HTTP method: ${method}` });
      }
      if (typeof targetUrl !== 'string' || !targetUrl.trim()) {
        return res.status(400).json({ error: 'targetUrl is required' });
      }

      const check = await validateOutboundTarget(targetUrl.trim(), proxy.settings.targetScope);
      if (!check.allowed || !check.normalizedUrl) {
        return res.status(403).json({ error: check.reason || 'Blocked by target scope / SSRF guard' });
      }

      const headers: Record<string, string> = {
        'User-Agent': 'ProxySuite-Simulator/2.0',
      };
      let bodyStr: string | undefined;
      if (body && method !== 'GET' && method !== 'HEAD') {
        bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      }

      const { proxyPort } = getBoundPorts();
      const caPemPath = path.join(config.certDir, 'certs', 'ca.pem');
      const result = await sendViaProxyTunnel({
        targetUrl: check.normalizedUrl,
        method,
        headers,
        body: bodyStr,
        proxyHost: config.proxyHost,
        proxyPort,
        caPemPath,
        timeoutMs: 30_000,
      });

      res.json({
        success: true,
        simulated: true,
        status: result.statusCode,
        bodyLength: result.body.length,
      });
    } catch (err) {
      logEvent('warn', 'simulator', 'Simulated request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: err instanceof Error ? err.message : 'Simulation failed' });
    }
  });

  // Intruder (bounded concurrency + scope enforcement + pause/resume/stop)
  router.post('/intruder/run', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const b = req.body || {};
      const method = String(b.method || 'GET').toUpperCase();
      if (!ALLOWED_HTTP_METHODS.has(method)) {
        return res.status(400).json({ error: `Unsupported method: ${method}` });
      }
      if (typeof b.url !== 'string' || !b.url.trim()) {
        return res.status(400).json({ error: 'Target URL is required' });
      }
      if (!Array.isArray(b.payloads) || b.payloads.length === 0) {
        return res.status(400).json({ error: 'Payloads array must be non-empty' });
      }

      const jobConfig: IntruderJobConfig = {
        method,
        url: b.url.trim(),
        headers: b.headers && typeof b.headers === 'object' ? b.headers : {},
        body: typeof b.body === 'string' ? b.body : undefined,
        payloads: b.payloads.map((p: unknown) => String(p)),
        concurrency: Number(b.concurrency) || 5,
        delayMs: Number(b.delayMs) || 0,
        jitterMs: Number(b.jitterMs) || 0,
        maxPayloads: Number(b.maxPayloads) || 200,
        maxDurationMs: Number(b.maxDurationMs) || 120_000,
        requestTimeoutMs: Number(b.requestTimeoutMs) || 10_000,
        rotateUserAgent: Boolean(b.rotateUserAgent),
      };

      const started = await intruder.startJob(jobConfig, proxy.settings.targetScope);
      res.json(started);
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : 'Failed to start Intruder job' });
    }
  });

  router.post('/intruder/:jobId/pause', (req, res) => {
    if (!intruder.pauseJob(req.params.jobId)) {
      return res.status(404).json({ error: 'Running job not found' });
    }
    res.json({ success: true });
  });

  router.post('/intruder/:jobId/resume', (req, res) => {
    if (!intruder.resumeJob(req.params.jobId)) {
      return res.status(404).json({ error: 'Paused job not found' });
    }
    res.json({ success: true });
  });

  router.post('/intruder/:jobId/stop', (req, res) => {
    if (!intruder.stopJob(req.params.jobId)) {
      return res.status(404).json({ error: 'Active job not found' });
    }
    res.json({ success: true });
  });

  // WebSocket Inspector endpoints
  router.get('/websockets/connections', (_req, res) => {
    res.json(proxy.getWebSocketConnections());
  });

  router.get('/websockets/frames', (req, res) => {
    const connId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
    res.json(proxy.getWebSocketFrames(connId));
  });

  router.post('/websockets/clear', (_req, res) => {
    proxy.clearWebSocketHistory();
    res.json({ success: true });
  });

  // Gemini AI Defensive Security Analysis
  router.post('/analyze', express.json({ limit: '2mb' }), async (req, res) => {
    if (!gemini.isConfigured()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the backend server.' });
    }
    try {
      const { id, method, url: reqUrl, headers, body, response } = req.body || {};
      if (typeof reqUrl !== 'string' || !reqUrl) {
        return res.status(400).json({ error: 'Request URL is required for analysis' });
      }
      const analysis = await gemini.analyzeTransaction({
        method: String(method || 'GET'),
        url: reqUrl,
        headers: headers && typeof headers === 'object' ? headers : {},
        body: typeof body === 'string' ? body : undefined,
        response: response && typeof response === 'object' ? response : undefined,
      });

      if (typeof id === 'string' && id) {
        db.enqueueUpdateAnalysis(id, analysis.markdown, analysis);
      }

      res.json({
        text: analysis.markdown,
        structured: analysis,
      });
    } catch (err) {
      logEvent('error', 'gemini', 'AI analysis failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: err instanceof Error ? err.message : 'AI analysis failed' });
    }
  });

  return router;
}
