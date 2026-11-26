import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSafeRegex,
  isAllowedHostHeader,
  isLocalOrigin,
  redactHeaders,
  redactSensitiveText,
  redactUrlSecrets,
  validateOutboundTarget,
  validateReplaceRules,
  verifyWebSocketUpgradeRequest,
} from '../server/security.js';
import { resolveGeminiModel, DEFAULT_GEMINI_MODEL } from '../server/config.js';
import type { TargetScopeConfig } from '../server/types.js';

test('ReDoS protection rejects catastrophic backtracking patterns', () => {
  const bad1 = compileSafeRegex('(a+)+');
  assert.ok(bad1.error);
  const bad2 = compileSafeRegex('(.*)*');
  assert.ok(bad2.error);
  const good = compileSafeRegex('^/api/v[0-9]+/users$');
  assert.ok(good.regex);

  const rulesCheck = validateReplaceRules([
    { id: '1', type: 'body', match: '(a+)+', replace: 'x', active: true },
  ]);
  assert.equal(rulesCheck.valid, false);
});

test('SSRF and Target Scope validator blocks internal/metadata targets by default', async () => {
  const strictScope: TargetScopeConfig = {
    enforceScope: true,
    allowLocalhost: false,
    allowPrivateNetworks: false,
    allowedHosts: ['example.com'],
    excludedHosts: ['admin.example.com'],
    maxRepeaterRedirects: 5,
  };

  const metadata = await validateOutboundTarget('http://169.254.169.254/latest/meta-data', strictScope);
  assert.equal(metadata.allowed, false);

  const loopback = await validateOutboundTarget('http://127.0.0.1:3000/api/health', strictScope);
  assert.equal(loopback.allowed, false);

  const fileProto = await validateOutboundTarget('file:///etc/passwd', strictScope);
  assert.equal(fileProto.allowed, false);

  const excluded = await validateOutboundTarget('https://admin.example.com/', strictScope);
  assert.equal(excluded.allowed, false);

  // Localhost explicitly allowed for local diagnostic testing
  const localAllowedScope: TargetScopeConfig = {
    ...strictScope,
    allowLocalhost: true,
  };
  const localOk = await validateOutboundTarget('http://127.0.0.1:8080/test', localAllowedScope);
  assert.equal(localOk.allowed, true);
});

test('Redaction strips Authorization, Cookies, JWTs, API keys, and URL secrets', () => {
  const hdrs = redactHeaders({
    Authorization: 'Bearer secret.jwt.token',
    Cookie: 'session=abc123',
    'Content-Type': 'application/json',
  });
  assert.equal(hdrs.Authorization, '[REDACTED]');
  assert.equal(hdrs.Cookie, '[REDACTED]');
  assert.equal(hdrs['Content-Type'], 'application/json');

  const body = redactSensitiveText('{"apiKey":"AIzaSyDummyKey1234567890123456789012345","ok":true}');
  assert.ok(!body.includes('AIzaSyDummyKey'));

  const url = redactUrlSecrets('https://example.com/cb?token=topsecret&page=2');
  assert.ok(url.includes('token=%5BREDACTED%5D'));
  assert.ok(url.includes('page=2'));
});

test('Local API Host, Origin, and WebSocket upgrade guards reject cross-origin requests', () => {
  assert.equal(isAllowedHostHeader('127.0.0.1:3000', 3000, '127.0.0.1'), true);
  assert.equal(isAllowedHostHeader('evil.com:3000', 3000, '127.0.0.1'), false);

  assert.equal(isLocalOrigin('http://127.0.0.1:3000', 3000, '127.0.0.1'), true);
  assert.equal(isLocalOrigin('https://evil.com', 3000, '127.0.0.1'), false);

  const wsReject = verifyWebSocketUpgradeRequest(
    {
      headers: { host: '127.0.0.1:3000', origin: 'https://attacker.example' },
      url: '/api/ws?token=abc',
    } as any,
    { port: 3000, host: '127.0.0.1', apiToken: 'abc', requireToken: true }
  );
  assert.equal(wsReject.ok, false);

  const wsOk = verifyWebSocketUpgradeRequest(
    {
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      url: '/api/ws?token=abc',
    } as any,
    { port: 3000, host: '127.0.0.1', apiToken: 'abc', requireToken: true }
  );
  assert.equal(wsOk.ok, true);
});

test('Gemini model validation rejects obsolete models and falls back safely', () => {
  const obsolete = resolveGeminiModel('gemini-1.5-pro');
  assert.equal(obsolete.model, DEFAULT_GEMINI_MODEL);
  assert.ok(obsolete.warning);

  const valid = resolveGeminiModel('gemini-2.5-pro');
  assert.equal(valid.model, 'gemini-2.5-pro');
  assert.equal(valid.warning, null);
});
