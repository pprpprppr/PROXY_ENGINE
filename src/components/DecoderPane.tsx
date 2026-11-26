import React, { useState } from 'react';
import { ArrowRightLeft, Copy, Check, KeyRound, Trash2 } from 'lucide-react';
import { useTrafficStore } from '../hooks/useTraffic';

function decodeJwt(token: string): string {
  const parts = token.trim().split('.');
  if (parts.length < 2) return 'Invalid JWT: expected header.payload[.signature]';
  const decodePart = (p: string) => {
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const jsonStr = decodeURIComponent(escape(atob(b64 + pad)));
    return JSON.stringify(JSON.parse(jsonStr), null, 2);
  };
  try {
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    return `=== JWT HEADER ===\n${header}\n\n=== JWT PAYLOAD ===\n${payload}\n\n=== SIGNATURE (base64url) ===\n${parts[2] || '(none)'}`;
  } catch (e) {
    return `JWT Decode Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function DecoderPane() {
  const input = useTrafficStore((s) => s.decoderInput);
  const setInput = useTrafficStore((s) => s.setDecoderInput);
  const [output, setOutput] = useState('');
  const [copied, setCopied] = useState(false);

  const runTransform = async (op: string) => {
    try {
      if (op === 'b64_dec') {
        setOutput(decodeURIComponent(escape(atob(input.trim()))));
      } else if (op === 'b64_enc') {
        setOutput(btoa(unescape(encodeURIComponent(input))));
      } else if (op === 'url_dec') {
        setOutput(decodeURIComponent(input));
      } else if (op === 'url_enc') {
        setOutput(encodeURIComponent(input));
      } else if (op === 'hex_enc') {
        const bytes = new TextEncoder().encode(input);
        setOutput(Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' '));
      } else if (op === 'hex_dec') {
        const clean = input.replace(/[^0-9a-fA-F]/g, '');
        const bytes = new Uint8Array(clean.match(/.{1,2}/g)?.map((h) => parseInt(h, 16)) || []);
        setOutput(new TextDecoder().decode(bytes));
      } else if (op === 'html_enc') {
        setOutput(
          input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
        );
      } else if (op === 'html_dec') {
        const doc = new DOMParser().parseFromString(input, 'text/html');
        setOutput(doc.documentElement.textContent || '');
      } else if (op === 'json_pretty') {
        setOutput(JSON.stringify(JSON.parse(input), null, 2));
      } else if (op === 'jwt_dec') {
        setOutput(decodeJwt(input));
      } else if (op === 'sha256' || op === 'sha1') {
        const algo = op === 'sha256' ? 'SHA-256' : 'SHA-1';
        const data = new TextEncoder().encode(input);
        const hashBuf = await crypto.subtle.digest(algo, data);
        const hex = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        setOutput(hex);
      }
    } catch (e) {
      setOutput(`Transform Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-5 gap-4 bg-[#0B0D12] min-h-0">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4 text-[#00E5FF]" /> Decoder, JWT Inspector & Hash Utility
          </h2>
          <p className="text-xs text-gray-400">
            Decode, encode, inspect JWT claims, prettify JSON, or hash payloads locally in your browser.
          </p>
        </div>
        <button
          onClick={() => {
            setInput('');
            setOutput('');
          }}
          className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 flex items-center gap-1.5 border border-gray-700"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          ['b64_dec', 'Base64 Decode'],
          ['b64_enc', 'Base64 Encode'],
          ['url_dec', 'URL Decode'],
          ['url_enc', 'URL Encode'],
          ['hex_dec', 'Hex Decode'],
          ['hex_enc', 'Hex Encode'],
          ['html_dec', 'HTML Decode'],
          ['html_enc', 'HTML Encode'],
          ['json_pretty', 'JSON Prettify'],
          ['jwt_dec', 'Decode JWT'],
          ['sha256', 'SHA-256 Hash'],
          ['sha1', 'SHA-1 Hash'],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => runTransform(id)}
            className="px-3 py-1.5 rounded-lg bg-[#141720] hover:bg-indigo-600/25 hover:border-indigo-500/40 border border-gray-800 text-gray-200 font-medium flex items-center gap-1.5"
          >
            {id === 'jwt_dec' && <KeyRound className="w-3.5 h-3.5 text-amber-400" />}
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
        <div className="flex flex-col gap-1.5 min-h-0">
          <div className="text-xs font-semibold text-gray-400">Input</div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste encoded text, JWT token, URL string, or JSON..."
            className="flex-1 bg-[#141720] border border-gray-800 rounded-xl p-3 font-mono text-xs text-gray-200 focus:outline-none focus:border-[#00E5FF] resize-none"
          />
        </div>

        <div className="flex flex-col gap-1.5 min-h-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400">Output</span>
            <div className="flex gap-2">
              <button
                onClick={() => output && setInput(output)}
                className="text-[11px] text-indigo-400 hover:text-indigo-300"
              >
                Use Output as Input ↑
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(output).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  });
                }}
                className="text-[11px] text-gray-400 hover:text-white flex items-center gap-1"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={output}
            placeholder="Result appears here..."
            className="flex-1 bg-[#141720] border border-gray-800 rounded-xl p-3 font-mono text-xs text-emerald-300 focus:outline-none resize-none"
          />
        </div>
      </div>
    </div>
  );
}
