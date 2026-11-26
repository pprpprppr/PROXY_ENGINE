# Use Node.js 24 LTS (includes built-in node:sqlite in WAL mode)
FROM node:24-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# Persist SQLite database and generated Root CA in /data
ENV PROXYSUITE_DATA_DIR=/data
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PROXY_HOST=0.0.0.0
ENV PORT=3000
ENV PROXY_PORT=8082

VOLUME ["/data"]

EXPOSE 3000
EXPOSE 8082

CMD ["npm", "run", "start:prod"]
