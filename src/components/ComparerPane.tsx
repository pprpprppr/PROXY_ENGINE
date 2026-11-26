import React, { useMemo } from 'react';
import { GitCompare } from 'lucide-react';
import { useTrafficStore } from '../hooks/useTraffic';
import type { PacketSummary } from '../types/proxy';
import { apiFetch } from '../lib/api';

interface ComparerPaneProps {
  summaries: PacketSummary[];
}

function diffLines(left: string, right: string) {
  const a = left.split('\n').slice(0, 500);
  const b = right.split('\n').slice(0, 500);
  const max = Math.max(a.length, b.length);
  const rows: Array<{ lineNo: number; left: string; right: string; changed: boolean }> = [];
  for (let i = 0; i < max; i++) {
    const l = a[i] ?? '';
    const r = b[i] ?? '';
    rows.push({ lineNo: i + 1, left: l, right: r, changed: l !== r });
  }
  return rows;
}

export function ComparerPane({ summaries }: ComparerPaneProps) {
  const left = useTrafficStore((s) => s.comparerLeft);
  const right = useTrafficStore((s) => s.comparerRight);
  const setComparerSlot = useTrafficStore((s) => s.setComparerSlot);

  const loadPacketIntoSlot = async (slot: 'left' | 'right', id: string) => {
    if (!id) return;
    const res = await apiFetch(`/api/history/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const pkt = await res.json();
    const formatted = [
      `${pkt.method} ${pkt.url}`,
      ...Object.entries(pkt.headers || {}).map(([k, v]) => `${k}: ${v}`),
      '',
      pkt.body || '',
      '',
      `--- RESPONSE (${pkt.response?.statusCode ?? 'Pending'}) ---`,
      ...Object.entries(pkt.response?.headers || {}).map(([k, v]) => `${k}: ${v}`),
      '',
      pkt.response?.body || '',
    ].join('\n');
    setComparerSlot(slot, { label: `${pkt.method} ${pkt.path}`, text: formatted });
  };

  const rows = useMemo(() => diffLines(left?.text || '', right?.text || ''), [left?.text, right?.text]);
  const changedCount = rows.filter((r) => r.changed).length;

  return (
    <div className="flex-1 flex flex-col p-5 gap-4 bg-[#0B0D12] min-h-0">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <GitCompare className="w-4 h-4 text-[#00E5FF]" /> HTTP Comparer (Side-by-Side Diff)
          </h2>
          <p className="text-xs text-gray-400">
            Compare two requests, responses, or raw payloads line-by-line ({changedCount} differing lines).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-indigo-300 shrink-0">Item A:</span>
          <select
            onChange={(e) => loadPacketIntoSlot('left', e.target.value)}
            defaultValue=""
            className="flex-1 bg-[#141720] border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-gray-200"
          >
            <option value="">Choose from HTTP History...</option>
            {summaries.slice(0, 60).map((s) => (
              <option key={s.id} value={s.id}>
                [{s.method}] {s.statusCode ?? '?'} {s.host}{s.path.slice(0, 40)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-emerald-300 shrink-0">Item B:</span>
          <select
            onChange={(e) => loadPacketIntoSlot('right', e.target.value)}
            defaultValue=""
            className="flex-1 bg-[#141720] border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-gray-200"
          >
            <option value="">Choose from HTTP History...</option>
            {summaries.slice(0, 60).map((s) => (
              <option key={s.id} value={s.id}>
                [{s.method}] {s.statusCode ?? '?'} {s.host}{s.path.slice(0, 40)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-xl border border-gray-800 bg-[#141720] font-mono text-[11px]">
        <table className="w-full table-fixed border-collapse">
          <thead className="bg-[#181C27] sticky top-0 border-b border-gray-800 text-[10px] text-gray-400">
            <tr>
              <th className="w-10 px-2 py-2 text-right">#</th>
              <th className="px-3 py-2 text-left border-r border-gray-800">{left?.label || 'Left (A)'}</th>
              <th className="px-3 py-2 text-left">{right?.label || 'Right (B)'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lineNo} className={`border-b border-gray-800/40 ${r.changed ? 'bg-amber-950/20' : ''}`}>
                <td className="px-2 py-1 text-right text-gray-600 select-none">{r.lineNo}</td>
                <td className={`px-3 py-1 break-all border-r border-gray-800 ${r.changed ? 'text-red-300' : 'text-gray-400'}`}>
                  {r.left}
                </td>
                <td className={`px-3 py-1 break-all ${r.changed ? 'text-emerald-300' : 'text-gray-400'}`}>
                  {r.right}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
