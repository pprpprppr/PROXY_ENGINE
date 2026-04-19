# ProxySuite: High-Performance Diagnostic Proxy

A full-stack Node.js and React application for intercepting, analyzing, and modifying HTTP/HTTPS traffic.

## Features

- **Real-time Interception**: Pause and modify HTTP requests/responses.
- **AI-Powered Analysis**: Integrated Gemini AI for automated security reviews and logic flaw detection.
- **Traffic Repeater & Intruder**: Replay and fuzz requests with custom payloads.
- **WebSocket Inspector**: View and interact with binary/text frames.
- **Mitm Engine**: Built-in Root CA generation for HTTPS inspection.
- **Session Management**: Export and port audit logs between environments.

## Local Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd proxysuite
npm install
```

### 2. Configure Environment

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Edit `.env` and add your **GEMINI_API_KEY**. You can get one for free at [Google AI Studio](https://aistudio.google.com/app/apikey).

### 3. Start the Application

```bash
npm run dev
```

The application will be available at [http://localhost:3000](http://localhost:3000).

## Advanced Execution Modes

### 1. Standalone Desktop App (Electron)

To run ProxySuite as a dedicated desktop application window:

```bash
npm run electron:dev
```

To package it for distribution as a portable executable:

```bash
npm run electron:build
```

### 2. Docker Container

To run ProxySuite in a fully isolated containerized environment:

```bash
# Build the image
docker build -t proxysuite .

# Run the container
docker run -p 3000:3000 -p 8081:8081 --env-file .env proxysuite
```

## Usage

1. **Configure Browser Proxy**: Point your browser's HTTP proxy to `127.0.0.1:8081`.
2. **Install Root CA**: If inspecting HTTPS, download the CA certificate provided in the UI 'Settings' tab and install it in your browser/OS trust store.
3. **Analyze Traffic**: Use the 'Inspector' tab to view traffic and click 'AI Scan' to trigger a security analysis.

## Project Structure

- `server.ts`: Express backend and Mitm proxy engine.
- `src/App.tsx`: Main React UI.
- `src/hooks/useTraffic.ts`: Global state management for captured packets.
- `database.ts`: Persistence layer for audit logs.

## Security Warning

This tool is for diagnostic and educational purposes only. Do not use it to intercept traffic on networks you do not own. Always ensure the generated Root CA is kept secure.
