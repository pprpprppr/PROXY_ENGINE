import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import type { TargetScopeConfig, ReplaceRule } from './types.js';

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'api-key',
  'apikey',
]);

const REDACTED_MARKER = '[REDACTED]';

export function redactSensitiveText(input: string): string {
  if (!input) return input;
  return input
    // Bearer / Basic / JWT tokens
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    // Common cloud / API keys
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bAIza[0-9A-Za-z\-_]{35}\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/("(?:password|passwd|secret|token|apiKey|api_key|access_token|refresh_token|client_secret)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

export function redactHeaders(headers: Record<string, string> | undefined | null): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower) || lower.includes('token') || lower.includes('secret') || lower.includes('key')) {
      result[k] = REDACTED_MARKER;
    } else {
      result[k] = redactSensitiveText(String(v));
    }
  }
  return result;
}

export function redactUrlSecrets(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const [k] of parsed.searchParams.entries()) {
      const lower = k.toLowerCase();
      if (
        lower.includes('token') ||
        lower.includes('key') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('auth') ||
        lower.includes('sig')
      ) {
        parsed.searchParams.set(k, REDACTED_MARKER);
      }
    }
    if (parsed.password) parsed.password = REDACTED_MARKER;
    return parsed.toString();
  } catch {
    return redactSensitiveText(rawUrl);
  }
}

/**
 * Compile user regex safely by guarding against catastrophic backtracking (ReDoS).
 */
export function compileSafeRegex(pattern: string, flags = 'g'): { regex?: RegExp; error?: string } {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { error: 'Pattern must be a non-empty string' };
  }
  if (pattern.length > 256) {
    return { error: 'Pattern exceeds maximum length of 256 characters' };
  }
  // Detect common catastrophic nested quantifier / ambiguous alternation patterns
  const dangerousPatterns = [
    /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/, // (a+)+, (.*)*, (a+){2,}
    /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)[+*{]/, // (a|a)+
    /(\.\*){2,}/, // .*.*
    /(\.\+){2,}/, // .+.+
  ];
  for (const dp of dangerousPatterns) {
    if (dp.test(pattern)) {
      return { error: 'Regex rejected due to potential catastrophic backtracking (ReDoS risk)' };
    }
  }
  try {
    return { regex: new RegExp(pattern, flags) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid regular expression' };
  }
}

export function validateReplaceRules(rules: unknown): { valid: boolean; rules?: ReplaceRule[]; error?: string } {
  if (!Array.isArray(rules)) {
    return { valid: false, error: 'Rules payload must be an array' };
  }
  if (rules.length > 100) {
    return { valid: false, error: 'Maximum of 100 replacement rules allowed' };
  }
  const normalized: ReplaceRule[] = [];
  for (const item of rules) {
    if (!item || typeof item !== 'object') {
      return { valid: false, error: 'Invalid rule object' };
    }
    const r = item as Record<string, unknown>;
    const type = r.type;
    if (type !== 'header' && type !== 'body' && type !== 'url') {
      return { valid: false, error: `Invalid rule type: ${String(type)}` };
    }
    const match = typeof r.match === 'string' ? r.match : '';
    const replace = typeof r.replace === 'string' ? r.replace : '';
    if (replace.length > 10_000) {
      return { valid: false, error: 'Replacement text exceeds 10,000 characters' };
    }
    const isRegex = r.isRegex !== false;
    if (match && isRegex) {
      const check = compileSafeRegex(match, 'g');
      if (check.error) {
        return { valid: false, error: `Invalid rule "${match}": ${check.error}` };
      }
    }
    const phase = r.phase === 'response' || r.phase === 'both' ? r.phase : 'request';
    normalized.push({
      id: typeof r.id === 'string' && r.id.length > 0 ? r.id.slice(0, 64) : crypto.randomUUID(),
      name: typeof r.name === 'string' ? r.name.slice(0, 80) : undefined,
      match,
      replace,
      type,
      phase,
      isRegex,
      active: Boolean(r.active),
    });
  }
  return { valid: true, rules: normalized };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

export function classifyIpAddress(ipRaw: string): {
  isLoopback: boolean;
  isPrivateOrReserved: boolean;
} {
  const ip = ipRaw.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    if (n === null) return { isLoopback: false, isPrivateOrReserved: true };
    const b0 = (n >>> 24) & 0xff;
    const b1 = (n >>> 16) & 0xff;
    const isLoopback = b0 === 127; // 127.0.0.0/8
    const isUnspecified = b0 === 0; // 0.0.0.0/8
    const isPrivate =
      b0 === 10 || // 10.0.0.0/8
      (b0 === 172 && b1 >= 16 && b1 <= 31) || // 172.16.0.0/12
      (b0 === 192 && b1 === 168) || // 192.168.0.0/16
      (b0 === 100 && b1 >= 64 && b1 <= 127) || // 100.64.0.0/10 CGNAT
      (b0 === 169 && b1 === 254) || // 169.254.0.0/16 Link-local / Cloud Metadata
      b0 >= 224; // Multicast / Reserved
    return { isLoopback, isPrivateOrReserved: isLoopback || isUnspecified || isPrivate };
  }

  if (net.isIPv6(ip)) {
    // Handle IPv4-mapped IPv6 ::ffff:127.0.0.1
    if (ip.startsWith('::ffff:')) {
      const mapped = ip.slice(7);
      if (net.isIPv4(mapped)) return classifyIpAddress(mapped);
    }
    const isLoopback = ip === '::1';
    const isUnspecified = ip === '::';
    const isLinkLocal = ip.startsWith('fe80:') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb');
    const isUniqueLocal = ip.startsWith('fc') || ip.startsWith('fd');
    const isMulticast = ip.startsWith('ff');
    return {
      isLoopback,
      isPrivateOrReserved: isLoopback || isUnspecified || isLinkLocal || isUniqueLocal || isMulticast,
    };
  }

  return { isLoopback: false, isPrivateOrReserved: true };
}

export function matchHostPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase().trim();
  const pat = pattern.toLowerCase().trim();
  if (!pat) return false;
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  return host === pat;
}

export async function validateOutboundTarget(
  rawUrl: string,
  scope: TargetScopeConfig
): Promise<{ allowed: boolean; normalizedUrl?: string; hostname?: string; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Unsupported protocol "${parsed.protocol}". Only http: and https: are allowed.` };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { allowed: false, reason: 'URL is missing a hostname' };
  }

  if (scope.excludedHosts.some((p) => matchHostPattern(hostname, p))) {
    return { allowed: false, reason: `Host "${hostname}" is explicitly excluded by target scope.` };
  }

  const explicitlyAllowed = scope.allowedHosts.some((p) => matchHostPattern(hostname, p));
  if (scope.enforceScope && !explicitlyAllowed) {
    const isLocalHostName = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!(scope.allowLocalhost && isLocalHostName)) {
      return {
        allowed: false,
        reason: `Host "${hostname}" is not in the configured authorized Target Scope. Add it to Target Scope in Settings before running active requests.`,
      };
    }
  }

  // Resolve DNS & guard against SSRF to loopback/private/cloud metadata IPs
  const checkIpPermission = (ip: string): string | null => {
    const { isLoopback, isPrivateOrReserved } = classifyIpAddress(ip);
    if (isLoopback) {
      if (scope.allowLocalhost || explicitlyAllowed) return null;
      return `Blocked request to loopback address (${ip}). Enable "Allow Localhost" in Target Scope for local testing.`;
    }
    if (isPrivateOrReserved) {
      if (scope.allowPrivateNetworks || explicitlyAllowed) return null;
      return `Blocked SSRF attempt to private/link-local address (${ip}).`;
    }
    return null;
  };

  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
    const err = checkIpPermission(hostname);
    if (err) return { allowed: false, reason: err };
  } else {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (addresses.length === 0) {
        return { allowed: false, reason: `DNS lookup returned no addresses for "${hostname}"` };
      }
      for (const addr of addresses) {
        const err = checkIpPermission(addr.address);
        if (err) return { allowed: false, reason: err };
      }
    } catch (err) {
      return {
        allowed: false,
        reason: `DNS resolution failed for "${hostname}": ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }

  return { allowed: true, normalizedUrl: parsed.toString(), hostname };
}

export function isLocalOrigin(origin: string | undefined, port: number, allowedHost: string): boolean {
  if (!origin) return true; // Non-browser clients (curl/tests/Electron main) omit Origin
  if (origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const validHosts = new Set(['localhost', '127.0.0.1', '[::1]', allowedHost.toLowerCase()]);
    if (!validHosts.has(parsed.hostname.toLowerCase())) {
      return false;
    }
    const originPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return originPort === port;
  } catch {
    return false;
  }
}

export function isAllowedHostHeader(hostHeader: string | undefined, port: number, allowedHost: string): boolean {
  if (!hostHeader) return false;
  const lower = hostHeader.toLowerCase();
  const candidates = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    `${allowedHost.toLowerCase()}:${port}`,
    'localhost',
    '127.0.0.1',
  ]);
  return candidates.has(lower);
}

export function createLocalSecurityMiddleware(opts: {
  port: number;
  host: string;
  apiToken: string;
  requireToken: boolean;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Validate Host header to prevent DNS rebinding
    if (!isAllowedHostHeader(req.headers.host, opts.port, opts.host)) {
      return res.status(403).json({ error: 'Forbidden: Invalid Host header' });
    }

    // Validate Origin header on API requests to prevent cross-site requests
    if (req.path.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && !isLocalOrigin(origin, opts.port, opts.host)) {
        return res.status(403).json({ error: 'Forbidden: Cross-origin API access denied' });
      }
    }

    // Bootstrap endpoint is read-only and same-origin gated; it supplies the runtime session token to the UI
    if (req.path === '/api/bootstrap' || req.path === '/api/health' || req.path === '/api/ca-cert') {
      return next();
    }

    if (req.path.startsWith('/api/') && opts.requireToken) {
      const secFetchSite = req.headers['sec-fetch-site'];
      if (secFetchSite === 'cross-site') {
        return res.status(403).json({ error: 'Forbidden: Cross-site request blocked' });
      }
      const headerToken =
        (req.headers['x-proxysuite-token'] as string | undefined) ||
        (req.headers.authorization?.startsWith('Bearer ')
          ? req.headers.authorization.slice(7).trim()
          : undefined) ||
        (typeof req.query.token === 'string' ? req.query.token : undefined);

      if (!headerToken || !timingSafeEqualStr(headerToken, opts.apiToken)) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid API session token' });
      }
    }

    return next();
  };
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyWebSocketUpgradeRequest(
  req: IncomingMessage,
  opts: { port: number; host: string; apiToken: string; requireToken: boolean }
): { ok: boolean; reason?: string } {
  if (!isAllowedHostHeader(req.headers.host, opts.port, opts.host)) {
    return { ok: false, reason: 'Invalid Host header' };
  }
  const origin = req.headers.origin;
  if (origin && !isLocalOrigin(origin, opts.port, opts.host)) {
    return { ok: false, reason: 'Cross-origin WebSocket rejected' };
  }
  if (opts.requireToken) {
    try {
      const parsed = new URL(req.url || '/api/ws', `http://127.0.0.1:${opts.port}`);
      const token = parsed.searchParams.get('token') || (req.headers['x-proxysuite-token'] as string | undefined) || '';
      if (!token || !timingSafeEqualStr(token, opts.apiToken)) {
        return { ok: false, reason: 'Invalid WebSocket token' };
      }
    } catch {
      return { ok: false, reason: 'Invalid WebSocket URL' };
    }
  }
  return { ok: true };
}
