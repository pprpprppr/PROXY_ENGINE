import { create } from 'zustand';

export interface CapturedRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timestamp: number;
  status: 'pending' | 'completed' | 'error' | 'intercepted' | 'dropped' | 'response_intercepted';
  response?: {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    timestamp: number;
    duration?: number;
    passiveAnalysis?: string;
  };
  analysis?: string; // AI analysis
}

interface TrafficState {
  requests: CapturedRequest[];
  addRequest: (req: CapturedRequest) => void;
  updateResponse: (res: any) => void;
  setRequests: (reqs: CapturedRequest[]) => void;
  updateAnalysis: (id: string, analysis: string) => void;
  clearRequests: () => void;
}

const MAX_HISTORY = 500;

export const useTrafficStore = create<TrafficState>((set) => ({
  requests: [],
  addRequest: (req) => set((state) => {
    // Check for dupes before adding (sometimes ws fires identically)
    if (state.requests.find(r => r.id === req.id)) return state;
    
    let newReqs = [req, ...state.requests];
    // Slicing to max 500 requests as requested by user constraints
    if (newReqs.length > MAX_HISTORY) {
        newReqs = newReqs.slice(0, MAX_HISTORY);
    }
    return { requests: newReqs };
  }),
  updateResponse: (res) => set((state) => ({
      requests: state.requests.map((r) => r.id === res.id ? {
          ...r,
          status: res.status || ('completed' as const),
          response: res
      } : r)
  })),
  updateAnalysis: (id, analysis) => set((state) => ({
      requests: state.requests.map((r) => r.id === id ? {
          ...r, analysis
      } : r)
  })),
  setRequests: (reqs) => set({ requests: reqs }),
  clearRequests: () => set({ requests: [] }),
}));
