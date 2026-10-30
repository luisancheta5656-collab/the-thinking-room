// Windows desktop shell for The Thinking Room.
//
// Starts two private background processes on random loopback ports, then
// shows the game in an app window:
//   1. the OpenSpiel engine (engine/server.py on the bundled Python), and
//   2. the Next.js server (the standalone build, run by Electron's own Node).
// In development (`npm run desktop`) it runs `next dev` and the engine from
// engine/.venv instead.

const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

// On laptops with two GPUs, Chromium otherwise renders the 3D boards on the
// integrated one; WebGL's powerPreference alone does not change that on Windows.
// Harmless on machines with a single GPU. Must be set before the app is ready.
app.commandLine.appendSwitch("force_high_performance_gpu");

const isDev = !app.isPackaged;
const projectRoot = path.join(__dirname, "..");
const resources = isDev ? projectRoot : process.resourcesPath;
const children = [];
let mainWindow = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function track(child, name) {
  children.push(child);
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code) => {
    if (code && !app.isQuitting) console.error(`[${name}] exited with code ${code}`);
  });
  return child;
}

function pythonCommand() {
  if (!isDev) return { command: path.join(resources, "python", "python.exe"), args: [] };
  if (process.env.OPENSPIEL_PYTHON) return { command: process.env.OPENSPIEL_PYTHON, args: [] };
  const venv = path.join(projectRoot, "engine", ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venv)) return { command: venv, args: [] };
  return { command: "py", args: ["-3.11"] };
}

function startEngine() {
  const { command, args } = pythonCommand();
  const script = path.join(resources, "engine", "server.py");
  const engine = track(spawn(command, [...args, "-I", script, "--port", "0"], { windowsHide: true }), "engine");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The OpenSpiel engine did not start within 60 seconds.")), 60_000);
    let buffer = "";
    engine.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/THINKING_ROOM_ENGINE_READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    engine.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    engine.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The OpenSpiel engine exited with code ${code}.`));
    });
  });
}

function startWebServer(port, enginePort) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    ...(enginePort ? { OPENSPIEL_URL: `http://127.0.0.1:${enginePort}` } : {}),
  };
  if (isDev) {
    const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
    return track(spawn(process.execPath, [nextBin, "dev", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: projectRoot,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    }), "next");
  }
  const serverDir = path.join(resources, "app-server");
  return track(spawn(process.execPath, [path.join(serverDir, "server.js")], {
    cwd: serverDir,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production" },
    windowsHide: true,
  }), "next");
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (response) => {
        response.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() > deadline) reject(new Error(`The game server did not respond at ${url}.`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

const loadingPage = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>The Thinking Room</title><style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #111; color: #eee;
         font: 15px "Segoe UI", sans-serif; letter-spacing: .08em; }
</style></head><body>STARTING THE THINKING ROOM…</body></html>`)}`;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "The Thinking Room",
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(loadingPage);

  let enginePort = null;
  try {
    enginePort = await startEngine();
  } catch (error) {
    // The game still works with the built-in local AI; tell the player once.
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "OpenSpiel engine unavailable",
      message: "The OpenSpiel agent team could not start, so the built-in local AI will play instead.",
      detail: String(error instanceof Error ? error.message : error),
    });
  }

  const port = await freePort();
  startWebServer(port, enginePort);
  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(url, isDev ? 180_000 : 60_000);
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });
  await mainWindow.loadURL(url);
}

function stopChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      // Kill the whole tree: `next dev` starts worker processes of its own.
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {});
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => createWindow().catch((error) => {
    dialog.showErrorBox("The Thinking Room could not start", String(error instanceof Error ? error.message : error));
    app.quit();
  }));
  app.on("before-quit", () => {
    app.isQuitting = true;
    stopChildren();
  });
  app.on("window-all-closed", () => app.quit());
}
