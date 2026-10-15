// Editor server. Serves the editor UI and hosts the open project's Vite dev server
// (in middleware mode) on the same origin, so the editor can reach into the game iframe.
// Projects can be switched at runtime without restarting the editor.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import pixiEditor from "./plugin.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR_DIR = path.resolve(HERE, "../editor");
const BASE = "/__pixi-editor/";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const CONFIG_DIR = path.join(os.homedir(), ".pixi-editor");
const RECENT_FILE = path.join(CONFIG_DIR, "recent.json");
const MAX_RECENT = 12;

// ------------------------------------------------------------ recent projects
function readRecent() {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"));
    return Array.isArray(list) ? list.filter((p) => p && fs.existsSync(p.path)) : [];
  } catch {
    return [];
  }
}
function addRecent(project) {
  const list = readRecent().filter((p) => p.path !== project.path);
  list.unshift({ name: project.name, path: project.path, openedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify(list.slice(0, MAX_RECENT), null, 2));
  } catch { /* not critical */ }
}

// ------------------------------------------------------------ native folder dialog
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) }));
  });
}
const PROMPT = "Select a PixiJS project folder";

/** Opens the OS folder picker. Resolves to an absolute path, or null if canceled. */
export async function pickFolder() {
  if (process.platform === "darwin") {
    const r = await run("osascript", ["-e", "activate", "-e", `POSIX path of (choose folder with prompt "${PROMPT}")`]);
    if (r.err) {
      if (/-128|cancel/i.test(r.stderr)) return null;
      throw new Error(r.stderr.trim() || String(r.err));
    }
    return r.stdout.trim().replace(/\/$/, "") || null;
  }
  if (process.platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
      `$d.Description = '${PROMPT}';`,
      "$d.ShowNewFolderButton = $false;",
      "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join(" ");
    const r = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", ps]);
    if (r.err) throw new Error(r.stderr.trim() || String(r.err));
    return r.stdout.trim() || null;
  }
  // Linux: zenity, then kdialog.
  let r = await run("zenity", ["--file-selection", "--directory", `--title=${PROMPT}`]);
  if (r.err && r.err.code === "ENOENT") r = await run("kdialog", ["--getexistingdirectory", os.homedir(), "--title", PROMPT]);
  if (r.err) {
    if (r.err.code === "ENOENT") throw new Error("No folder dialog available (install zenity or kdialog), or type the path in the search bar.");
    return null; // canceled
  }
  return r.stdout.trim() || null;
}

// ------------------------------------------------------------ project validation
function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Finds the Vite installed in the project. */
async function loadVite(root) {
  const req = createRequire(path.join(root, "package.json"));
  let pkgPath;
  try {
    pkgPath = req.resolve("vite/package.json");
  } catch {
    throw new Error("Vite is not installed in this project. Run `npm install` in the project folder first.");
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let entry = pkg.exports?.["."]?.import;
  if (entry && typeof entry === "object") entry = entry.default;
  entry = entry || pkg.module || "dist/node/index.js";
  return import(pathToFileURL(path.join(path.dirname(pkgPath), entry)).href);
}

function inspectProject(dir) {
  const root = path.resolve(expandHome(String(dir || "").trim()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`);
  const pkgFile = path.join(root, "package.json");
  if (!fs.existsSync(pkgFile)) throw new Error("That folder has no package.json — pick the root folder of a PixiJS project.");
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")); } catch { /* ignore */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const warnings = [];
  if (!deps["pixi.js"]) warnings.push("pixi.js is not listed in package.json.");
  if (!fs.existsSync(path.join(root, "index.html"))) warnings.push("No index.html at the project root.");
  return { root, name: path.basename(root), pixi: deps["pixi.js"] || null, warnings };
}

// ------------------------------------------------------------ ports
/** Finds a free TCP port (used for Vite's HMR websocket). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** If another Pixi Editor is still running on this port, ask it to quit. */
async function takeOverPort(port) {
  const base = `http://127.0.0.1:${port}${BASE}api/`;
  try {
    const ping = await fetch(base + "ping", { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    if (ping.app !== "pixi-editor") return false;
    console.log(`  Closing the previous Pixi Editor on port ${port}…`);
    await fetch(base + "quit", { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const free = await new Promise((resolve) => {
        const probe = net.createServer().once("error", () => resolve(false)).listen(port, () => probe.close(() => resolve(true)));
      });
      if (free) return true;
    }
  } catch { /* not a Pixi Editor (or not answering) */ }
  return false;
}

// ------------------------------------------------------------ server
export async function startEditor({ port = 5180, project = null, open = true } = {}) {
  let current = null; // { name, path, vite, pixi, warnings }
  let switching = Promise.resolve();

  async function openProject(dir) {
    const info = inspectProject(dir);
    const viteModule = await loadVite(info.root);
    const { createServer } = viteModule;
    // Vite 8.3 renamed server.hmr.port to server.ws.port.
    const [major, minor] = String(viteModule.version || "0.0").split(".").map(Number);
    const useWs = major > 8 || (major === 8 && minor >= 3);
    // Close the previous project first: it frees the HMR port for the new one.
    if (current) {
      await current.vite.close().catch(() => {});
      current = null;
    }
    const hmrPort = await freePort();
    const vite = await createServer({
      root: info.root,
      plugins: [pixiEditor()],
      server: useWs ? { middlewareMode: true, ws: { port: hmrPort } } : { middlewareMode: true, hmr: { port: hmrPort } },
      appType: "spa",
      clearScreen: false,
    });
    current = { name: info.name, path: info.root, pixi: info.pixi, warnings: info.warnings, vite };
    addRecent(current);
    console.log(`  Project → ${info.root}`);
    return current;
  }

  const publicProject = () => (current ? { name: current.name, path: current.path, pixi: current.pixi, warnings: current.warnings } : null);

  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === `${BASE}api/ping`) return json(res, 200, { app: "pixi-editor", pid: process.pid });

    if (p === `${BASE}api/state`) return json(res, 200, { project: publicProject(), recent: readRecent(), home: os.homedir(), platform: process.platform });

    if (p === `${BASE}api/quit` && req.method === "POST") {
      json(res, 200, { ok: true });
      setTimeout(() => shutdown("Quit from the editor"), 50);
      return;
    }

    if (p === `${BASE}api/pick` && req.method === "POST") {
      try {
        const folder = await pickFolder();
        return json(res, 200, folder ? { path: folder } : { canceled: true });
      } catch (err) {
        return json(res, 200, { error: String(err.message || err) });
      }
    }

    if (p === `${BASE}api/open` && req.method === "POST") {
      const body = await readBody(req);
      const task = switching.then(() => openProject(body.path));
      switching = task.catch(() => {});
      try {
        await task;
        return json(res, 200, { ok: true, project: publicProject() });
      } catch (err) {
        return json(res, 200, { ok: false, error: String(err.message || err) });
      }
    }

    // Editor UI (static files).
    if (p === "/__pixi-editor" || (p.startsWith(BASE) && !p.startsWith(`${BASE}api/`))) {
      const rel = p.length <= BASE.length ? "index.html" : p.slice(BASE.length);
      const file = path.resolve(EDITOR_DIR, rel);
      if (file.startsWith(EDITOR_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        return res.end(fs.readFileSync(file));
      }
      res.statusCode = 404;
      return res.end("Not found");
    }

    // Everything else belongs to the open project (game page, modules, assets, save API).
    await switching;
    if (!current) {
      if (p === "/") { res.statusCode = 302; res.setHeader("Location", BASE); return res.end(); }
      res.statusCode = 404;
      return res.end("No project open");
    }
    current.vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });

  const listen = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => { server.off("error", reject); resolve(); });
  });
  try {
    await listen();
  } catch (err) {
    if (err.code !== "EADDRINUSE" || !(await takeOverPort(port))) throw err;
    await listen();
  }

  // Clean shutdown: close the project's Vite (file watchers, HMR socket) and free the port.
  let stopping = false;
  async function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    console.log(`\n  ${reason} — shutting down Pixi Editor…`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    try { if (current) await current.vite.close(); } catch { /* ignore */ }
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(`Received ${sig}`));
  const editorUrl = `http://localhost:${port}${BASE}`;
  console.log(`\n  Pixi Editor → ${editorUrl}\n`);

  if (project) {
    try { await openProject(project); } catch (err) { console.error(`  Could not open ${project}: ${err.message}`); }
  }
  if (open) openBrowser(editorUrl);
  return server;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {});
}
