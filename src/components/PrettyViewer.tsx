import React, { memo, useMemo, useState } from 'react';
import { AlertTriangle, Copy, Check } from 'lucide-react';

interface PrettyViewerProps {
  body: string;
  bodySize?: number;
  bodyTruncated?: boolean;
  isBinary?: boolean;
  contentType?: string;
}

function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null) return <span className="text-gray-500">null</span>;
  if (typeof value === 'boolean') return <span className="text-orange-400">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-yellow-400">{String(value)}</span>;
  if (typeof value === 'string') return <span className="text-emerald-300">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400">[]</span>;
    const indent = '  '.repeat(depth + 1);
    const closeIndent = '  '.repeat(depth);
    return (
      <span>
        {'[\n'}
        {value.map((item, i) => (
          <React.Fragment key={i}>
            {indent}
            <JsonNode value={item} depth={depth + 1} />
            {i < value.length - 1 ? ',\n' : '\n'}
          </React.Fragment>
        ))}
        {closeIndent}]
      </span>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-gray-400">{'{}'}</span>;
    const indent = '  '.repeat(depth + 1);
    const closeIndent = '  '.repeat(depth);
    return (
      <span>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <React.Fragment key={k}>
            {indent}
            <span className="text-indigo-400 font-semibold">"{k}"</span>
            {': '}
            <JsonNode value={v} depth={depth + 1} />
            {i < entries.length - 1 ? ',\n' : '\n'}
          </React.Fragment>
        ))}
        {closeIndent}
        {'}'}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

export const PrettyViewer = memo(function PrettyViewer({
  body,
  bodySize,
  bodyTruncated,
  isBinary,
}: PrettyViewerProps) {
  const [viewType, setViewType] = useState<'pretty' | 'raw'>('pretty');
  const [copied, setCopied] = useState(false);

  const parsedJson = useMemo(() => {
    if (!body || isBinary || body.length > 250_000) return { ok: false as const, value: null };
    const trimmed = body.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return { ok: false as const, value: null };
    }
    try {
      return { ok: true as const, value: JSON.parse(trimmed) };
    } catch {
      return { ok: false as const, value: null };
    }
  }, [body, isBinary]);

  if (!body && !bodyTruncated) {
    return <div className="text-gray-600 italic text-[11px] mt-2">(empty body)</div>;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className="mt-3 border-t border-gray-800/60 pt-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-[10px]">
          {isBinary && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-bold uppercase">
              Binary
            </span>
          )}
          {parsedJson.ok && (
            <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-bold uppercase">
              JSON
            </span>
          )}
          {bodySize !== undefined && (
            <span className="text-gray-500 font-mono">
              {bodySize >= 1024 ? `${(bodySize / 1024).toFixed(1)} KB` : `${bodySize} B`}
            </span>
          )}
          {bodyTruncated && (
            <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Truncated (capture limit)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {parsedJson.ok && (
            <div className="flex bg-[#0E1015] border border-gray-800 rounded overflow-hidden text-[10px]">
              <button
                onClick={() => setViewType('pretty')}
                className={`px-2 py-0.5 ${viewType === 'pretty' ? 'bg-indigo-600/30 text-indigo-300' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Pretty
              </button>
              <button
                onClick={() => setViewType('raw')}
                className={`px-2 py-0.5 border-l border-gray-800 ${viewType === 'raw' ? 'bg-indigo-600/30 text-indigo-300' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Raw
              </button>
            </div>
          )}
          <button
            onClick={handleCopy}
            className="text-[10px] px-2 py-0.5 bg-[#0E1015] border border-gray-800 rounded text-gray-400 hover:text-white flex items-center gap-1"
            title="Copy body"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-gray-300 bg-[#0A0C10]/60 p-2.5 rounded border border-gray-800/60 overflow-x-auto">
        {viewType === 'pretty' && parsedJson.ok ? <JsonNode value={parsedJson.value} /> : body}
      </pre>
    </div>
  );
});
