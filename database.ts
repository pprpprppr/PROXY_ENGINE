import fs from 'fs';
import path from 'path';

export class JsonDB {
    private filePath: string;
    private data: any[] = [];

    constructor(filename: string) {
        this.filePath = path.resolve(process.cwd(), filename);
        this.load();
    }

    private load() {
        if (fs.existsSync(this.filePath)) {
            try {
                const content = fs.readFileSync(this.filePath, 'utf8');
                this.data = JSON.parse(content);
            } catch (e) {
                console.error("Failed to load database:", e);
                this.data = [];
            }
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error("Failed to save database:", e);
        }
    }

    async exec(query: string) {
        // Mock exec - we only use it for CREATE TABLE usually
        return;
    }

    async run(query: string, params: any[] = []) {
        if (query.includes('INSERT INTO intercepted_packets')) {
            const [id, timestamp, method, url, req_headers, req_body, res_headers, res_body, status_code, duration_ms, passive_analysis] = params;
            const existingIdx = this.data.findIndex(p => p.id === id);
            
            const packet = {
                id, timestamp, method, url, 
                req_headers: typeof req_headers === 'string' ? JSON.parse(req_headers) : req_headers,
                req_body, 
                res_headers: typeof res_headers === 'string' ? JSON.parse(res_headers) : res_headers,
                res_body, status_code, duration_ms, passive_analysis
            };

            if (existingIdx >= 0) {
                // Update partially as per "ON CONFLICT"
                const existing = this.data[existingIdx];
                this.data[existingIdx] = {
                    ...existing,
                    res_headers: packet.res_headers || existing.res_headers,
                    res_body: packet.res_body || existing.res_body,
                    status_code: packet.status_code || existing.status_code,
                    duration_ms: packet.duration_ms || existing.duration_ms,
                    passive_analysis: packet.passive_analysis || existing.passive_analysis
                };
            } else {
                this.data.push(packet);
            }
            this.save();
        } else if (query.includes('DELETE FROM intercepted_packets')) {
            const [expirationTime] = params;
            this.data = this.data.filter(p => (p.timestamp || 0) >= expirationTime);
            this.save();
        }
    }

    async all(query: string, params: any[] = []) {
        if (query.includes('SELECT * FROM intercepted_packets')) {
            const [limit, offset] = params;
            // Simplified sorting
            const sorted = [...this.data].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            return sorted.slice(offset || 0, (offset || 0) + (limit || 100));
        }
        return [];
    }
}
