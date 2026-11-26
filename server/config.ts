import path from 'node:path';
import crypto from 'node:crypto';
import type { RuntimeProxySettings } from './types.js';

export const SUPPORTED_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
] as const;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export interface AppConfig {
  host: string;
  port: number;
  proxyHost: string;
  proxyPort: number;
  dataDir: string;
  dbPath: string;
  legacyJsonDbPath: string;
  certDir: string;
  apiToken: string;
  requireApiToken: boolean;
  geminiApiKey: string | null;
  geminiModel: string;
  geminiModelWarning: string | null;
  geminiTimeoutMs: number;
  geminiMaxPromptChars: number;
  maxMemoryTrafficBudgetBytes: number;
  maxWsFramesInMemory: number;
  maxWsFrameBytes: number;
  wsMaxPayloadBytes: number;
  apiMaxJsonBytes: string;
  defaults: RuntimeProxySettings;
}

export function resolveGeminiModel(configured?: string): {
  model: string;
  warning: string | null;
} {
  const candidate = (configured || '').trim();
  if (!candidate) {
    return { model: DEFAULT_GEMINI_MODEL, warning: null };
  }
  if ((SUPPORTED_GEMINI_MODELS as readonly string[]).includes(candidate)) {
    return { model: candidate, warning: null };
  }
  return {
    model: DEFAULT_GEMINI_MODEL,
    warning: `Configured GEMINI_MODEL "${candidate}" is unsupported or obsolete; using "${DEFAULT_GEMINI_MODEL}". Supported: ${SUPPORTED_GEMINI_MODELS.join(', ')}`,
  };
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.PROXYSUITE_DATA_DIR || process.cwd());
  const dbPath = path.resolve(dataDir, process.env.PROXYSUITE_DB_FILE || 'proxysuite.db');
  const legacyJsonDbPath = path.resolve(
    process.env.PROXYSUITE_LEGACY_JSON_DIR || process.cwd(),
    'proxy-traffic.json'
  );
  const certDir = path.resolve(dataDir, process.env.PROXYSUITE_CERT_DIR || '.http-mitm-proxy');
  const { model: geminiModel, warning: geminiModelWarning } = resolveGeminiModel(
    process.env.GEMINI_MODEL
  );

  const apiToken = process.env.PROXYSUITE_API_TOKEN?.trim() || crypto.randomBytes(24).toString('hex');

  return {
    host: process.env.HOST?.trim() || '127.0.0.1',
    port: parseIntEnv('PORT', 3000, 1, 65535),
    proxyHost: process.env.PROXY_HOST?.trim() || '127.0.0.1',
    proxyPort: parseIntEnv('PROXY_PORT', 8082, 1, 65535),
    dataDir,
    dbPath,
    legacyJsonDbPath,
    certDir,
    apiToken,
    requireApiToken: parseBoolEnv('PROXYSUITE_REQUIRE_TOKEN', true),
    geminiApiKey: process.env.GEMINI_API_KEY?.trim() || null,
    geminiModel,
    geminiModelWarning,
    geminiTimeoutMs: parseIntEnv('GEMINI_TIMEOUT_MS', 30_000, 3_000, 120_000),
    geminiMaxPromptChars: parseIntEnv('GEMINI_MAX_PROMPT_CHARS', 24_000, 2_000, 100_000),
    maxMemoryTrafficBudgetBytes: parseIntEnv(
      'MAX_MEMORY_TRAFFIC_BUDGET_BYTES',
      64 * 1024 * 1024,
      4 * 1024 * 1024,
      512 * 1024 * 1024
    ),
    maxWsFramesInMemory: parseIntEnv('MAX_WS_FRAMES', 1000, 50, 10000),
    maxWsFrameBytes: parseIntEnv('MAX_WS_FRAME_BYTES', 64 * 1024, 1024, 2 * 1024 * 1024),
    wsMaxPayloadBytes: parseIntEnv('WS_MAX_PAYLOAD_BYTES', 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
    apiMaxJsonBytes: process.env.API_MAX_JSON_BYTES || '16mb',
    defaults: {
      allowInsecureTls: parseBoolEnv('ALLOW_INSECURE_TLS', false),
      maxReqBodyCaptureBytes: parseIntEnv('MAX_REQ_BODY_CAPTURE_BYTES', 1024 * 1024, 1024, 32 * 1024 * 1024),
      maxResBodyCaptureBytes: parseIntEnv('MAX_RES_BODY_CAPTURE_BYTES', 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
      maxInterceptBodyBytes: parseIntEnv('MAX_INTERCEPT_BODY_BYTES', 5 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
      maxActiveRequests: parseIntEnv('MAX_ACTIVE_REQUESTS', 500, 10, 5000),
      maxPendingIntercepts: parseIntEnv('MAX_PENDING_INTERCEPTS', 100, 5, 1000),
      interceptTimeoutMs: parseIntEnv('INTERCEPT_TIMEOUT_MS', 5 * 60 * 1000, 5000, 30 * 60 * 1000),
      upstreamTimeoutMs: parseIntEnv('UPSTREAM_TIMEOUT_MS', 60_000, 1000, 300_000),
      retention: {
        enabled: false,
        maxRecords: parseIntEnv('RETENTION_MAX_RECORDS', 10_000, 100, 200_000),
        maxAgeHours: parseIntEnv('RETENTION_MAX_AGE_HOURS', 168, 1, 8760),
      },
      targetScope: {
        enforceScope: true,
        allowLocalhost: parseBoolEnv('SCOPE_ALLOW_LOCALHOST', false),
        allowPrivateNetworks: parseBoolEnv('SCOPE_ALLOW_PRIVATE_NETWORKS', false),
        allowedHosts: [],
        excludedHosts: [],
        maxRepeaterRedirects: 5,
      },
    },
  };
}
