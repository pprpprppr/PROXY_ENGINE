import sys
import os

target_file = '/app/applet/src/App.tsx'

if not os.path.exists(target_file):
    print(f"File not found: {target_file}")
    sys.exit(1)

with open(target_file, 'r') as f:
    content = f.read()

lines = content.splitlines()

# Search for the block
start_idx = -1
for i, line in enumerate(lines):
    if "{!activeIntercept ? (" in line and "inspector" in lines[i-40 if i > 40 else 0 : i]:
        start_idx = i
        break

if start_idx == -1:
    print("Could not find block start")
    sys.exit(1)

# Find the end of the block
end_idx = -1
for i in range(start_idx, len(lines)):
    if ")} " in lines[i] and i+2 < len(lines) and "intruder" in lines[i+2]:
        end_idx = i
        break

if end_idx == -1:
    print("Could not find block end")
    sys.exit(1)

replacement = """                   {!activeIntercept ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-gray-600 space-y-4 opacity-50">
                         <Shield className="w-16 h-16" />
                         <div className="text-center font-sans">
                             <h3 className="text-lg font-bold text-gray-400">Review Queue Empty</h3>
                             <p className="text-sm">Requests will pause here for inspection.</p>
                         </div>
                      </div>
                   ) : (
                    <div className="flex-1 flex min-h-0 bg-[#0A0C10]">
                        {/* Metadata Transformation Workspace */}
                        <div className="flex-1 p-4 flex flex-col space-y-4 border-r border-gray-800 overflow-y-auto hide-scrollbar">
                           <div className="flex gap-2">
                               <input 
                                  value={interceptMethod}
                                  onChange={e => setInterceptMethod(e.target.value)}
                                  className="w-24 bg-[#16181D] border border-gray-700 rounded px-2 py-1.5 text-orange-400 focus:outline-none focus:border-[#00E5FF] font-bold"
                               />
                               <input 
                                  className="flex-1 bg-[#16181D] border border-gray-700 rounded px-3 py-1.5 text-gray-300 focus:outline-none focus:border-[#00E5FF]"
                                  value={interceptUrl}
                                  onChange={e => setInterceptUrl(e.target.value)}
                               />
                            </div>
                            
                            <div className="flex flex-col gap-1">
                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest pl-1">Protocol Headers</span>
                                <textarea 
                                    className="h-48 bg-[#16181D] border border-gray-700 rounded p-3 text-xs text-green-400 focus:outline-none focus:border-[#00E5FF] resize-none font-mono leading-relaxed"
                                    value={interceptHeaders}
                                    onChange={e => setInterceptHeaders(e.target.value)}
                                />
                            </div>
                            
                            <div className="flex-1 flex flex-col gap-1 min-h-0">
                               <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest pl-1">Body Buffer</span>
                               <textarea 
                                   className="flex-1 min-h-[300px] bg-[#16181D] border border-gray-700 rounded p-3 text-xs text-gray-300 focus:outline-none focus:border-[#00E5FF] resize-none font-mono leading-relaxed"
                                   value={interceptBody}
                                   onChange={e => setInterceptBody(e.target.value)}
                               />
                            </div>
                        </div>

                        {/* Template Library Sidebar */}
                        <div className="w-48 shrink-0 bg-[#121419] flex flex-col p-3 gap-4 border-l border-gray-900 overflow-y-auto">
                            <div className="text-[10px] text-gray-500 font-bold uppercase tracking-widest flex items-center gap-2">
                                <Sparkles className="w-3 h-3 text-[#00E5FF]" />
                                Template Library
                            </div>
                            <div className="space-y-2">
                                {templates.map((t, idx) => (
                                    <button 
                                        key={idx}
                                        onClick={() => setInterceptBody(t.value)}
                                        className="w-full text-left p-2 rounded bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700/50 transition-all group"
                                    >
                                        <div className="text-[11px] font-bold text-gray-300 group-hover:text-[#00E5FF]">{t.name}</div>
                                        <div className="text-[9px] text-gray-500 truncate mt-0.5">{t.value}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                   )}"""

new_content = lines[:start_idx] + replacement.splitlines() + lines[end_idx+1:]
with open(target_file, 'w') as f:
    f.write('\n'.join(new_content) + '\n')

print(f"Successfully updated block from line {start_idx+1} to {end_idx+1}")
