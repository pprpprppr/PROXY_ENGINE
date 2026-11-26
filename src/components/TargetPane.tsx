import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  FolderTree,
  Globe,
  Plus,
  Shield,
  ShieldBan,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { PacketSummary, TargetScopeConfig } from '../types/proxy';
import { apiFetch } from '../lib/api';

interface TargetPaneProps {
  summaries: PacketSummary[];
  onInspectPacket: (id: string) => void;
  onSendHostToRepeater: (pkt: PacketSummary) => void;
}

export function TargetPane({ summaries, onInspectPacket, onSendHostToRepeater }: TargetPaneProps) {
  const [scope, setScope] = useState<TargetScopeConfig | null>(null);
  const [selectedHost, setSelectedHost] = useState<string>('ALL');
  const [newAllowedHost, setNewAllowedHost] = useState('');
  const [newExcludedHost, setNewExcludedHost] = useState('');
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const loadScope = () => {
    apiFetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        if (d.settings?.targetScope) setScope(d.settings.targetScope);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadScope();
  }, []);

  const persistScope = async (next: TargetScopeConfig) => {
    setScope(next);
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetScope: next }),
    });
    if (res.ok) {
      setSaveNotice('Target Scope saved');
      setTimeout(() => setSaveNotice(null), 2000);
    }
  };

  const hostGroups = useMemo(() => {
    const map = new Map<string, PacketSummary[]>();
    for (const s of summaries) {
      const host = s.host || 'unknown';
      const arr = map.get(host) || [];
      arr.push(s);
      map.set(host, arr);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [summaries]);

  const visiblePackets = useMemo(() => {
    if (selectedHost === 'ALL') return summaries;
    return summaries.filter((s) => s.host === selectedHost);
  }, [summaries, selectedHost]);

  const isHostInScope = (host: string) => {
    if (!scope) return false;
    const clean = host.split(':')[0].toLowerCase();
    if (scope.excludedHosts.some((h) => h.toLowerCase() === clean)) return false;
    if (scope.allowLocalhost && (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1')) return true;
    return scope.allowedHosts.some((h) => {
      const p = h.toLowerCase();
      return p.startsWith('*.') ? clean === p.slice(2) || clean.endsWith(p.slice(1)) : clean === p;
    });
  };

  const toggleHostInScope = (host: string) => {
    if (!scope) return;
    const clean = host.split(':')[0].toLowerCase();
    if (scope.allowedHosts.includes(clean)) {
      persistScope({ ...scope, allowedHosts: scope.allowedHosts.filter((h) => h !== clean) });
    } else {
      persistScope({
        ...scope,
        allowedHosts: [...scope.allowedHosts, clean],
        excludedHosts: scope.excludedHosts.filter((h) => h !== clean),
      });
    }
  };

  return (
    <div className="flex-1 flex min-h-0 bg-[#0B0D12]">
      {/* Left: Site Map Tree */}
      <div className="w-80 border-r border-gray-800 bg-[#12151D] flex flex-col min-h-0">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-gray-300 flex items-center gap-2">
            <FolderTree className="w-4 h-4 text-[#00E5FF]" /> Site Map ({hostGroups.length} hosts)
          </div>
        </div>

        <div className="flex-1 overflow-auto p-2 space-y-1 text-xs">
          <button
            onClick={() => setSelectedHost('ALL')}
            className={`w-full text-left px-2.5 py-2 rounded-lg flex items-center justify-between ${
              selectedHost === 'ALL' ? 'bg-indigo-500/20 text-indigo-300 font-semibold' : 'text-gray-300 hover:bg-gray-800/60'
            }`}
          >
            <span className="flex items-center gap-2">
              <Globe className="w-3.5 h-3.5" /> All Captured Hosts
            </span>
            <span className="text-[10px] text-gray-500">{summaries.length}</span>
          </button>

          {hostGroups.map(([host, items]) => {
            const inScope = isHostInScope(host);
            return (
              <div
                key={host}
                onClick={() => setSelectedHost(host)}
                className={`px-2.5 py-2 rounded-lg cursor-pointer flex items-center justify-between gap-2 ${
                  selectedHost === host ? 'bg-[#00E5FF]/15 text-white border border-[#00E5FF]/30' : 'text-gray-300 hover:bg-gray-800/60'
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <ChevronRight className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                  <span className="font-mono truncate">{host}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {inScope && <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{items.length}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Endpoints + Scope Controls */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Target Scope Quick Editor */}
        {scope && (
          <div className="p-4 border-b border-gray-800 bg-[#141720] space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-400" /> Target Scope Configuration
                </h2>
                <p className="text-xs text-gray-400">
                  Controls which hosts Repeater, Intruder, and Simulator are authorized to test (SSRF protection).
                </p>
              </div>
              {saveNotice && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {saveNotice}
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-2 cursor-pointer text-gray-200">
                <input
                  type="checkbox"
                  checked={scope.enforceScope}
                  onChange={(e) => persistScope({ ...scope, enforceScope: e.target.checked })}
                />
                Enforce Scope Rules
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-gray-200">
                <input
                  type="checkbox"
                  checked={scope.allowLocalhost}
                  onChange={(e) => persistScope({ ...scope, allowLocalhost: e.target.checked })}
                />
                Allow Localhost / Loopback (127.0.0.1)
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-gray-200">
                <input
                  type="checkbox"
                  checked={scope.allowPrivateNetworks}
                  onChange={(e) => persistScope({ ...scope, allowPrivateNetworks: e.target.checked })}
                />
                Allow Private Networks (RFC1918)
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="p-2.5 rounded-lg bg-[#0B0D12] border border-gray-800 space-y-2">
                <div className="font-semibold text-emerald-300">Included in Scope (Allowed Hosts)</div>
                <div className="flex gap-1.5">
                  <input
                    value={newAllowedHost}
                    onChange={(e) => setNewAllowedHost(e.target.value)}
                    placeholder="e.g. api.example.com or *.staging.local"
                    className="flex-1 bg-[#141720] border border-gray-700 rounded px-2 py-1 text-gray-200 font-mono"
                  />
                  <button
                    onClick={() => {
                      const h = newAllowedHost.trim().toLowerCase();
                      if (!h || scope.allowedHosts.includes(h)) return;
                      persistScope({ ...scope, allowedHosts: [...scope.allowedHosts, h] });
                      setNewAllowedHost('');
                    }}
                    className="px-2.5 py-1 bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 rounded flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {scope.allowedHosts.length === 0 && (
                    <span className="text-gray-600 italic">No custom hosts added yet.</span>
                  )}
                  {scope.allowedHosts.map((h) => (
                    <span
                      key={h}
                      className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono flex items-center gap-1"
                    >
                      {h}
                      <button
                        onClick={() => persistScope({ ...scope, allowedHosts: scope.allowedHosts.filter((x) => x !== h) })}
                        className="hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-[#0B0D12] border border-gray-800 space-y-2">
                <div className="font-semibold text-red-300">Excluded from Scope (Always Blocked)</div>
                <div className="flex gap-1.5">
                  <input
                    value={newExcludedHost}
                    onChange={(e) => setNewExcludedHost(e.target.value)}
                    placeholder="e.g. logout.example.com"
                    className="flex-1 bg-[#141720] border border-gray-700 rounded px-2 py-1 text-gray-200 font-mono"
                  />
                  <button
                    onClick={() => {
                      const h = newExcludedHost.trim().toLowerCase();
                      if (!h || scope.excludedHosts.includes(h)) return;
                      persistScope({ ...scope, excludedHosts: [...scope.excludedHosts, h] });
                      setNewExcludedHost('');
                    }}
                    className="px-2.5 py-1 bg-red-600/20 text-red-300 border border-red-500/30 rounded flex items-center gap-1"
                  >
                    <ShieldBan className="w-3.5 h-3.5" /> Block
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {scope.excludedHosts.length === 0 && (
                    <span className="text-gray-600 italic">No excluded hosts.</span>
                  )}
                  {scope.excludedHosts.map((h) => (
                    <span
                      key={h}
                      className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30 font-mono flex items-center gap-1"
                    >
                      {h}
                      <button
                        onClick={() => persistScope({ ...scope, excludedHosts: scope.excludedHosts.filter((x) => x !== h) })}
                        className="hover:text-white"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Site Map Contents Table */}
        <div className="flex-1 overflow-auto">
          <div className="px-4 py-2 bg-[#12151D] border-b border-gray-800 flex items-center justify-between text-xs">
            <span className="font-mono text-gray-300">
              Showing endpoints for: <strong className="text-[#00E5FF]">{selectedHost}</strong>
            </span>
            {selectedHost !== 'ALL' && scope && (
              <button
                onClick={() => toggleHostInScope(selectedHost)}
                className={`px-2.5 py-1 rounded border text-[11px] font-semibold ${
                  isHostInScope(selectedHost)
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                }`}
              >
                {isHostInScope(selectedHost) ? '✓ In Target Scope (Click to Remove)' : '+ Add Host to Scope'}
              </button>
            )}
          </div>

          <table className="w-full text-left text-xs font-mono text-gray-300">
            <thead className="bg-[#141720] sticky top-0 border-b border-gray-800 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Host</th>
                <th className="px-3 py-2">Path</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">MIME / Type</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visiblePackets.map((pkt) => (
                <tr
                  key={pkt.id}
                  onClick={() => onInspectPacket(pkt.id)}
                  className="border-b border-gray-800/40 hover:bg-[#191D28] cursor-pointer"
                >
                  <td className="px-3 py-2 font-bold text-indigo-300">{pkt.method}</td>
                  <td className="px-3 py-2 text-gray-400">{pkt.host}</td>
                  <td className="px-3 py-2 truncate max-w-[340px]">{pkt.path}</td>
                  <td className="px-3 py-2">
                    <span className={(pkt.statusCode || 0) < 400 ? 'text-emerald-400' : 'text-red-400'}>
                      {pkt.statusCode ?? pkt.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-500 truncate max-w-[160px]">{pkt.contentType || '-'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSendHostToRepeater(pkt);
                      }}
                      className="px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-[10px] text-gray-200 border border-gray-700"
                    >
                      Send to Repeater
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
