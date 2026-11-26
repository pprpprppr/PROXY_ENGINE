export function runPassiveScan(
  headers: Record<string, string>,
  body: string,
  url: string,
  isBinary: boolean
): string | null {
  const findings: string[] = [];
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    lowerHeaders[k.toLowerCase()] = v;
  }

  const cors = lowerHeaders['access-control-allow-origin'];
  const corsCreds = lowerHeaders['access-control-allow-credentials'];
  if (cors === '*' && corsCreds === 'true') {
    findings.push('[CORS High] Wildcard Access-Control-Allow-Origin combined with Allow-Credentials.');
  } else if (cors === '*') {
    findings.push('[CORS] Wildcard Access-Control-Allow-Origin (*).');
  }

  const contentType = (lowerHeaders['content-type'] || '').toLowerCase();
  const isHtml = contentType.includes('text/html');
  if (isHtml) {
    if (!lowerHeaders['x-frame-options'] && !lowerHeaders['content-security-policy']) {
      findings.push('[Security Headers] HTML response missing X-Frame-Options and Content-Security-Policy.');
    }
    if (!lowerHeaders['x-content-type-options']) {
      findings.push('[Security Headers] Missing X-Content-Type-Options: nosniff.');
    }
  }

  if (url.startsWith('https://') && !lowerHeaders['strict-transport-security']) {
    findings.push('[Transport] HTTPS response missing Strict-Transport-Security (HSTS).');
  }

  const setCookie = lowerHeaders['set-cookie'];
  if (setCookie) {
    const lowerCookie = setCookie.toLowerCase();
    if (!lowerCookie.includes('httponly')) {
      findings.push('[Cookie] Set-Cookie missing HttpOnly flag.');
    }
    if (url.startsWith('https://') && !lowerCookie.includes('secure')) {
      findings.push('[Cookie] Set-Cookie over HTTPS missing Secure flag.');
    }
  }

  if (!isBinary && body && body.length > 0) {
    // Limit passive regex scan to first 128 KB to keep CPU bounded
    const sample = body.length > 131072 ? body.slice(0, 131072) : body;
    if (/\bAKIA[0-9A-Z]{16}\b/.test(sample) || /\bAIza[0-9A-Za-z\-_]{35}\b/.test(sample)) {
      findings.push('[Token Leakage] Potential cloud/API key pattern detected in response body.');
    }
    if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(sample)) {
      findings.push('[JWT] JSON Web Token present in response body.');
    }
    const emailMatches = sample.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (emailMatches && emailMatches.length > 0) {
      findings.push(`[PII Leakage] ${Math.min(emailMatches.length, 99)}${emailMatches.length > 99 ? '+' : ''} email address(es) found in response.`);
    }
  }

  return findings.length > 0 ? findings.join('\n') : null;
}
