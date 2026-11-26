const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

let mainWindow = null;
let serverProcess = null;
let boundUiPort = 3000;
let boundProxyPort = 8082;
let isQuitting = false;

function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function allocatePort(preferred, host = '127.0.0.1') {
  if (await checkPortFree(preferred, host)) return preferred;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : preferred;
      srv.close(() => resolve(port));
    });
  });
}

function waitForBackendReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() > deadline) {
        return reject(new Error(`Backend did not become ready on port ${port} within ${timeoutMs}ms`));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          return resolve();
        }
        setTimeout(poll, 150);
      });
      req.on('error', () => {
        setTimeout(poll, 150);
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    };
    poll();
  });
}

function resolveBackendLaunch() {
  const userDataDir = app.getPath('userData');
  const distDir = path.join(__dirname, 'dist');
  const compiledEntry = path.join(__dirname, 'dist-server', 'server.js');
  const devEntry = path.join(__dirname, 'server.ts');

  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PROXY_HOST: '127.0.0.1',
    PORT: String(boundUiPort),
    PROXY_PORT: String(boundProxyPort),
    PROXYSUITE_DATA_DIR: userDataDir,
    PROXYSUITE_LEGACY_JSON_DIR: __dirname,
    PROXYSUITE_DIST_DIR: distDir,
  };

  if (app.isPackaged || fs.existsSync(compiledEntry)) {
    return {
      command: process.execPath,
      args: [compiledEntry],
      env: {
        ...env,
        NODE_ENV: 'production',
        ELECTRON_RUN_AS_NODE: '1',
      },
      cwd: path.dirname(compiledEntry),
    };
  }

  const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return {
    command: process.execPath,
    args: [tsxCli, devEntry],
    env: {
      ...env,
      NODE_ENV: process.env.NODE_ENV || 'development',
      ELECTRON_RUN_AS_NODE: '1',
    },
    cwd: __dirname,
  };
}

async function startBackend() {
  boundUiPort = await allocatePort(Number(process.env.PORT) || 3000);
  boundProxyPort = await allocatePort(Number(process.env.PROXY_PORT) || 8082);
  if (boundProxyPort === boundUiPort) {
    boundProxyPort = await allocatePort(boundUiPort + 1);
  }

  const launch = resolveBackendLaunch();
  serverProcess = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });
  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });
  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      console.error(`Backend exited unexpectedly (code=${code}, signal=${signal})`);
    }
    serverProcess = null;
  });

  await waitForBackendReady(boundUiPort);
}

async function stopBackend() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore
      }
      resolve();
    }, 4000);

    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(forceTimer);
      resolve();
    }
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }

  const iconPath = path.join(
    __dirname,
    'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'ProxySuite Desktop',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: '#0E1015',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${boundUiPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (process.platform === 'win32') {
  app.setAppUserModelId('com.proxysuite.desktop');
}
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    createWindow();
  });

  ipcMain.handle('proxysuite:get-app-info', () => ({
    version: app.getVersion(),
    userDataDir: app.getPath('userData'),
    uiPort: boundUiPort,
    proxyPort: boundProxyPort,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('proxysuite:open-data-dir', async () => {
    await shell.openPath(app.getPath('userData'));
    return true;
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
      createWindow();
    } catch (err) {
      dialog.showErrorBox(
        'ProxySuite Startup Error',
        err instanceof Error ? err.message : String(err)
      );
      await stopBackend();
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });

  app.on('before-quit', async (event) => {
    if (isQuitting) return;
    isQuitting = true;
    if (serverProcess) {
      event.preventDefault();
      await stopBackend();
      app.quit();
    }
  });
}
