import React, { memo, useState } from 'react';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Filter,
  Loader2,
  Pause,
  Search,
  Sparkles,
  ShieldAlert,
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
  req: PacketSummary;
  isSelected: boolean;
  isDuplicate: boolean;
  onSelect: (id: string) => void;
  onIgnoreDomain: (host: string) => void;
  onToggleBookmark: (req: PacketSummary) => void;
}

const TrafficRow = memo(function TrafficRow({
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
      className={`border-b border-gray-800/40 hover:bg-[#1C1F26] cursor-pointer transition-colors group select-none ${
        isSelected ? 'bg-[#00E5FF]/10' : ''
      } ${isIntercepted ? 'bg-orange-950/20' : ''}`}
    >
      <td className="px-2 py-2 text-[10px] w-7 text-center">
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
      <td className="px-2 py-2">
        <span
          className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded leading-none shrink-0 ${
            req.method === 'POST'
              ? 'bg-indigo-900/40 text-indigo-400'
              : req.method === 'DELETE'
                ? 'bg-red-900/40 text-red-400'
                : req.method === 'PUT' || req.method === 'PATCH'
                  ? 'bg-amber-900/40 text-amber-400'
                  : 'bg-emerald-900/40 text-emerald-400'
          }`}
        >
          {req.method}
        </span>
      </td>
      <td className="px-2 py-2 text-gray-300 font-mono">
        <div className="flex items-center gap-1.5 group/host">
          <span className="truncate max-w-[140px]" title={req.host}>
            {req.host}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIgnoreDomain(req.host.split(':')[0]);
            }}
            className="opacity-0 group-hover/host:opacity-100 p-0.5 hover:bg-gray-700 rounded text-gray-500 hover:text-red-400 transition-all"
            title="Ignore domain during intercept"
          >
            <Filter className="w-3 h-3" />
          </button>
        </div>
      </td>
      <td className="px-2 py-2 font-mono text-gray-400 max-w-[280px] truncate" title={req.url}>
        <div className="flex items-center gap-1.5">
          <span className="truncate">{req.path}</span>
          {isDuplicate && (
            <span className="text-[9px] px-1 rounded bg-gray-800 text-gray-400 border border-gray-700 shrink-0">
              DUP
            </span>
          )}
          {req.hasPassiveFindings && (
            <span title="Passive security findings">
              <ShieldAlert className="w-3 h-3 text-orange-400 shrink-0" />
            </span>
          )}
          {req.hasAiAnalysis && (
            <span title="AI analysis available">
              <Sparkles className="w-3 h-3 text-purple-400 shrink-0" />
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-2">
        {isIntercepted ? (
          <span className="text-orange-400 font-bold flex items-center gap-1 text-[10px]">
            <Pause className="w-2.5 h-2.5" /> Held
          </span>
        ) : req.status === 'dropped' ? (
          <span className="text-red-400 font-bold text-[10px]">Dropped</span>
        ) : !req.statusCode ? (
          <span className="text-gray-600 flex items-center gap-1 italic text-[10px]">
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
      <td className="px-2 py-2 text-right opacity-70 font-mono text-[11px]">
        {req.duration !== undefined ? `${req.duration}ms` : '-'}
      </td>
      <td className="px-2 py-2 text-right opacity-70 font-mono text-[11px]">
        {req.statusCode
          ? `${req.resBodySize > 1024 ? `${(req.resBodySize / 1024).toFixed(1)}k` : req.resBodySize}${
              req.resBodyTruncated ? '+' : ''
            }`
          : '-'}
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
  const [savedFilters, setSavedFilters] = useState<Array<{ name: string; filters: Partial<TrafficFilterState> }>>([
    { name: 'POST Requests', filters: { method: 'POST', statusGroup: 'ALL' } },
    { name: '4xx/5xx Errors', filters: { method: 'ALL', statusGroup: 'errors' } },
    { name: 'Findings', filters: { method: 'ALL', statusGroup: 'findings' } },
    { name: 'JSON APIs', filters: { contentType: 'json' } },
  ]);

  // Identify duplicate (method + url) signatures within current page
  const dupCounts = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) {
      const key = `${item.method}:${item.url}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [items]);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="flex-1 overflow-hidden bg-[#0A0C10] flex flex-col">
      {/* Advanced Filter Bar */}
      <div className="bg-[#1C1F26] border-b border-gray-800 p-2.5 flex flex-col gap-2 shrink-0">
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <select
            value={filters.method}
            onChange={(e) => onFiltersChange({ ...filters, method: e.target.value })}
            className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-indigo-500"
          >
            <option value="ALL">All Methods</option>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
            <option value="OPTIONS">OPTIONS</option>
          </select>

          <select
            value={filters.statusGroup}
            onChange={(e) => onFiltersChange({ ...filters, statusGroup: e.target.value })}
            className="bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-indigo-500"
          >
            <option value="ALL">All Status</option>
            <option value="2xx">2xx Success</option>
            <option value="3xx">3xx Redirect</option>
            <option value="4xx">4xx Client Err</option>
            <option value="5xx">5xx Server Err</option>
            <option value="errors">Errors / Dropped</option>
            <option value="findings">Has Findings</option>
          </select>

          <input
            value={filters.contentType}
            onChange={(e) => onFiltersChange({ ...filters, contentType: e.target.value })}
            placeholder="Content-Type (e.g. json)"
            className="w-36 bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-indigo-500"
          />

          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1.5" />
            <input
              value={filters.search}
              onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
              placeholder="Filter URL / host / path..."
              className="w-full bg-[#0A0C10] border border-gray-700 rounded pl-7 pr-2 py-1 text-gray-300 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <input
            value={filters.bodySearch}
            onChange={(e) => onFiltersChange({ ...filters, bodySearch: e.target.value })}
            placeholder="Search inside bodies..."
            className="w-40 bg-[#0A0C10] border border-gray-700 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-indigo-500"
          />

          <button
            onClick={() => onFiltersChange({ ...filters, bookmarkedOnly: !filters.bookmarkedOnly })}
            className={`px-2 py-1 rounded border flex items-center gap-1 ${
              filters.bookmarkedOnly
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-[#0A0C10] border-gray-700 text-gray-400 hover:text-gray-200'
            }`}
            title="Show bookmarked only"
          >
            <Bookmark className="w-3 h-3" />
          </button>

          <button
            onClick={() => {
              const name = window.prompt('Save current filter view as:');
              if (name?.trim()) {
                setSavedFilters((prev) => [...prev, { name: name.trim(), filters: { ...filters } }]);
              }
            }}
            className="bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 px-2.5 py-1 rounded border border-indigo-500/30"
          >
            Save View
          </button>

          <button
            onClick={onClearHistory}
            className="bg-red-900/20 text-red-400 hover:bg-red-900/40 px-2 py-1 rounded border border-red-500/30 flex items-center gap-1"
            title="Clear persisted traffic history"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() =>
                onFiltersChange({
                  search: '',
                  bodySearch: '',
                  method: 'ALL',
                  statusGroup: 'ALL',
                  contentType: '',
                  bookmarkedOnly: false,
                })
              }
              className="text-[10px] bg-gray-800 hover:bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full border border-gray-700"
            >
              Reset
            </button>
            {savedFilters.map((sf, i) => (
              <button
                key={i}
                onClick={() =>
                  onFiltersChange({
                    search: '',
                    bodySearch: '',
                    method: 'ALL',
                    statusGroup: 'ALL',
                    contentType: '',
                    bookmarkedOnly: false,
                    ...sf.filters,
                  })
                }
                className="text-[10px] bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full border border-gray-700"
              >
                {sf.name}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-gray-400 font-mono shrink-0">
            <span>{totalCount} total</span>
            <button
              disabled={page <= 0}
              onClick={() => onPageChange(page - 1)}
              className="p-1 rounded bg-gray-800 disabled:opacity-30 hover:bg-gray-700"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
            <span>
              {page + 1}/{totalPages}
            </span>
            <button
              disabled={page + 1 >= totalPages}
              onClick={() => onPageChange(page + 1)}
              className="p-1 rounded bg-gray-800 disabled:opacity-30 hover:bg-gray-700"
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs text-gray-400 font-mono whitespace-nowrap">
          <thead className="bg-[#14161C] sticky top-0 border-b border-gray-800 shadow-sm z-10 text-gray-500 uppercase tracking-wider text-[10px]">
            <tr>
              <th className="px-2 py-2 font-medium w-7">★</th>
              <th className="px-2 py-2 font-medium">Method</th>
              <th className="px-2 py-2 font-medium">Host</th>
              <th className="px-2 py-2 font-medium">Path</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium text-right">Time</th>
              <th className="px-2 py-2 font-medium text-right">Size</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-600 italic">
                  No traffic matches the current filters.
                </td>
              </tr>
            )}
            {items.map((req) => (
              <TrafficRow
                key={req.id}
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
