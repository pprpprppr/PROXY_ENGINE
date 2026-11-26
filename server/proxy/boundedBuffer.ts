import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);

/**
 * Accumulates stream chunks up to `maxBytes` without allocating unbounded memory.
 * Still tracks `totalBytes` across the full stream even after reaching the cap.
 */
export class BoundedBuffer {
  private chunks: Buffer[] = [];
  private capturedBytes = 0;
  public totalBytes = 0;
  public truncated = false;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, maxBytes);
  }

  append(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) return;
    this.totalBytes += chunk.length;
    if (this.capturedBytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    const remaining = this.maxBytes - this.capturedBytes;
    if (chunk.length <= remaining) {
      // Copy chunk slice so caller buffer can be GC'd independently if needed
      this.chunks.push(Buffer.from(chunk));
      this.capturedBytes += chunk.length;
    } else {
      this.chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      this.capturedBytes += remaining;
      this.truncated = true;
    }
  }

  toBuffer(): Buffer {
    if (this.chunks.length === 0) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0];
    const combined = Buffer.concat(this.chunks, this.capturedBytes);
    // Replace chunks array so intermediate Buffers can be collected
    this.chunks = [combined];
    return combined;
  }

  clear(): void {
    this.chunks = [];
    this.capturedBytes = 0;
  }
}

export function isBinaryContent(headers: Record<string, string>, sample: Buffer): boolean {
  const ct = (headers['content-type'] || '').toLowerCase();
  if (
    ct.startsWith('image/') ||
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct.startsWith('font/') ||
    ct.includes('octet-stream') ||
    ct.includes('pdf') ||
    ct.includes('zip') ||
    ct.includes('gzip') ||
    ct.includes('protobuf') ||
    ct.includes('wasm')
  ) {
    return true;
  }
  if (
    ct.includes('json') ||
    ct.startsWith('text/') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('x-www-form-urlencoded') ||
    ct.includes('svg')
  ) {
    return false;
  }
  const inspectLen = Math.min(sample.length, 512);
  if (inspectLen === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < inspectLen; i++) {
    const b = sample[i];
    if (b === 0) return true; // Null byte is strong binary indicator
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) {
      nonPrintable++;
    }
  }
  return nonPrintable / inspectLen > 0.15;
}

export function formatBufferPreview(buf: Buffer, headers: Record<string, string>): {
  text: string;
  isBinary: boolean;
} {
  if (!buf || buf.length === 0) {
    return { text: '', isBinary: false };
  }
  const binary = isBinaryContent(headers, buf);
  if (binary) {
    // Store bounded base64 or hex indicator safely without producing invalid UTF-8
    const previewBytes = buf.subarray(0, 2048);
    const lines: string[] = [];
    for (let i = 0; i < previewBytes.length; i += 16) {
      const slice = previewBytes.subarray(i, i + 16);
      const hex = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47, ' ');
      const ascii = Array.from(slice)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('');
      lines.push(`${i.toString(16).padStart(4, '0')}  ${hex}  |${ascii}|`);
    }
    if (buf.length > 2048) {
      lines.push(`... [${buf.length - 2048} more captured binary bytes]`);
    }
    return { text: `[BINARY PAYLOAD: ${buf.length} bytes captured]\n${lines.join('\n')}`, isBinary: true };
  }
  return { text: buf.toString('utf8'), isBinary: false };
}

export async function decodeBodyForInspection(
  buf: Buffer,
  contentEncoding: string | undefined,
  maxOutputBytes: number
): Promise<{ decoded: Buffer; wasCompressed: boolean; decodeError?: string }> {
  if (!buf || buf.length === 0 || !contentEncoding) {
    return { decoded: buf, wasCompressed: false };
  }
  const enc = contentEncoding.toLowerCase().trim();
  try {
    let out: Buffer;
    if (enc === 'gzip' || enc === 'x-gzip') {
      out = await gunzipAsync(buf, { maxOutputLength: maxOutputBytes });
    } else if (enc === 'deflate') {
      try {
        out = await inflateAsync(buf, { maxOutputLength: maxOutputBytes });
      } catch {
        out = await inflateRawAsync(buf, { maxOutputLength: maxOutputBytes });
      }
    } else if (enc === 'br') {
      out = await brotliDecompressAsync(buf, { maxOutputLength: maxOutputBytes });
    } else {
      return { decoded: buf, wasCompressed: false };
    }
    return { decoded: out, wasCompressed: true };
  } catch (err) {
    return {
      decoded: buf,
      wasCompressed: true,
      decodeError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function normalizeHeadersRecord(
  headers: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}
