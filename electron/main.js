const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

// macOS : capture du son système (loopback) — requis pour getDisplayMedia + audio.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch(
    "enable-features",
    "MacLoopbackAudioForScreenShare"
  );
}

const BACKEND_PORT = process.env.PORT || "4000";
const FRONTEND_DEV_URL = "http://localhost:5173";
const BACKEND_HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/health`;

let backendProcess = null;

function getBackendEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "backend", "server.js");
  }
  return path.join(__dirname, "..", "backend", "server.js");
}

function getBackendCwd() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "app.asar.unpacked", "backend");
  }
  return path.join(__dirname, "..", "backend");
}

function getDefaultEnvTemplate() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "config", "default.env");
  }
  return path.join(__dirname, "..", "delivery", "default.env");
}

function ensureUserConfig() {
  const userEnvPath = path.join(app.getPath("userData"), ".env");
  if (fs.existsSync(userEnvPath)) {
    return userEnvPath;
  }

  const template = getDefaultEnvTemplate();
  fs.mkdirSync(path.dirname(userEnvPath), { recursive: true });
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, userEnvPath);
    console.log("[VersePilot] Config créée :", userEnvPath);
  } else {
    fs.writeFileSync(userEnvPath, `PORT=${BACKEND_PORT}\nSEARCH_MODE=offline\n`, "utf8");
    console.warn("[VersePilot] Modèle default.env introuvable — config minimale créée.");
  }
  return userEnvPath;
}

function startBackend() {
  if (backendProcess) return;

  const backendEntry = getBackendEntry();
  const backendCwd = getBackendCwd();
  const userEnvPath = ensureUserConfig();

  if (!fs.existsSync(backendEntry)) {
    console.error("[VersePilot] Backend introuvable :", backendEntry);
    return;
  }

  backendProcess = fork(backendEntry, [], {
    cwd: backendCwd,
    env: {
      ...process.env,
      PORT: BACKEND_PORT,
      VERSEPILOT_ENV_FILE: userEnvPath,
    },
    stdio: "inherit",
  });

  backendProcess.on("exit", (code) => {
    backendProcess = null;
    if (code && code !== 0) {
      console.error("[VersePilot] Backend arrêté, code:", code);
    }
  });
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill();
  backendProcess = null;
}

async function waitForBackend(maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const response = await fetch(BACKEND_HEALTH_URL);
      if (response.ok) return true;
    } catch {
      /* backend pas encore prêt */
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return false;
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

  return win;
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

app.whenReady().then(async () => {
  setupDisplayMediaHandler();

  if (app.isPackaged) {
    startBackend();
    const ok = await waitForBackend();
    if (!ok) {
      console.error(
        "[VersePilot] Le backend n'a pas démarré à temps. Vérifiez les logs et",
        path.join(app.getPath("userData"), ".env")
      );
    }
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
