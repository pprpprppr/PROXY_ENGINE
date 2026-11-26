import React from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Pause, Radio, Shield, Sliders, Wifi } from 'lucide-react';
import type {
  CapturedPacket,
  InterceptItem,
  PacketSummary,
  WebSocketConnectionRecord,
  WebSocketFrameRecord,
} from '../types/proxy';
import { TrafficTable, type TrafficFilterState } from './TrafficTable';
import { InspectorPane } from './InspectorPane';
import { InterceptorPane } from './InterceptorPane';
import { WebSocketPane } from './WebSocketPane';

export type ProxySubTab = 'intercept' | 'history' | 'websockets' | 'options';

interface ProxyWorkspaceProps {
  subTab: ProxySubTab;
  onSubTabChange: (t: ProxySubTab) => void;
  interceptMode: boolean;
  responseInterceptMode: boolean;
  pendingIntercepts: InterceptItem[];
  ignoredDomains: string[];
  onToggleIntercept: (enabled: boolean) => void;
  onToggleResponseIntercept: (enabled: boolean) => void;
  onResolveIntercept: (
    id: string,
    action: 'forward' | 'drop',
    edits?: {
      modifiedMethod?: string;
      modifiedUrl?: string;
      modifiedHeaders?: Record<string, string>;
      modifiedBody?: string;
      interceptResponse?: boolean;
    }
  ) => void;
  onUpdateIgnoredDomains: (domains: string[]) => void;

  // HTTP History props
  summaries: PacketSummary[];
  totalCount: number;
  page: number;
  pageSize: number;
  selectedId: string | null;
  filters: TrafficFilterState;
  onFiltersChange: (next: TrafficFilterState) => void;
  onPageChange: (page: number) => void;
  onSelectPacket: (id: string) => void;
  onIgnoreDomain: (domain: string) => void;
  onToggleBookmark: (req: PacketSummary) => void;
  onClearHistory: () => void;

  // Cross-tool actions
  onSendPacketToRepeater: (pkt: CapturedPacket) => void;
  onSendPacketToIntruder: (pkt: CapturedPacket) => void;
  onSendRawToRepeater: (method: string, url: string, headers: string, body: string) => void;
  onSendRawToIntruder: (method: string, url: string, headers: string, body: string) => void;
  onSendToDecoder: (text: string) => void;
  onSendToComparer: (slot: 'left' | 'right', label: string, text: string) => void;

  // WebSockets props
  wsConnections: WebSocketConnectionRecord[];
  wsFrames: WebSocketFrameRecord[];
  onClearWs: () => void;
}

export function ProxyWorkspace({
  subTab,
  onSubTabChange,
  interceptMode,
  responseInterceptMode,
  pendingIntercepts,
  ignoredDomains,
  onToggleIntercept,
  onToggleResponseIntercept,
  onResolveIntercept,
  onUpdateIgnoredDomains,
  summaries,
  totalCount,
  page,
  pageSize,
  selectedId,
  filters,
  onFiltersChange,
  onPageChange,
  onSelectPacket,
  onIgnoreDomain,
  onToggleBookmark,
  onClearHistory,
  onSendPacketToRepeater,
  onSendPacketToIntruder,
  onSendRawToRepeater,
  onSendRawToIntruder,
  onSendToDecoder,
  onSendToComparer,
  wsConnections,
  wsFrames,
  onClearWs,
}: ProxyWorkspaceProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0B0D12]">
      {/* Burp-style Proxy Sub-Tabs */}
      <div className="h-10 border-b border-gray-800 bg-[#141720] px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1 h-full">
          <button
            onClick={() => onSubTabChange('intercept')}
            className={`h-full px-3.5 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              subTab === 'intercept'
                ? 'border-[#00E5FF] text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Pause className={`w-3.5 h-3.5 ${pendingIntercepts.length > 0 ? 'text-orange-400 animate-pulse' : ''}`} />
            Intercept
            {pendingIntercepts.length > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 text-[10px] font-bold">
                {pendingIntercepts.length}
              </span>
            )}
          </button>

          <button
            onClick={() => onSubTabChange('history')}
            className={`h-full px-3.5 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              subTab === 'history'
                ? 'border-[#00E5FF] text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-indigo-400" />
            HTTP History
            <span className="text-[10px] text-gray-500 font-mono">({totalCount})</span>
          </button>

          <button
            onClick={() => onSubTabChange('websockets')}
            className={`h-full px-3.5 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              subTab === 'websockets'
                ? 'border-[#00E5FF] text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Wifi className="w-3.5 h-3.5 text-cyan-400" />
            WebSockets History
            <span className="text-[10px] text-gray-500 font-mono">({wsFrames.length})</span>
          </button>

          <button
            onClick={() => onSubTabChange('options')}
            className={`h-full px-3.5 text-xs font-semibold border-b-2 flex items-center gap-2 transition-colors ${
              subTab === 'options'
                ? 'border-[#00E5FF] text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5 text-emerald-400" />
            Options & Rules
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => onToggleIntercept(!interceptMode)}
            className={`px-3 py-1 rounded-md font-bold flex items-center gap-1.5 border transition-all ${
              interceptMode
                ? 'bg-orange-500/20 border-orange-500/50 text-orange-300 shadow-[0_0_12px_rgba(249,115,22,0.2)]'
                : 'bg-[#0B0D12] border-gray-700 text-gray-400 hover:text-white'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            {interceptMode ? 'Intercept is ON' : 'Intercept is OFF'}
          </button>
        </div>
      </div>

      {/* Sub-Tab Views */}
      {subTab === 'intercept' && (
        <InterceptorPane
          mode="queue"
          interceptMode={interceptMode}
          responseInterceptMode={responseInterceptMode}
          activeIntercepts={pendingIntercepts}
          ignoredDomains={ignoredDomains}
          onToggleIntercept={onToggleIntercept}
          onToggleResponseIntercept={onToggleResponseIntercept}
          onResolveIntercept={onResolveIntercept}
          onUpdateIgnoredDomains={onUpdateIgnoredDomains}
          onSendToRepeater={onSendRawToRepeater}
          onSendToIntruder={onSendRawToIntruder}
          onSendToDecoder={onSendToDecoder}
        />
      )}

      {subTab === 'history' && (
        <PanelGroup orientation="vertical" className="flex-1 min-h-0">
          <Panel defaultSize={48} minSize={25} className="flex flex-col min-h-0">
            <TrafficTable
              items={summaries}
              totalCount={totalCount}
              page={page}
              pageSize={pageSize}
              selectedId={selectedId}
              filters={filters}
              onFiltersChange={onFiltersChange}
              onPageChange={onPageChange}
              onSelect={onSelectPacket}
              onIgnoreDomain={onIgnoreDomain}
              onToggleBookmark={onToggleBookmark}
              onClearHistory={onClearHistory}
            />
          </Panel>

          <PanelResizeHandle className="h-1.5 bg-gray-800 hover:bg-[#00E5FF] cursor-row-resize transition-colors" />

          <Panel defaultSize={52} minSize={25} className="flex flex-col min-h-0 bg-[#12151D]">
            <InspectorPane
              selectedId={selectedId}
              summaries={summaries}
              onSendToRepeater={onSendPacketToRepeater}
              onSendToIntruder={onSendPacketToIntruder}
              onSendToDecoder={onSendToDecoder}
              onSendToComparer={onSendToComparer}
            />
          </Panel>
        </PanelGroup>
      )}

      {subTab === 'websockets' && (
        <WebSocketPane connections={wsConnections} frames={wsFrames} onClear={onClearWs} />
      )}

      {subTab === 'options' && (
        <InterceptorPane
          mode="rules"
          interceptMode={interceptMode}
          responseInterceptMode={responseInterceptMode}
          activeIntercepts={pendingIntercepts}
          ignoredDomains={ignoredDomains}
          onToggleIntercept={onToggleIntercept}
          onToggleResponseIntercept={onToggleResponseIntercept}
          onResolveIntercept={onResolveIntercept}
          onUpdateIgnoredDomains={onUpdateIgnoredDomains}
          onSendToRepeater={onSendRawToRepeater}
          onSendToIntruder={onSendRawToIntruder}
          onSendToDecoder={onSendToDecoder}
        />
      )}
    </div>
  );
}
