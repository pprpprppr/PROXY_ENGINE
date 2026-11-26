import React, { memo, useMemo, useState } from 'react';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Filter,
  Loader2,
  Pause,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { PacketSummary } from '../types/proxy';

export interface TrafficFilterState {
  search: string;
  bodySearch: string;
  method: string;
  statusGroup: string;
  contentType: string;
  bookmarkedOnly: boolean;
}

interface TrafficRowProps {
  index: number;
  req: PacketSummary;
  isSelected: boolean;
  isDuplicate: boolean;
  onSelect: (id: string) => void;
  onIgnoreDomain: (host: string) => void;
  onToggleBookmark: (req: PacketSummary) => void;
}

const TrafficRow = memo(function TrafficRow({
  index,
  req,
  isSelected,
  isDuplicate,
  onSelect,
  onIgnoreDomain,
  onToggleBookmark,
}: TrafficRowProps) {
  const isIntercepted = req.status === 'intercepted' || req.status === 'response_intercepted';

  return (
    <tr
      onClick={() => onSelect(req.id)}
      className={`border-b border-gray-800/40 hover:bg-[#1A1E2A] cursor-pointer transition-colors group select-none ${
        isSelected ? 'bg-[#00E5FF]/10' : ''
      } ${isIntercepted ? 'bg-orange-950/20' : ''}`}
    >
      <td className="px-2.5 py-2 text-[11px] text-gray-500 text-right w-10">{index}</td>
      <td className="px-2 py-2 text-center w-8">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleBookmark(req);
          }}
          className={`p-0.5 rounded transition-colors ${
            req.bookmarked ? 'text-amber-400' : 'text-gray-700 hover:text-gray-400'
          }`}
          title={req.bookmarked ? 'Remove bookmark' : 'Bookmark request'}
        >
          <Bookmark className="w-3 h-3" fill={req.bookmarked ? 'currentColor' : 'none'} />
        </button>
      </td>
      <td className="px-2.5 py-2 text-gray-200 font-mono">
        <div className="flex items-center gap-1.5 group/host">
          <span className="truncate max-w-[170px]" title={req.host}>
            {req.host}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIgnoreDomain(req.host.split(':')[0]);
            }}
            className="opacity-0 group-hover/host:opacity-100 p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400"
            title="Ignore domain during intercept"
          >
            <Filter className="w-3 h-3" />
          </button>
        </div>
      </td>
      <td className="px-2.5 py-2">
        <span
          className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
            req.method === 'POST'
              ? 'bg-indigo-900/40 text-indigo-300'
              : req.method === 'DELETE'
                ? 'bg-red-900/40 text-red-300'
                : req.method === 'PUT' || req.method === 'PATCH'
                  ? 'bg-amber-900/40 text-amber-300'
                  : 'bg-emerald-900/40 text-emerald-300'
          }`}
        >
          {req.method}
        </span>
      </td>
      <td className="px-2.5 py-2 font-mono text-gray-300 max-w-[360px] truncate" title={req.url}>
        <div className="flex items-center gap-1.5">
          <span className="truncate">{req.path}</span>
          {isDuplicate && (
            <span className="text-[9px] px-1 rounded bg-gray-800 text-gray-400 border border-gray-700 shrink-0">
              DUP
            </span>
          )}
          {req.hasPassiveFindings && (
            <span title="Passive security findings">
              <ShieldAlert className="w-3.5 h-3.5 text-orange-400 shrink-0" />
            </span>
          )}
          {req.hasAiAnalysis && (
            <span title="AI security audit available">
              <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            </span>
          )}
        </div>
      </td>
      <td className="px-2.5 py-2">
        {isIntercepted ? (
          <span className="text-orange-400 font-bold flex items-center gap-1 text-[10px]">
            <Pause className="w-2.5 h-2.5" /> Held
          </span>
        ) : req.status === 'dropped' ? (
          <span className="text-red-400 font-bold text-[10px]">Dropped</span>
        ) : !req.statusCode ? (
          <span className="text-gray-500 flex items-center gap-1 italic text-[10px]">
            <Loader2 className="w-2.5 h-2.5 animate-spin" /> Pending
          </span>
        ) : (
          <span
            className={`font-bold ${
              req.statusCode < 300
                ? 'text-emerald-400'
                : req.statusCode < 400
                  ? 'text-yellow-400'
                  : 'text-red-400'
            }`}
          >
            {req.statusCode}
          </span>
        )}
      </td>
      <td className="px-2.5 py-2 text-right text-gray-400 font-mono text-[11px]">
        {req.statusCode
          ? `${req.resBodySize > 1024 ? `${(req.resBodySize / 1024).toFixed(1)}k` : req.resBodySize}${
              req.resBodyTruncated ? '+' : ''
            }`
          : '-'}
      </td>
      <td className="px-2.5 py-2 text-gray-500 font-mono text-[11px] max-w-[120px] truncate">
        {req.contentType ? req.contentType.split(';')[0] : '-'}
      </td>
      <td className="px-2.5 py-2 text-right text-gray-400 font-mono text-[11px]">
        {req.duration !== undefined ? `${req.duration}ms` : '-'}
      </td>
    </tr>
  );
});

interface TrafficTableProps {
  items: PacketSummary[];
  totalCount: number;
  page: number;
  pageSize: number;
  selectedId: string | null;
  filters: TrafficFilterState;
  onFiltersChange: (next: TrafficFilterState) => void;
  onPageChange: (page: number) => void;
  onSelect: (id: string) => void;
  onIgnoreDomain: (domain: string) => void;
  onToggleBookmark: (req: PacketSummary) => void;
  onClearHistory: () => void;
}

export const TrafficTable = memo(function TrafficTable({
  items,
  totalCount,
  page,
  pageSize,
  selectedId,
  filters,
  onFiltersChange,
  onPageChange,
  onSelect,
  onIgnoreDomain,
  onToggleBookmark,
  onClearHistory,
}: TrafficTableProps) {
  const [hideStatic, setHideStatic] = useState(false);

  const visibleItems = useMemo(() => {
    if (!hideStatic) return items;
    return items.filter((item) => {
      const ct = (item.contentType || '').toLowerCase();
      const path = item.path.toLowerCase();
      if (ct.startsWith('image/') || ct.startsWith('font/') || ct.includes('css')) return false;
      if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|css)(\?|$)/.test(path)) return false;
      return true;
    });
  }, [items, hideStatic]);

  const dupCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of visibleItems) {
      const key = `${item.method}:${item.url}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [visibleItems]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="flex-1 overflow-hidden bg-[#0B0D12] flex flex-col">
      {/* Filter Bar */}
      <div className="bg-[#141720] border-b border-gray-800 px-3 py-2 flex flex-wrap gap-2 items-center text-xs shrink-0">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-2" />
          <input
            value={filters.search}
            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
            placeholder="Filter by host, URL, or path..."
            className="w-full bg-[#0B0D12] border border-gray-700 rounded-lg pl-8 pr-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-[#00E5FF]"
          />
        </div>

        <input
          value={filters.bodySearch}
          onChange={(e) => onFiltersChange({ ...filters, bodySearch: e.target.value })}
          placeholder="Search inside bodies..."
          className="w-44 bg-[#0B0D12] border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-200 focus:outline-none focus:border-[#00E5FF]"
        />

        <select
          value={filters.method}
          onChange={(e) => onFiltersChange({ ...filters, method: e.target.value })}
          className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
        >
          <option value="ALL">All Methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>

        <select
          value={filters.statusGroup}
          onChange={(e) => onFiltersChange({ ...filters, statusGroup: e.target.value })}
          className="bg-[#0B0D12] border border-gray-700 rounded-lg px-2 py-1.5 text-gray-200"
        >
          <option value="ALL">All Statuses</option>
          <option value="2xx">2xx Success</option>
          <option value="3xx">3xx Redirect</option>
          <option value="4xx">4xx Client Error</option>
          <option value="5xx">5xx Server Error</option>
          <option value="findings">Has Findings</option>
        </select>

        <button
          onClick={() => setHideStatic((v) => !v)}
          className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${
            hideStatic
              ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
              : 'bg-[#0B0D12] border-gray-700 text-gray-400 hover:text-white'
          }`}
          title="Hide images, fonts, and CSS files"
        >
          <EyeOff className="w-3.5 h-3.5" /> Hide Static
        </button>

        <button
          onClick={() => onFiltersChange({ ...filters, bookmarkedOnly: !filters.bookmarkedOnly })}
          className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1 ${
            filters.bookmarkedOnly
              ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
              : 'bg-[#0B0D12] border-gray-700 text-gray-400 hover:text-white'
          }`}
          title="Show bookmarked only"
        >
          <Bookmark className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onClearHistory}
          className="bg-red-950/30 text-red-300 hover:bg-red-900/40 px-2.5 py-1.5 rounded-lg border border-red-500/30 flex items-center gap-1"
          title="Clear stored traffic history"
        >
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>

        <div className="flex items-center gap-1.5 ml-auto text-[11px] font-mono text-gray-400">
          <button
            disabled={page <= 0}
            onClick={() => onPageChange(page - 1)}
            className="p-1 rounded bg-gray-800 disabled:opacity-30 hover:bg-gray-700"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span>
            {page + 1} / {totalPages}
          </span>
          <button
            disabled={page + 1 >= totalPages}
            onClick={() => onPageChange(page + 1)}
            className="p-1 rounded bg-gray-800 disabled:opacity-30 hover:bg-gray-700"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs text-gray-400 font-mono whitespace-nowrap">
          <thead className="bg-[#12151D] sticky top-0 border-b border-gray-800 z-10 text-gray-400 uppercase text-[10px]">
            <tr>
              <th className="px-2.5 py-2 text-right">#</th>
              <th className="px-2 py-2 text-center">★</th>
              <th className="px-2.5 py-2">Host</th>
              <th className="px-2.5 py-2">Method</th>
              <th className="px-2.5 py-2">URL Path</th>
              <th className="px-2.5 py-2">Status</th>
              <th className="px-2.5 py-2 text-right">Length</th>
              <th className="px-2.5 py-2">MIME</th>
              <th className="px-2.5 py-2 text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {visibleItems.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-500 italic font-sans">
                  No HTTP requests match the current filters.
                </td>
              </tr>
            )}
            {visibleItems.map((req, idx) => (
              <TrafficRow
                key={req.id}
                index={page * pageSize + idx + 1}
                req={req}
                isSelected={selectedId === req.id}
                isDuplicate={(dupCounts.get(`${req.method}:${req.url}`) || 0) > 1}
                onSelect={onSelect}
                onIgnoreDomain={onIgnoreDomain}
                onToggleBookmark={onToggleBookmark}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
