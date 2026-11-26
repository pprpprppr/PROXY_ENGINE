import React, { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, FileDown, Search, Trash2, Wifi } from 'lucide-react';
import type { WebSocketConnectionRecord, WebSocketFrameRecord } from '../types/proxy';
import { apiFetch } from '../lib/api';

interface WebSocketPaneProps {
  connections: WebSocketConnectionRecord[];
  frames: WebSocketFrameRecord[];
  onClear: () => void;
}

export function WebSocketPane({ connections, frames, onClear }: WebSocketPaneProps) {
  const [selectedConnId, setSelectedConnId] = useState<string>('ALL');
  const [directionFilter, setDirectionFilter] = useState<'ALL' | 'client_to_server' | 'server_to_client'>('ALL');
  const [formatFilter, setFormatFilter] = useState<'ALL' | 'text' | 'binary'>('ALL');
  const [search, setSearch] = useState('');

  const filteredFrames = useMemo(() => {
    const term = search.toLowerCase();
    return frames.filter((f) => {
      if (selectedConnId !== 'ALL' && f.connectionId !== selectedConnId) return false;
      if (directionFilter !== 'ALL' && f.direction !== directionFilter) return false;
      if (formatFilter === 'text' && f.isBinary) return false;
      if (formatFilter === 'binary' && !f.isBinary) return false;
      if (term && !f.payload.toLowerCase().includes(term) && !f.url.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [frames, selectedConnId, directionFilter, formatFilter, search]);

  const handleClear = async () => {
    await apiFetch('/api/websockets/clear', { method: 'POST' });
    onClear();
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(filteredFrames, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `proxysuite_ws_frames_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4 space-y-3 font-mono text-xs bg-[#0E1015]">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 font-bold text-gray-300 uppercase">
          <Wifi className="w-4 h-4 text-[#00E5FF]" />
          WebSocket Frame Inspector ({filteredFrames.length})
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="px-2.5 py-1 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 rounded flex items-center gap-1"
          >
            <FileDown className="w-3.5 h-3.5" /> Export
          </button>
          <button
            onClick={handleClear}
            className="px-2.5 py-1 bg-red-500/15 text-red-300 border border-red-500/30 rounded flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
      </div>

      {/* Connections summary */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setSelectedConnId('ALL')}
          className={`px-2.5 py-1 rounded border text-[11px] shrink-0 ${
            selectedConnId === 'ALL'
              ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
              : 'bg-[#14161C] border-gray-800 text-gray-400'
          }`}
        >
          All Connections ({connections.length})
        </button>
        {connections.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelectedConnId(c.id)}
            className={`px-2.5 py-1 rounded border text-[11px] shrink-0 flex items-center gap-1.5 ${
              selectedConnId === c.id
                ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
                : 'bg-[#14161C] border-gray-800 text-gray-400'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                c.status === 'open' ? 'bg-emerald-400' : c.status === 'closed' ? 'bg-gray-500' : 'bg-red-400'
              }`}
            />
            <span className="truncate max-w-[160px]">{c.host}</span>
            <span className="text-gray-500">({c.frameCount})</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search WebSocket payloads or URLs..."
            className="w-full bg-[#14161C] border border-gray-800 rounded pl-8 pr-2 py-1.5 text-gray-200 focus:outline-none focus:border-[#00E5FF]"
          />
        </div>
        <select
          value={directionFilter}
          onChange={(e) => setDirectionFilter(e.target.value as any)}
          className="bg-[#14161C] border border-gray-800 rounded px-2 py-1.5 text-gray-300"
        >
          <option value="ALL">Both Directions</option>
          <option value="client_to_server">Client → Server</option>
          <option value="server_to_client">Server → Client</option>
        </select>
        <select
          value={formatFilter}
          onChange={(e) => setFormatFilter(e.target.value as any)}
          className="bg-[#14161C] border border-gray-800 rounded px-2 py-1.5 text-gray-300"
        >
          <option value="ALL">Text & Binary</option>
          <option value="text">Text Only</option>
          <option value="binary">Binary (Hex)</option>
        </select>
      </div>

      {/* Frames list */}
      <div className="flex-1 overflow-auto space-y-2">
        {filteredFrames.length === 0 ? (
          <div className="text-center text-gray-600 italic py-14 border border-gray-800 border-dashed rounded">
            No proxied WebSocket frames captured yet. Route WS/WSS traffic through the MITM proxy port to inspect frames in real time.
          </div>
        ) : (
          filteredFrames.map((f) => (
            <div key={f.id} className="p-2.5 rounded bg-[#14161C] border border-gray-800 space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <div className="flex items-center gap-2">
                  {f.direction === 'client_to_server' ? (
                    <span className="text-indigo-400 flex items-center gap-1 font-bold">
                      <ArrowUpRight className="w-3 h-3" /> Client → Server
                    </span>
                  ) : (
                    <span className="text-emerald-400 flex items-center gap-1 font-bold">
                      <ArrowDownLeft className="w-3 h-3" /> Server → Client
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 uppercase">{f.frameType}</span>
                  <span className="px-1.5 py-0.5 rounded bg-gray-800 text-amber-300 uppercase">
                    {f.isBinary ? 'BIN' : 'TEXT'}
                  </span>
                  <span className="text-gray-500">{f.size} B</span>
                  {f.truncated && <span className="text-orange-400">TRUNCATED</span>}
                </div>
                <span className="text-gray-500">{new Date(f.timestamp).toLocaleTimeString()}</span>
              </div>
              <pre className="text-[11px] text-gray-200 whitespace-pre-wrap break-all bg-[#0A0C10] p-2 rounded border border-gray-800/70">
                {f.payload || '(empty frame)'}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
