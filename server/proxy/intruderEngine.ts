import { v4 as uuidv4 } from 'uuid';
import type { IntruderJobConfig, IntruderResultItem, TargetScopeConfig } from '../types.js';
import { validateOutboundTarget } from '../security.js';
import { logEvent } from '../logger.js';
import type { BroadcastFn } from './mitmEngine.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const MAX_CAPTURED_INTRUDER_BODY = 64 * 1024; // 64 KB per result

export interface IntruderJobState {
  jobId: string;
  status: 'running' | 'paused' | 'stopped' | 'completed';
  startedAt: number;
  current: number;
  total: number;
  abortController: AbortController;
  pauseWaiters: Array<() => void>;
}

export class IntruderEngine {
  private jobs = new Map<string, IntruderJobState>();
  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  getJob(jobId: string): IntruderJobState | undefined {
    return this.jobs.get(jobId);
  }

  pauseJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return false;
    job.status = 'paused';
    this.broadcast('fuzzStatus', { jobId, status: 'paused', current: job.current, total: job.total });
    return true;
  }

  resumeJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'paused') return false;
    job.status = 'running';
    while (job.pauseWaiters.length > 0) {
      const resolve = job.pauseWaiters.shift()!;
      resolve();
    }
    this.broadcast('fuzzStatus', { jobId, status: 'running', current: job.current, total: job.total });
    return true;
  }

  stopJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'completed' || job.status === 'stopped') return false;
    job.status = 'stopped';
    job.abortController.abort();
    while (job.pauseWaiters.length > 0) {
      const resolve = job.pauseWaiters.shift()!;
      resolve();
    }
    this.broadcast('fuzzStatus', { jobId, status: 'stopped', current: job.current, total: job.total });
    return true;
  }

  async startJob(
    config: IntruderJobConfig,
    scope: TargetScopeConfig
  ): Promise<{ jobId: string; total: number; baseline: IntruderResultItem }> {
    const maxPayloads = Math.min(500, Math.max(1, config.maxPayloads || 200));
    const payloads = config.payloads.slice(0, maxPayloads);
    const concurrency = Math.min(20, Math.max(1, config.concurrency || 5));
    const delayMs = Math.min(10_000, Math.max(0, config.delayMs || 0));
    const jitterMs = Math.min(5_000, Math.max(0, config.jitterMs || 0));
    const maxDurationMs = Math.min(10 * 60 * 1000, Math.max(5_000, config.maxDurationMs || 120_000));
    const requestTimeoutMs = Math.min(30_000, Math.max(1_000, config.requestTimeoutMs || 10_000));

    // Validate base URL & scope before launching job
    const baselineCheckUrl = config.url.replace(/\{FUZZ\}/g, 'baseline');
    const scopeCheck = await validateOutboundTarget(baselineCheckUrl, scope);
    if (!scopeCheck.allowed) {
      throw new Error(scopeCheck.reason || 'Target blocked by scope/SSRF policy');
    }

    const jobId = uuidv4();
    const abortController = new AbortController();
    const state: IntruderJobState = {
      jobId,
      status: 'running',
      startedAt: Date.now(),
      current: 0,
      total: payloads.length,
      abortController,
      pauseWaiters: [],
    };
    this.jobs.set(jobId, state);

    // Run baseline request with empty/marker probe to establish normal response signature
    const baseline = await this.executeSingle(
      0,
      'baseline',
      config,
      scope,
      requestTimeoutMs,
      abortController.signal,
      null
    );

    const deadlineTimer = setTimeout(() => {
      if (state.status === 'running' || state.status === 'paused') {
        logEvent('warn', 'intruder', 'Job reached maxDurationMs; stopping', { jobId });
        this.stopJob(jobId);
      }
    }, maxDurationMs);
    deadlineTimer.unref();

    // Bounded worker pool
    setImmediate(async () => {
      let nextIdx = 0;

      const waitIfPaused = async () => {
        while (state.status === 'paused') {
          await new Promise<void>((resolve) => state.pauseWaiters.push(resolve));
        }
      };

      const worker = async () => {
        while (true) {
          await waitIfPaused();
          if (state.status !== 'running' || abortController.signal.aborted) break;
          const idx = nextIdx++;
          if (idx >= payloads.length) break;

          const payload = payloads[idx];
          if (delayMs > 0 || jitterMs > 0) {
            const extra = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
            await new Promise((r) => setTimeout(r, delayMs + extra));
          }
          if (state.status !== 'running' || abortController.signal.aborted) break;

          const item = await this.executeSingle(
            idx + 1,
            payload,
            config,
            scope,
            requestTimeoutMs,
            abortController.signal,
            baseline
          );

          state.current++;
          this.broadcast('fuzzProgress', {
            jobId,
            current: state.current,
            total: state.total,
            results: [item],
          });
        }
      };

      try {
        const workers = Array.from({ length: Math.min(concurrency, payloads.length) }, () => worker());
        await Promise.all(workers);
      } finally {
        clearTimeout(deadlineTimer);
        if (state.status === 'running') {
          state.status = 'completed';
        }
        this.broadcast('fuzzComplete', {
          jobId,
          status: state.status,
          current: state.current,
          total: state.total,
        });
        // Retain job metadata briefly, then clean up
        setTimeout(() => this.jobs.delete(jobId), 10 * 60 * 1000).unref();
      }
    });

    return { jobId, total: payloads.length, baseline };
  }

  private async executeSingle(
    index: number,
    payload: string,
    config: IntruderJobConfig,
    scope: TargetScopeConfig,
    timeoutMs: number,
    jobSignal: AbortSignal,
    baseline: IntruderResultItem | null
  ): Promise<IntruderResultItem> {
    const reqId = uuidv4();
    const encodedForUrl = encodeURIComponent(payload);
    const targetUrl = config.url.replace(/\{FUZZ\}/g, encodedForUrl);

    const check = await validateOutboundTarget(targetUrl, scope);
    if (!check.allowed) {
      return {
        reqId,
        index,
        payload,
        statusCode: 0,
        body: '',
        bodyTruncated: false,
        length: 0,
        duration: 0,
        error: check.reason || 'Blocked by scope',
        isAnomaly: false,
        anomalyReasons: [],
      };
    }

    const cleanHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.headers || {})) {
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding') {
        continue;
      }
      cleanHeaders[k] = String(v).replace(/\{FUZZ\}/g, payload);
    }
    if (config.rotateUserAgent) {
      cleanHeaders['user-agent'] = USER_AGENTS[index % USER_AGENTS.length];
    }

    const method = (config.method || 'GET').toUpperCase();
    const bodyStr =
      config.body && method !== 'GET' && method !== 'HEAD'
        ? config.body.replace(/\{FUZZ\}/g, payload)
        : undefined;

    const reqController = new AbortController();
    const onJobAbort = () => reqController.abort();
    jobSignal.addEventListener('abort', onJobAbort, { once: true });
    const timer = setTimeout(() => reqController.abort(), timeoutMs);

    const startedAt = Date.now();
    try {
      const response = await fetch(check.normalizedUrl || targetUrl, {
        method,
        headers: cleanHeaders,
        body: bodyStr,
        redirect: 'manual',
        signal: reqController.signal,
      });
      const text = await response.text();
      const duration = Date.now() - startedAt;
      const truncated = text.length > MAX_CAPTURED_INTRUDER_BODY;
      const body = truncated ? text.slice(0, MAX_CAPTURED_INTRUDER_BODY) : text;

      const anomalyReasons: string[] = [];
      if (baseline && !baseline.error) {
        if (response.status !== baseline.statusCode) {
          anomalyReasons.push(`Status ${response.status} != baseline ${baseline.statusCode}`);
        }
        const lenDiff = Math.abs(text.length - baseline.length);
        if (lenDiff > Math.max(20, baseline.length * 0.15)) {
          anomalyReasons.push(`Length Δ ${lenDiff}B`);
        }
        if (baseline.duration > 0 && duration > baseline.duration * 3 + 500) {
          anomalyReasons.push(`Latency spike (${duration}ms vs ${baseline.duration}ms)`);
        }
      }

      return {
        reqId,
        index,
        payload,
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        bodyTruncated: truncated,
        length: text.length,
        duration,
        error: null,
        isAnomaly: anomalyReasons.length > 0,
        anomalyReasons,
      };
    } catch (err) {
      return {
        reqId,
        index,
        payload,
        statusCode: 0,
        body: '',
        bodyTruncated: false,
        length: 0,
        duration: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        isAnomaly: false,
        anomalyReasons: [],
      };
    } finally {
      clearTimeout(timer);
      jobSignal.removeEventListener('abort', onJobAbort);
    }
  }
}
