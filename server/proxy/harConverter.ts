import crypto from 'node:crypto';
import { redactHeaders, redactSensitiveText, redactUrlSecrets } from '../security.js';

export function exportPacketsToHar(records: any[], redactSecrets = false) {
  const entries = records.map((r) => {
    const reqHeadersObj = typeof r.req_headers === 'string' ? JSON.parse(r.req_headers) : (r.req_headers || {});
    const resHeadersObj = typeof r.res_headers === 'string' ? JSON.parse(r.res_headers) : (r.res_headers || {});
    const safeReqHeaders = redactSecrets ? redactHeaders(reqHeadersObj) : reqHeadersObj;
    const safeResHeaders = redactSecrets ? redactHeaders(resHeadersObj) : resHeadersObj;
    const safeUrl = redactSecrets ? redactUrlSecrets(r.url) : r.url;
    const safeReqBody = redactSecrets ? redactSensitiveText(r.req_body || '') : (r.req_body || '');
    const safeResBody = redactSecrets ? redactSensitiveText(r.res_body || '') : (r.res_body || '');

    let queryString: Array<{ name: string; value: string }> = [];
    try {
      const u = new URL(safeUrl);
      queryString = Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
    } catch {
      queryString = [];
    }

    return {
      startedDateTime: new Date(r.timestamp || Date.now()).toISOString(),
      time: r.duration_ms || 0,
      request: {
        method: r.method || 'GET',
        url: safeUrl,
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(safeReqHeaders).map(([name, value]) => ({ name, value: String(value) })),
        queryString,
        cookies: [],
        headersSize: -1,
        bodySize: r.req_body_size ?? Buffer.byteLength(safeReqBody, 'utf8'),
        ...(safeReqBody
          ? {
              postData: {
                mimeType: safeReqHeaders['content-type'] || 'text/plain',
                text: safeReqBody,
              },
            }
          : {}),
      },
      response: {
        status: r.status_code || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        headers: Object.entries(safeResHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
        cookies: [],
        content: {
          size: r.res_body_size ?? Buffer.byteLength(safeResBody, 'utf8'),
          mimeType: safeResHeaders?.['content-type'] || 'application/octet-stream',
          text: safeResBody,
        },
        redirectURL: safeResHeaders?.location || '',
        headersSize: -1,
        bodySize: r.res_body_size ?? Buffer.byteLength(safeResBody, 'utf8'),
      },
      cache: {},
      timings: {
        send: 0,
        wait: r.duration_ms || 0,
        receive: 0,
      },
    };
  });

  return {
    log: {
      version: '1.2',
      creator: { name: 'ProxySuite', version: '2.0.0' },
      entries,
    },
  };
}

export function importHarToRecords(harPayload: any): { valid: boolean; records?: any[]; error?: string } {
  const entries = harPayload?.log?.entries;
  if (!Array.isArray(entries)) {
    return { valid: false, error: 'Invalid HAR format: missing log.entries array' };
  }
  const records: any[] = [];
  for (const entry of entries) {
    const req = entry?.request;
    const res = entry?.response;
    if (!req || typeof req.url !== 'string') continue;
    const reqHeaders: Record<string, string> = {};
    if (Array.isArray(req.headers)) {
      for (const h of req.headers) {
        if (h?.name) reqHeaders[String(h.name)] = String(h.value ?? '');
      }
    }
    const resHeaders: Record<string, string> = {};
    if (Array.isArray(res?.headers)) {
      for (const h of res.headers) {
        if (h?.name) resHeaders[String(h.name)] = String(h.value ?? '');
      }
    }
    const ts = entry.startedDateTime ? Date.parse(entry.startedDateTime) : Date.now();
    records.push({
      id: crypto.randomUUID(),
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
      method: String(req.method || 'GET').toUpperCase(),
      url: req.url,
      req_headers: reqHeaders,
      req_body: typeof req.postData?.text === 'string' ? req.postData.text : '',
      res_headers: res ? resHeaders : null,
      res_body: typeof res?.content?.text === 'string' ? res.content.text : null,
      status_code: typeof res?.status === 'number' ? res.status : null,
      duration_ms: typeof entry.time === 'number' ? Math.round(entry.time) : null,
    });
  }
  return { valid: true, records };
}
