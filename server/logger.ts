import { redactSensitiveText, redactUrlSecrets } from './security.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function logEvent(
  level: LogLevel,
  component: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  const safeMeta = meta ? sanitizeMeta(meta) : undefined;
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    message: redactSensitiveText(message),
    ...(safeMeta ? { meta: safeMeta } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else if (level === 'debug' && process.env.PROXYSUITE_DEBUG !== '1') {
    return;
  } else {
    console.log(line);
  }
}

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const lower = k.toLowerCase();
    if (lower.includes('key') || lower.includes('token') || lower.includes('secret') || lower.includes('password')) {
      out[k] = '[REDACTED]';
    } else if (lower === 'url' && typeof v === 'string') {
      out[k] = redactUrlSecrets(v);
    } else if (typeof v === 'string') {
      out[k] = redactSensitiveText(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
