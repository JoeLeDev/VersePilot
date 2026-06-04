const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const path = require("path");
const { fork } = require("child_process");

// macOS : capture du son système (loopback) — requis pour getDisplayMedia + audio.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch(
    "enable-features",
    "MacLoopbackAudioForScreenShare"
  );
}

const BACKEND_PORT = "4000";
const FRONTEND_DEV_URL = "http://localhost:5173";

let backendProcess = null;

function getBackendEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "server.js");
  }
  return path.join(__dirname, "..", "backend", "server.js");
}

function getBackendCwd() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend");
  }
  return path.join(__dirname, "..", "backend");
}

function startBackend() {
  if (backendProcess) return;

  const backendEntry = getBackendEntry();
  const backendCwd = getBackendCwd();

  backendProcess = fork(backendEntry, [], {
    cwd: backendCwd,
    env: {
      ...process.env,
      PORT: BACKEND_PORT,
    },
    stdio: "inherit",
  });

  backendProcess.on("exit", () => {
    backendProcess = null;
  });
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill();
  backendProcess = null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "VersePilot Live",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, "..", "frontend", "dist", "index.html"));
  } else {
    win.loadURL(FRONTEND_DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  }
}

function setupDisplayMediaHandler() {
  const isMac = process.platform === "darwin";

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!sources.length) {
          callback({});
          return;
        }
        callback({
          video: sources[0],
          audio: isMac ? "loopback" : true,
        });
      } catch (err) {
        console.warn("DisplayMedia handler:", err?.message || err);
        callback({});
      }
    },
    isMac ? { useSystemPicker: true } : {}
  );
}

app.whenReady().then(() => {
  setupDisplayMediaHandler();
  // In dev, backend is started by npm scripts (concurrently).
  // In packaged app, Electron must start it itself.
  if (app.isPackaged) {
    startBackend();
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (app.isPackaged) {
    stopBackend();
  }
});
