const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'ProxySuite Desktop',
    icon: path.join(__dirname, 'public/favicon.ico'), // Ensure this exists or omit
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#0E1015'
  });

  // Load the backend server URL
  mainWindow.loadURL('http://localhost:3000');

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

function startBackend() {
  // Use tsx to run the server in dev mode, or node in prod
  // For portability, we use the local node_modules binary
  const tsxPath = path.join(__dirname, 'node_modules', '.bin', 'tsx');
  
  serverProcess = spawn(tsxPath, ['server.ts'], {
    env: { ...process.env, NODE_ENV: 'development' },
    shell: true
  });

  serverProcess.stdout.on('data', (data) => {
    console.log(`Server: ${data}`);
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`Server Error: ${data}`);
  });
}

app.on('ready', () => {
  startBackend();
  // Wait a bit for the server to start before opening the window
  setTimeout(createWindow, 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
