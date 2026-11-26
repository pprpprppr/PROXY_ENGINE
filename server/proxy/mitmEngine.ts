import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { constants } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { v4 as uuidv4 } from 'uuid';
import { Proxy as MitmProxy } from 'http-mitm-proxy';
import type { IContext, IWebSocketContext } from 'http-mitm-proxy';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/databaseClient.js';
import type {
  BreakpointRule,
  CapturedPacket,
  ReplaceRule,
  RuntimeProxySettings,
  WebSocketConnectionRecord,
  WebSocketFrameRecord,
} from '../types.js';
import { compileSafeRegex } from '../security.js';
import { logEvent } from '../logger.js';
import {
  BoundedBuffer,
  decodeBodyForInspection,
  formatBufferPreview,
  normalizeHeadersRecord,
} from './boundedBuffer.js';
import { runPassiveScan } from './passiveScanner.js';

interface PendingGateEntry {
  resolve: (decision: InterceptDecision) => void;
  timestamp: number;
  kind: 'request' | 'response';
}

export interface InterceptDecision {
  action: 'forward' | 'drop';
  modifiedMethod?: string;
  modifiedUrl?: string;
  modifiedHeaders?: Record<string, string>;
  modifiedBody?: string;
  interceptResponse?: boolean;
}

interface ActiveRequestEntry {
  id: string;
  startedAt: number;
  abortController: AbortController;
  aborted: boolean;
}

export type BroadcastFn = (type: string, payload: unknown) => void;

export function buildFullRequestUrl(
  isSSL: boolean,
  hostHeader: string | undefined,
  rawUrl: string | undefined
): string {
  const pathPart = rawUrl || '/';
  if (/^https?:\/\//i.test(pathPart)) {
    try {
      return new URL(pathPart).toString();
    } catch {
      return pathPart;
    }
  }
  const scheme = isSSL ? 'https' : 'http';
  const host = (hostHeader || 'localhost').trim();
  const normalizedPath = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  try {
    return new URL(`${scheme}://${host}${normalizedPath}`).toString();
  } catch {
    return `${scheme}://${host}${normalizedPath}`;
  }
}

function applyStringRule(input: string, rule: ReplaceRule): string {
  if (!rule.match) return input;
  if (rule.isRegex === false) {
    return input.split(rule.match).join(rule.replace);
  }
  const { regex } = compileSafeRegex(rule.match, 'g');
  if (!regex) return input;
  return input.replace(regex, rule.replace);
}

export class ProxyEngine {
  private mitmProxy: MitmProxy;
  private config: AppConfig;
  private db: DatabaseClient;
  private broadcast: BroadcastFn;
  public settings: RuntimeProxySettings;

  public proxyRunning = false;
  public gateEnabled = false;
  public responseGateEnabled = false;
  public ignoredDomains: string[] = [];
  public replacementRules: ReplaceRule[] = [];
  public breakpointRules: BreakpointRule[] = [];

  private trafficGate = new Map<string, PendingGateEntry>();
  private responseReviewQueue = new Map<string, PendingGateEntry>();
  private activeRequests = new Map<string, ActiveRequestEntry>();

  // WebSocket inspection state (bounded)
  private wsConnections = new Map<string, WebSocketConnectionRecord>();
  private wsFrames: WebSocketFrameRecord[] = [];

  // Traffic counters for observability
  public stats = {
    totalCaptured: 0,
    totalTruncated: 0,
    totalErrors: 0,
    inMemoryBytesEstimate: 0,
  };

  private reaperTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, db: DatabaseClient, broadcast: BroadcastFn) {
    this.config = config;
    this.db = db;
    this.broadcast = broadcast;
    this.settings = structuredClone(config.defaults);
    this.mitmProxy = new MitmProxy();
  }

  async init(): Promise<void> {
    // Load persisted settings from SQLite if present
    try {
      const savedScope = await this.db.getSetting<RuntimeProxySettings['targetScope']>('targetScope');
      if (savedScope) {
        this.settings.targetScope = { ...this.settings.targetScope, ...savedScope };
      }
      const savedRetention = await this.db.getSetting<RuntimeProxySettings['retention']>('retention');
      if (savedRetention) {
        this.settings.retention = { ...this.settings.retention, ...savedRetention };
      }
      const savedRules = await this.db.getSetting<ReplaceRule[]>('replacementRules');
      if (Array.isArray(savedRules)) {
        this.replacementRules = savedRules;
      }
      const savedBreakpoints = await this.db.getSetting<BreakpointRule[]>('breakpointRules');
      if (Array.isArray(savedBreakpoints)) {
        this.breakpointRules = savedBreakpoints;
      }
      const savedIgnored = await this.db.getSetting<string[]>('ignoredDomains');
      if (Array.isArray(savedIgnored)) {
        this.ignoredDomains = savedIgnored;
      }
    } catch (err) {
      logEvent('warn', 'proxy', 'Failed to load persisted settings; using defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.ensureCertDirPermissions();
    this.setupHooks();
    this.startTimers();
  }

  private ensureCertDirPermissions(): void {
    try {
      if (!fs.existsSync(this.config.certDir)) {
        fs.mkdirSync(this.config.certDir, { recursive: true, mode: 0o700 });
      }
      fs.chmodSync(this.config.certDir, 0o700);
      const keysDir = path.join(this.config.certDir, 'keys');
      if (fs.existsSync(keysDir)) {
        fs.chmodSync(keysDir, 0o700);
        for (const f of fs.readdirSync(keysDir)) {
          if (f.endsWith('.key')) {
            try {
              fs.chmodSync(path.join(keysDir, f), 0o600);
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch (err) {
      logEvent('warn', 'proxy', 'Unable to enforce CA directory permissions', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private startTimers(): void {
    const reaperIntervalMs = Math.min(15_000, Math.max(100, Math.floor(this.settings.interceptTimeoutMs / 2)));
    this.reaperTimer = setInterval(() => {
      const now = Date.now();
      const ttl = this.settings.interceptTimeoutMs;
      for (const [queueName, queue] of [
        ['request', this.trafficGate],
        ['response', this.responseReviewQueue],
      ] as const) {
        for (const [id, entry] of queue.entries()) {
          if (now - entry.timestamp > ttl) {
            logEvent('warn', 'proxy', `Reaper dropping stale ${queueName} intercept`, { id });
            entry.resolve({ action: 'drop' });
            queue.delete(id);
          }
        }
      }
    }, reaperIntervalMs);
    this.reaperTimer.unref();

    this.retentionTimer = setInterval(async () => {
      if (!this.settings.retention.enabled) return;
      try {
        const res = await this.db.enforceRetention(this.settings.retention);
        if (res.deleted > 0) {
          logEvent('info', 'retention', 'Enforced user retention policy', { deleted: res.deleted });
        }
      } catch (err) {
        logEvent('error', 'retention', 'Retention cleanup failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 10 * 60 * 1000);
    this.retentionTimer.unref();
  }

  private isDomainIgnored(host: string): boolean {
    const cleanHost = host.split(':')[0].toLowerCase();
    return this.ignoredDomains.some((d) => {
      const target = d.toLowerCase().trim();
      return cleanHost === target || cleanHost.endsWith('.' + target);
    });
  }

  private matchesBreakpoint(phase: 'request' | 'response', method: string, host: string, urlPath: string): boolean {
    return this.breakpointRules.some((rule) => {
      if (!rule.enabled) return false;
      if (rule.phase !== 'both' && rule.phase !== phase) return false;
      if (rule.methods && rule.methods.length > 0 && !rule.methods.includes(method.toUpperCase())) {
        return false;
      }
      if (rule.hostPattern) {
        const { regex } = compileSafeRegex(rule.hostPattern, 'i');
        if (regex && !regex.test(host)) return false;
      }
      if (rule.pathPattern) {
        const { regex } = compileSafeRegex(rule.pathPattern, 'i');
        if (regex && !regex.test(urlPath)) return false;
      }
      return true;
    });
  }

  private applyRequestHeaderAndUrlRules(
    fullUrl: string,
    headers: Record<string, string>,
    ctx: IContext
  ): { url: string; headers: Record<string, string> } {
    let updatedUrl = fullUrl;
    const updatedHeaders = { ...headers };
    const reqRules = this.replacementRules.filter(
      (r) => r.active && (r.phase === 'request' || r.phase === 'both' || !r.phase)
    );

    for (const rule of reqRules) {
      if (rule.type === 'url') {
        updatedUrl = applyStringRule(updatedUrl, rule);
      } else if (rule.type === 'header') {
        for (const [hKey, hVal] of Object.entries(updatedHeaders)) {
          updatedHeaders[hKey] = applyStringRule(hVal, rule);
        }
      }
    }

    if (updatedUrl !== fullUrl) {
      try {
        const parsed = new URL(updatedUrl);
        ctx.proxyToServerRequestOptions!.host = parsed.hostname;
        ctx.proxyToServerRequestOptions!.port = parsed.port
          ? Number(parsed.port)
          : parsed.protocol === 'https:'
            ? 443
            : 80;
        ctx.proxyToServerRequestOptions!.path = `${parsed.pathname}${parsed.search}`;
        updatedHeaders['host'] = parsed.host;
      } catch {
        // Keep previous options if modified URL failed to parse
      }
    }

    ctx.proxyToServerRequestOptions!.headers = { ...updatedHeaders };
    return { url: updatedUrl, headers: updatedHeaders };
  }

  private readClientBodyBounded(req: any, maxBytes: number, signal: AbortSignal): Promise<{ buffer: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const cap = new BoundedBuffer(maxBytes);
      let settled = false;
      const cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onErr);
        signal.removeEventListener('abort', onAbort);
      };
      const onData = (chunk: Buffer) => {
        cap.append(chunk);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ buffer: cap.toBuffer(), truncated: cap.truncated });
      };
      const onErr = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ buffer: cap.toBuffer(), truncated: cap.truncated });
      };

      signal.addEventListener('abort', onAbort, { once: true });
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onErr);
      req.resume();
    });
  }

  private setupHooks(): void {
    this.mitmProxy.onRequest(async (ctx, callback) => {
      if (this.activeRequests.size >= this.settings.maxActiveRequests) {
        if (!ctx.proxyToClientResponse.headersSent) {
          ctx.proxyToClientResponse.writeHead(503, { 'Content-Type': 'text/plain' });
          ctx.proxyToClientResponse.end('Proxy Busy: Active request limit reached');
        }
        return;
      }

      const requestId = uuidv4();
      const startedAtPerf = performance.now();
      const startedAtWall = Date.now();
      const abortController = new AbortController();
      const activeEntry: ActiveRequestEntry = {
        id: requestId,
        startedAt: startedAtWall,
        abortController,
        aborted: false,
      };
      this.activeRequests.set(requestId, activeEntry);

      const c = ctx as any;
      c.requestId = requestId;
      c.startedAtPerf = startedAtPerf;
      c.startedAtWall = startedAtWall;
      c.activeEntry = activeEntry;

      let callbackDone = false;
      const safeCallback = (err?: Error | null) => {
        if (callbackDone) return;
        callbackDone = true;
        callback(err || undefined);
      };

      const onClientAbort = () => {
        activeEntry.aborted = true;
        abortController.abort();
        const pendingReq = this.trafficGate.get(requestId);
        if (pendingReq) {
          this.trafficGate.delete(requestId);
          pendingReq.resolve({ action: 'drop' });
        }
        const pendingRes = this.responseReviewQueue.get(requestId);
        if (pendingRes) {
          this.responseReviewQueue.delete(requestId);
          pendingRes.resolve({ action: 'drop' });
        }
        if (ctx.proxyToServerRequest && !ctx.proxyToServerRequest.destroyed) {
          ctx.proxyToServerRequest.destroy();
        }
        this.activeRequests.delete(requestId);
      };

      ctx.clientToProxyRequest.once('aborted', onClientAbort);
      ctx.proxyToClientResponse.once('close', () => {
        if (!ctx.proxyToClientResponse.writableEnded) {
          onClientAbort();
        } else {
          this.activeRequests.delete(requestId);
        }
      });

      try {
        const method = (ctx.clientToProxyRequest.method || 'GET').toUpperCase();
        const rawHeaders = normalizeHeadersRecord(ctx.clientToProxyRequest.headers);
        let fullUrl = buildFullRequestUrl(ctx.isSSL, rawHeaders.host, ctx.clientToProxyRequest.url);

        if (!rawHeaders.host && !/^https?:\/\//i.test(ctx.clientToProxyRequest.url || '')) {
          ctx.proxyToClientResponse.writeHead(400, { 'Content-Type': 'text/plain' });
          ctx.proxyToClientResponse.end('Bad Request: Missing Host header');
          this.activeRequests.delete(requestId);
          return;
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(fullUrl);
        } catch {
          ctx.proxyToClientResponse.writeHead(400, { 'Content-Type': 'text/plain' });
          ctx.proxyToClientResponse.end('Bad Request: Malformed URL');
          this.activeRequests.delete(requestId);
          return;
        }

        // Configure upstream TLS securely (verification enabled by default!)
        if (parsedUrl.protocol === 'https:') {
          const hostname = parsedUrl.hostname;
          if (!net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
            (ctx.proxyToServerRequestOptions as any).servername = hostname;
          }
          (ctx.proxyToServerRequestOptions as any).rejectUnauthorized = !this.settings.allowInsecureTls;
          (ctx.proxyToServerRequestOptions as any).minVersion = 'TLSv1.2';
          (ctx.proxyToServerRequestOptions as any).secureOptions =
            constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1;
        }

        (ctx.proxyToServerRequestOptions as any).timeout = this.settings.upstreamTimeoutMs;

        // Apply URL/header replacement rules BEFORE upstream request opens
        const ruled = this.applyRequestHeaderAndUrlRules(fullUrl, rawHeaders, ctx);
        fullUrl = ruled.url;
        const reqHeaders = ruled.headers;
        parsedUrl = new URL(fullUrl);

        const isIgnored = this.isDomainIgnored(parsedUrl.host);
        const breakpointHit =
          !isIgnored && this.matchesBreakpoint('request', method, parsedUrl.host, parsedUrl.pathname + parsedUrl.search);
        const shouldInterceptReq = (this.gateEnabled && !isIgnored) || breakpointHit;

        const hasActiveReqBodyRules = this.replacementRules.some(
          (r) => r.active && r.type === 'body' && (r.phase === 'request' || r.phase === 'both' || !r.phase)
        );

        if (shouldInterceptReq || hasActiveReqBodyRules) {
          // Pre-buffer body inside onRequest so method, URL, headers & body edits take effect BEFORE upstream TCP connection opens!
          const { buffer: rawBodyBuf, truncated: bodyTruncated } = await this.readClientBodyBounded(
            ctx.clientToProxyRequest,
            this.settings.maxInterceptBodyBytes,
            abortController.signal
          );

          if (activeEntry.aborted) {
            return safeCallback();
          }

          let finalBodyBuf = rawBodyBuf;
          let finalMethod = method;
          let finalUrl = fullUrl;
          let finalHeaders = { ...reqHeaders };

          const preview = formatBufferPreview(finalBodyBuf, finalHeaders);
          let editableBodyText = preview.isBinary ? '' : preview.text;

          if (hasActiveReqBodyRules && !preview.isBinary && !bodyTruncated) {
            let modified = editableBodyText;
            for (const rule of this.replacementRules) {
              if (rule.active && rule.type === 'body' && (rule.phase === 'request' || rule.phase === 'both' || !rule.phase)) {
                modified = applyStringRule(modified, rule);
              }
            }
            if (modified !== editableBodyText) {
              editableBodyText = modified;
              finalBodyBuf = Buffer.from(modified, 'utf8');
            }
          }

          if (shouldInterceptReq && this.trafficGate.size < this.settings.maxPendingIntercepts) {
            const pendingPacket: CapturedPacket = {
              id: requestId,
              timestamp: startedAtWall,
              method: finalMethod,
              url: finalUrl,
              host: parsedUrl.host,
              path: `${parsedUrl.pathname}${parsedUrl.search}`,
              headers: finalHeaders,
              body: preview.isBinary ? preview.text : editableBodyText,
              bodySize: finalBodyBuf.length,
              bodyTruncated,
              isBinary: preview.isBinary,
              status: 'intercepted',
              tags: [],
              bookmarked: false,
            };

            this.broadcast('PENDING_REVIEW', pendingPacket);

            const decision = await new Promise<InterceptDecision>((resolve) => {
              this.trafficGate.set(requestId, {
                resolve,
                timestamp: Date.now(),
                kind: 'request',
              });
            });

            if (activeEntry.aborted || decision.action === 'drop') {
              if (!ctx.proxyToClientResponse.writableEnded) {
                ctx.proxyToClientResponse.writeHead(504, { 'Content-Type': 'text/plain' });
                ctx.proxyToClientResponse.end('Request dropped by ProxySuite Intercept Gate');
              }
              pendingPacket.status = 'dropped';
              this.persistCapturedRequest(pendingPacket);
              this.broadcast('requestCaptured', pendingPacket);
              this.activeRequests.delete(requestId);
              return;
            }

            if (decision.modifiedMethod) {
              finalMethod = decision.modifiedMethod.toUpperCase();
              ctx.proxyToServerRequestOptions!.method = finalMethod;
            }
            if (decision.modifiedHeaders) {
              finalHeaders = decision.modifiedHeaders;
              ctx.proxyToServerRequestOptions!.headers = { ...finalHeaders };
            }
            if (decision.modifiedUrl) {
              try {
                const edited = new URL(decision.modifiedUrl);
                finalUrl = edited.toString();
                ctx.proxyToServerRequestOptions!.host = edited.hostname;
                ctx.proxyToServerRequestOptions!.port = edited.port
                  ? Number(edited.port)
                  : edited.protocol === 'https:'
                    ? 443
                    : 80;
                ctx.proxyToServerRequestOptions!.path = `${edited.pathname}${edited.search}`;
                finalHeaders['host'] = edited.host;
                ctx.proxyToServerRequestOptions!.headers = { ...finalHeaders };
              } catch {
                // Keep original URL if edited URL was invalid
              }
            }
            if (decision.modifiedBody !== undefined && !preview.isBinary) {
              finalBodyBuf = Buffer.from(decision.modifiedBody, 'utf8');
            }
            if (decision.interceptResponse) {
              c.interceptResponse = true;
            }
          }

          if (ctx.proxyToServerRequestOptions?.headers) {
            const outHeaders = ctx.proxyToServerRequestOptions.headers as Record<string, string>;
            if (finalBodyBuf.length > 0 || outHeaders['content-length'] !== undefined) {
              outHeaders['content-length'] = String(finalBodyBuf.length);
              delete outHeaders['transfer-encoding'];
            }
          }

          c.prebufferedBody = finalBodyBuf;

          const finalParsed = new URL(finalUrl);
          const finalPreview = formatBufferPreview(finalBodyBuf, finalHeaders);
          const packet: CapturedPacket = {
            id: requestId,
            timestamp: startedAtWall,
            method: finalMethod,
            url: finalUrl,
            host: finalParsed.host,
            path: `${finalParsed.pathname}${finalParsed.search}`,
            headers: finalHeaders,
            body: finalPreview.text,
            bodySize: finalBodyBuf.length,
            bodyTruncated,
            isBinary: finalPreview.isBinary,
            status: 'pending',
            tags: [],
            bookmarked: false,
            timing: { startedAt: startedAtWall },
          };

          c.capturedPacket = packet;
          this.persistCapturedRequest(packet);
          this.broadcast('requestCaptured', packet);

          ctx.onRequestEnd((innerCtx, endCb) => {
            if (innerCtx.proxyToServerRequest && finalBodyBuf.length > 0 && !innerCtx.proxyToServerRequest.writableEnded) {
              innerCtx.proxyToServerRequest.write(finalBodyBuf);
            }
            endCb();
          });

          return safeCallback();
        }

        // Fast streaming passthrough mode (zero full-body buffering!)
        const reqCap = new BoundedBuffer(this.settings.maxReqBodyCaptureBytes);
        c.reqCap = reqCap;
        c.fullUrl = fullUrl;
        c.reqHeaders = reqHeaders;
        c.parsedUrl = parsedUrl;
        c.method = method;

        ctx.onRequestData((_innerCtx, chunk, dataCb) => {
          reqCap.append(chunk);
          // Stream immediately upstream without holding chunks
          return dataCb(null, chunk);
        });

        ctx.onRequestEnd((_innerCtx, endCb) => {
          const capBuf = reqCap.toBuffer();
          const preview = formatBufferPreview(capBuf, reqHeaders);
          const packet: CapturedPacket = {
            id: requestId,
            timestamp: startedAtWall,
            method,
            url: fullUrl,
            host: parsedUrl.host,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            headers: reqHeaders,
            body: preview.text,
            bodySize: reqCap.totalBytes,
            bodyTruncated: reqCap.truncated,
            isBinary: preview.isBinary,
            status: 'pending',
            tags: [],
            bookmarked: false,
            timing: { startedAt: startedAtWall },
          };
          reqCap.clear();
          c.capturedPacket = packet;
          this.persistCapturedRequest(packet);
          this.broadcast('requestCaptured', packet);
          endCb();
        });

        return safeCallback();
      } catch (err) {
        this.activeRequests.delete(requestId);
        this.stats.totalErrors++;
        logEvent('error', 'proxy', 'onRequest error', {
          error: err instanceof Error ? err.message : String(err),
        });
        return safeCallback(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.mitmProxy.onResponse((ctx, callback) => {
      const c = ctx as any;
      const requestId: string = c.requestId || uuidv4();
      const activeEntry: ActiveRequestEntry | undefined = c.activeEntry;
      if (activeEntry?.aborted || ctx.proxyToClientResponse.destroyed || ctx.proxyToClientResponse.writableEnded) {
        this.activeRequests.delete(requestId);
        return callback();
      }

      const headersAtPerf = performance.now();
      const ttfbMs = c.startedAtPerf ? Math.round(headersAtPerf - c.startedAtPerf) : undefined;
      const statusCode = ctx.serverToProxyResponse?.statusCode || 200;
      const method = (ctx.clientToProxyRequest.method || 'GET').toUpperCase();
      const resHeaders = normalizeHeadersRecord(ctx.serverToProxyResponse?.headers);
      const reqUrl =
        c.capturedPacket?.url ||
        buildFullRequestUrl(ctx.isSSL, ctx.clientToProxyRequest.headers.host, ctx.clientToProxyRequest.url);
      let reqHost = 'unknown';
      let reqPath = '/';
      try {
        const u = new URL(reqUrl);
        reqHost = u.host;
        reqPath = `${u.pathname}${u.search}`;
      } catch {
        // fallback
      }

      const isIgnored = this.isDomainIgnored(reqHost);
      const breakpointHit = !isIgnored && this.matchesBreakpoint('response', method, reqHost, reqPath);
      const shouldInterceptResponse = Boolean(
        c.interceptResponse || (this.responseGateEnabled && !isIgnored) || breakpointHit
      );
      const hasActiveResBodyRules = this.replacementRules.some(
        (r) => r.active && r.type === 'body' && (r.phase === 'response' || r.phase === 'both')
      );

      // Responses without bodies (204, 304, HEAD, 1xx) must NOT trigger transfer-encoding: chunked
      const noBodyResponse =
        method === 'HEAD' || statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200);

      if (noBodyResponse) {
        const totalMs = c.startedAtPerf ? Math.round(performance.now() - c.startedAtPerf) : 0;
        const passive = runPassiveScan(resHeaders, '', reqUrl, false);
        this.finalizeResponse(requestId, c.capturedPacket, {
          statusCode,
          headers: resHeaders,
          body: '',
          bodySize: 0,
          bodyTruncated: false,
          isBinary: false,
          duration: totalMs,
          ttfbMs,
          passiveAnalysis: passive,
        });
        this.activeRequests.delete(requestId);
        return callback();
      }

      // If intercepting or modifying response body, transparently decompress so body can be edited cleanly
      const contentEncoding = (resHeaders['content-encoding'] || '').toLowerCase().trim();
      const canDecompressForEdit =
        (shouldInterceptResponse || hasActiveResBodyRules) &&
        (contentEncoding === 'gzip' || contentEncoding === 'x-gzip' || contentEncoding === 'deflate' || contentEncoding === 'br');

      if (canDecompressForEdit) {
        delete ctx.serverToProxyResponse!.headers['content-encoding'];
        delete ctx.serverToProxyResponse!.headers['content-length'];
        delete resHeaders['content-encoding'];
        if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
          ctx.addResponseFilter(zlib.createGunzip());
        } else if (contentEncoding === 'deflate') {
          ctx.addResponseFilter(zlib.createInflate());
        } else if (contentEncoding === 'br') {
          ctx.addResponseFilter(zlib.createBrotliDecompress());
        }
      }

      if (shouldInterceptResponse || hasActiveResBodyRules) {
        const interceptBuf = new BoundedBuffer(this.settings.maxInterceptBodyBytes);
        let overflowed = false;

        ctx.onResponseData((innerCtx, chunk, dataCb) => {
          if (overflowed) {
            return dataCb(null, chunk);
          }
          if (interceptBuf.totalBytes + chunk.length > this.settings.maxInterceptBodyBytes) {
            // Switch safely to streaming passthrough instead of OOMing
            overflowed = true;
            const bufferedSoFar = interceptBuf.toBuffer();
            if (bufferedSoFar.length > 0) {
              innerCtx.proxyToClientResponse.write(bufferedSoFar);
            }
            interceptBuf.append(chunk);
            return dataCb(null, chunk);
          }
          interceptBuf.append(chunk);
          return dataCb(null, null); // Hold until onResponseEnd
        });

        ctx.onResponseEnd(async (innerCtx, endCb) => {
          try {
            if (overflowed) {
              const totalMs = c.startedAtPerf ? Math.round(performance.now() - c.startedAtPerf) : 0;
              const capBuf = interceptBuf.toBuffer();
              const preview = formatBufferPreview(capBuf, resHeaders);
              interceptBuf.clear();
              const passive = runPassiveScan(resHeaders, preview.text, reqUrl, preview.isBinary);
              this.finalizeResponse(requestId, c.capturedPacket, {
                statusCode,
                headers: resHeaders,
                body: preview.text,
                bodySize: interceptBuf.totalBytes,
                bodyTruncated: true,
                isBinary: preview.isBinary,
                duration: totalMs,
                ttfbMs,
                passiveAnalysis: passive,
              });
              this.activeRequests.delete(requestId);
              return endCb();
            }

            let finalBuf = interceptBuf.toBuffer();
            interceptBuf.clear();
            const preview = formatBufferPreview(finalBuf, resHeaders);
            let editableText = preview.isBinary ? '' : preview.text;

            if (hasActiveResBodyRules && !preview.isBinary) {
              let modified = editableText;
              for (const rule of this.replacementRules) {
                if (rule.active && rule.type === 'body' && (rule.phase === 'response' || rule.phase === 'both')) {
                  modified = applyStringRule(modified, rule);
                }
              }
              if (modified !== editableText) {
                editableText = modified;
                finalBuf = Buffer.from(modified, 'utf8');
              }
            }

            if (shouldInterceptResponse && !activeEntry?.aborted && this.responseReviewQueue.size < this.settings.maxPendingIntercepts) {
              const decision = await new Promise<InterceptDecision>((resolve) => {
                this.responseReviewQueue.set(requestId, {
                  resolve,
                  timestamp: Date.now(),
                  kind: 'response',
                });
                this.broadcast('RESPONSE_PENDING', {
                  id: requestId,
                  statusCode,
                  headers: resHeaders,
                  body: preview.isBinary ? preview.text : editableText,
                  bodySize: finalBuf.length,
                  bodyTruncated: false,
                  isBinary: preview.isBinary,
                  url: reqUrl,
                  status: 'response_intercepted',
                  timestamp: Date.now(),
                });
              });

              if (decision.action === 'drop' || activeEntry?.aborted) {
                if (!innerCtx.proxyToClientResponse.destroyed) {
                  innerCtx.proxyToClientResponse.destroy();
                }
                this.activeRequests.delete(requestId);
                return endCb();
              }
              if (decision.modifiedBody !== undefined && !preview.isBinary) {
                finalBuf = Buffer.from(decision.modifiedBody, 'utf8');
              }
            }

            if (finalBuf.length > 0 && !innerCtx.proxyToClientResponse.writableEnded) {
              innerCtx.proxyToClientResponse.write(finalBuf);
            }

            const totalMs = c.startedAtPerf ? Math.round(performance.now() - c.startedAtPerf) : 0;
            const finalPreview = formatBufferPreview(finalBuf, resHeaders);
            const passive = runPassiveScan(resHeaders, finalPreview.text, reqUrl, finalPreview.isBinary);
            this.finalizeResponse(requestId, c.capturedPacket, {
              statusCode,
              headers: resHeaders,
              body: finalPreview.text,
              bodySize: finalBuf.length,
              bodyTruncated: false,
              isBinary: finalPreview.isBinary,
              duration: totalMs,
              ttfbMs,
              passiveAnalysis: passive,
            });
            this.activeRequests.delete(requestId);
            return endCb();
          } catch (err) {
            this.activeRequests.delete(requestId);
            return endCb(err instanceof Error ? err : new Error(String(err)));
          }
        });

        // CRITICAL: invoke onResponse callback so http-mitm-proxy resumes serverToProxyResponse!
        return callback();
      }

      // Fast streaming response capture (preserves original wire bytes & compression!)
      const resCap = new BoundedBuffer(this.settings.maxResBodyCaptureBytes);
      ctx.onResponseData((_innerCtx, chunk, dataCb) => {
        resCap.append(chunk);
        return dataCb(null, chunk);
      });

      ctx.onResponseEnd(async (_innerCtx, endCb) => {
        const totalMs = c.startedAtPerf ? Math.round(performance.now() - c.startedAtPerf) : 0;
        const capBuf = resCap.toBuffer();
        const totalBytes = resCap.totalBytes;
        const truncated = resCap.truncated;
        resCap.clear();
        this.activeRequests.delete(requestId);

        let inspectionBuf = capBuf;
        if (!truncated && contentEncoding) {
          const dec = await decodeBodyForInspection(
            capBuf,
            contentEncoding,
            this.settings.maxResBodyCaptureBytes * 2
          );
          if (!dec.decodeError) {
            inspectionBuf = dec.decoded;
          }
        }
        const preview = formatBufferPreview(inspectionBuf, resHeaders);
        const passive = runPassiveScan(resHeaders, preview.text, reqUrl, preview.isBinary);
        this.finalizeResponse(requestId, c.capturedPacket, {
          statusCode,
          headers: resHeaders,
          body: preview.text,
          bodySize: totalBytes,
          bodyTruncated: truncated,
          isBinary: preview.isBinary,
          duration: totalMs,
          ttfbMs,
          passiveAnalysis: passive,
        });

        endCb();
      });

      return callback();
    });

    // WebSocket MITM inspection hooks
    this.mitmProxy.onWebSocketConnection((ctx: IWebSocketContext, callback) => {
      const wsId = ctx.uuid || uuidv4();
      (ctx as any)._psConnId = wsId;
      const wsUrl = ctx.proxyToServerWebSocketOptions?.url || 'ws://unknown';
      let host = 'unknown';
      try {
        host = new URL(wsUrl).host;
      } catch {
        // ignore
      }
      const record: WebSocketConnectionRecord = {
        id: wsId,
        url: wsUrl,
        host,
        isSSL: Boolean(ctx.isSSL),
        startedAt: Date.now(),
        status: 'open',
        frameCount: 0,
        bytesIn: 0,
        bytesOut: 0,
      };
      // Bound connection history to 200 entries
      if (this.wsConnections.size >= 200) {
        const oldest = this.wsConnections.keys().next().value;
        if (oldest) this.wsConnections.delete(oldest);
      }
      this.wsConnections.set(wsId, record);
      this.broadcast('wsConnection', record);
      callback();
    });

    this.mitmProxy.onWebSocketFrame((ctx, type, fromServer, data, flags, callback) => {
      try {
        const wsId = (ctx as any)._psConnId || ctx.uuid;
        const rawBuf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        const isBinary = typeof flags === 'boolean' ? flags : Boolean((flags as any)?.binary);
        const truncated = rawBuf.length > this.config.maxWsFrameBytes;
        const slice = truncated ? rawBuf.subarray(0, this.config.maxWsFrameBytes) : rawBuf;

        let payloadText: string;
        if (isBinary) {
          payloadText = slice.subarray(0, 1024).toString('hex').replace(/(..)/g, '$1 ').trim();
        } else {
          payloadText = slice.toString('utf8');
        }

        const conn = this.wsConnections.get(wsId);
        if (conn) {
          conn.frameCount++;
          if (fromServer) conn.bytesIn += rawBuf.length;
          else conn.bytesOut += rawBuf.length;
        }

        const frame: WebSocketFrameRecord = {
          id: uuidv4(),
          connectionId: wsId,
          timestamp: Date.now(),
          direction: fromServer ? 'server_to_client' : 'client_to_server',
          frameType: (type as 'message' | 'ping' | 'pong') || 'message',
          isBinary,
          size: rawBuf.length,
          truncated,
          payload: payloadText,
          url: conn?.url || ctx.proxyToServerWebSocketOptions?.url || '',
        };

        this.wsFrames.unshift(frame);
        if (this.wsFrames.length > this.config.maxWsFramesInMemory) {
          this.wsFrames.length = this.config.maxWsFramesInMemory;
        }
        this.broadcast('wsFrame', { frame, connection: conn });
      } catch (err) {
        logEvent('warn', 'proxy-ws', 'Failed to inspect WS frame', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      callback(null, data, flags);
    });

    this.mitmProxy.onWebSocketClose((ctx, code, _message, callback) => {
      const wsId = (ctx as any)._psConnId || ctx.uuid;
      const conn = this.wsConnections.get(wsId);
      if (conn) {
        conn.status = 'closed';
        conn.closedAt = Date.now();
        conn.closeCode = code;
        this.broadcast('wsConnection', conn);
      }
      callback(null);
    });

    this.mitmProxy.onWebSocketError((ctx, err) => {
      const wsId = (ctx as any)?._psConnId || ctx?.uuid;
      if (wsId) {
        const conn = this.wsConnections.get(wsId);
        if (conn) {
          conn.status = 'error';
          conn.closedAt = Date.now();
          this.broadcast('wsConnection', conn);
        }
      }
      logEvent('debug', 'proxy-ws', 'MITM WebSocket error', { error: err?.message });
    });

    this.mitmProxy.onError((ctx, err) => {
      const errString = (err?.message || err?.toString() || '').toLowerCase();
      const errorCode = (err as any)?.code;
      const reqId = (ctx as any)?.requestId;
      if (reqId) this.activeRequests.delete(reqId);

      if (
        errString.includes('aborted') ||
        errString.includes('socket hang up') ||
        errString.includes('econnreset') ||
        errString.includes('epipe') ||
        errorCode === 'ECONNRESET' ||
        errorCode === 'EPIPE'
      ) {
        return;
      }

      this.stats.totalErrors++;
      const host = ctx?.clientToProxyRequest?.headers?.host || 'unknown';
      let advice = '';
      if (errString.includes('eproto')) {
        advice = 'SSL Protocol Error. Ensure the CA cert is trusted or check server TLS compatibility.';
      } else if (errString.includes('econnrefused')) {
        advice = 'Connection Refused. Target server is unreachable.';
      } else if (errString.includes('cert') || errString.includes('unable_to_verify') || errString.includes('self_signed')) {
        advice =
          'Upstream TLS Certificate Verification Failed. For self-signed test targets, you may explicitly enable "Allow Insecure Upstream TLS" in Proxy Settings.';
      }

      logEvent('warn', 'proxy', `MITM Proxy error [${host}]`, { error: err?.message, code: errorCode });
      this.broadcast('proxyError', {
        message: err?.message || errString,
        host,
        isSSL: Boolean(ctx?.isSSL),
        advice,
      });
    });
  }

  private persistCapturedRequest(packet: CapturedPacket): void {
    this.stats.totalCaptured++;
    if (packet.bodyTruncated) this.stats.totalTruncated++;
    this.stats.inMemoryBytesEstimate = Math.min(
      this.config.maxMemoryTrafficBudgetBytes,
      packet.bodySize
    );
    this.db.enqueueUpsertPacket({
      ...packet,
      contentType: packet.headers['content-type'],
    });
  }

  private finalizeResponse(
    requestId: string,
    fallbackPacket: CapturedPacket | undefined,
    data: {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
      bodySize: number;
      bodyTruncated: boolean;
      isBinary: boolean;
      duration: number;
      ttfbMs?: number;
      passiveAnalysis: string | null;
    }
  ): void {
    if (data.bodyTruncated) this.stats.totalTruncated++;
    const now = Date.now();
    const timing = fallbackPacket?.timing
      ? {
          ...fallbackPacket.timing,
          completedAt: now,
          ttfbMs: data.ttfbMs,
          totalMs: data.duration,
        }
      : undefined;

    if (fallbackPacket) {
      fallbackPacket.status = 'completed';
      fallbackPacket.timing = timing;
      fallbackPacket.response = {
        statusCode: data.statusCode,
        headers: data.headers,
        body: data.body,
        bodySize: data.bodySize,
        bodyTruncated: data.bodyTruncated,
        isBinary: data.isBinary,
        timestamp: now,
        duration: data.duration,
        passiveAnalysis: data.passiveAnalysis,
      };
    }

    this.db.enqueueUpdateResponse({
      id: requestId,
      status: 'completed',
      statusCode: data.statusCode,
      headers: data.headers,
      body: data.body,
      bodySize: data.bodySize,
      bodyTruncated: data.bodyTruncated,
      isBinary: data.isBinary,
      duration: data.duration,
      passiveAnalysis: data.passiveAnalysis,
      timing,
      fallbackPacket,
    });

    this.broadcast('responseCaptured', {
      id: requestId,
      status: 'completed',
      statusCode: data.statusCode,
      headers: data.headers,
      body: data.body,
      bodySize: data.bodySize,
      bodyTruncated: data.bodyTruncated,
      isBinary: data.isBinary,
      timestamp: now,
      duration: data.duration,
      passiveAnalysis: data.passiveAnalysis,
      timing,
    });
  }

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.mitmProxy.listen(
        {
          port: this.config.proxyPort,
          host: this.config.proxyHost,
          sslCaDir: this.config.certDir,
          keepAlive: true,
          timeout: this.settings.upstreamTimeoutMs,
          forceSNI: false,
        },
        (err?: Error | null) => {
          if (err) {
            this.proxyRunning = false;
            logEvent('error', 'proxy', 'MITM Proxy failed to start', {
              port: this.config.proxyPort,
              error: err.message,
            });
            reject(err);
          } else {
            this.proxyRunning = true;
            this.ensureCertDirPermissions();
            // Retrieve actual bound port if proxyPort was 0 in tests
            const addr = (this.mitmProxy as any).httpServer?.address();
            const boundPort = typeof addr === 'object' && addr?.port ? addr.port : this.config.proxyPort;
            logEvent('info', 'proxy', 'HTTPS Diagnostic MITM Gateway listening', {
              host: this.config.proxyHost,
              port: boundPort,
              tlsVerification: !this.settings.allowInsecureTls,
            });
            resolve({ host: this.config.proxyHost, port: boundPort });
          }
        }
      );
    });
  }

  resolveIntercept(id: string, decision: InterceptDecision): boolean {
    if (this.responseReviewQueue.has(id)) {
      const entry = this.responseReviewQueue.get(id)!;
      this.responseReviewQueue.delete(id);
      entry.resolve(decision);
      return true;
    }
    if (this.trafficGate.has(id)) {
      const entry = this.trafficGate.get(id)!;
      this.trafficGate.delete(id);
      entry.resolve(decision);
      return true;
    }
    return false;
  }

  getWebSocketConnections(): WebSocketConnectionRecord[] {
    return Array.from(this.wsConnections.values()).sort((a, b) => b.startedAt - a.startedAt);
  }

  getWebSocketFrames(connectionId?: string): WebSocketFrameRecord[] {
    if (!connectionId) return this.wsFrames;
    return this.wsFrames.filter((f) => f.connectionId === connectionId);
  }

  clearWebSocketHistory(): void {
    this.wsFrames = [];
    for (const [id, conn] of this.wsConnections.entries()) {
      if (conn.status !== 'open') {
        this.wsConnections.delete(id);
      }
    }
  }

  getActiveCounts() {
    let activeMitmWsConnections = 0;
    for (const conn of this.wsConnections.values()) {
      if (conn.status === 'open') activeMitmWsConnections++;
    }
    return {
      activeProxyRequests: this.activeRequests.size,
      pendingRequestIntercepts: this.trafficGate.size,
      pendingResponseIntercepts: this.responseReviewQueue.size,
      activeMitmWsConnections,
    };
  }

  async close(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    for (const [, entry] of this.trafficGate) {
      entry.resolve({ action: 'drop' });
    }
    this.trafficGate.clear();
    for (const [, entry] of this.responseReviewQueue) {
      entry.resolve({ action: 'drop' });
    }
    this.responseReviewQueue.clear();
    for (const [, req] of this.activeRequests) {
      req.abortController.abort();
    }
    this.activeRequests.clear();

    try {
      const mp = this.mitmProxy as any;
      mp.httpServer?.closeAllConnections?.();
      mp.httpsServer?.closeAllConnections?.();
      if (mp.sslServers) {
        for (const srv of Object.values(mp.sslServers) as any[]) {
          srv?.server?.closeAllConnections?.();
        }
      }
      mp.httpAgent?.destroy?.();
      mp.httpsAgent?.destroy?.();
      this.mitmProxy.close();
    } catch {
      // Ignore close error
    }
    this.proxyRunning = false;
  }
}
