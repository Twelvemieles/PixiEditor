// Editor server. Serves the editor UI and hosts the open project's Vite dev server
// (in middleware mode) on the same origin, so the editor can reach into the game iframe.
// Projects can be switched at runtime without restarting the editor.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import pixiEditor from "./plugin.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR_DIR = path.resolve(HERE, "../editor");
const BASE = "/__pixi-editor/";
const NEW_PROJECT_TEMPLATE = path.resolve(HERE, "../templates/new-project");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".json": "application/json", ".txt": "text/plain", ".md": "text/plain", ".atlas": "text/plain",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};
// Never listed in the project explorer.
const HIDDEN_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vite", ".cache", ".tmp", "coverage"]);

/** Resolves a project-relative path, refusing anything outside the project. */
function projectPath(root, rel) {
  const abs = path.resolve(root, String(rel || "").replace(/^[/\\]+/, ""));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join("/");
function listDir(root, dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && !(e.isDirectory() && HIDDEN_DIRS.has(e.name)))
    .map((e) => {
      const abs = path.join(dir, e.name);
      const isDir = e.isDirectory();
      let size = 0;
      if (!isDir) { try { size = fs.statSync(abs).size; } catch { /* broken link */ } }
      return { name: e.name, path: toRel(root, abs), type: isDir ? "dir" : "file", size };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "dir" ? -1 : 1));
}
/** Files whose path contains `q` (case-insensitive), up to `limit`. */
function findFiles(root, q, limit = 300) {
  const out = [];
  const needle = q.toLowerCase();
  (function walk(dir) {
    if (out.length >= limit) return;
    let entries = [];
    try { entries = listDir(root, dir); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.type === "dir") walk(path.join(root, e.path));
      else if (e.path.toLowerCase().includes(needle)) out.push(e);
    }
  })(root);
  return out;
}
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

// ------------------------------------------------------------ new projects
// Versions written into new projects' package.json (bump them here).
const NEW_PROJECT_DEPS = { "pixi.js": "^8.22.0" };
const NEW_PROJECT_DEV_DEPS = { typescript: "~5.9.3", vite: "^8.3.4" };
const NEW_PROJECT_LINT_DEPS = {
  "@eslint/js": "^10.0.1",
  eslint: "^10.12.0",
  "eslint-config-prettier": "^10.1.8",
  prettier: "^3.9.10",
  "typescript-eslint": "^8.71.2",
};

/** Folder name for a project name: "My Game" -> "my-game". */
export function projectSlug(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80);
}

/**
 * Writes a new Vite + PixiJS + TypeScript project into `<parent>/<slug(name)>`.
 * @returns {string} the project folder
 */
export function writeNewProject({ name, parent, lint = true }) {
  const slug = projectSlug(name);
  if (!slug) throw new Error("Give the project a name (letters, numbers, - or _).");
  const base = path.resolve(expandHome(String(parent || "").trim() || os.homedir()));
  const dir = path.join(base, slug);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty.`);
  fs.mkdirSync(dir, { recursive: true });
  const title = String(name).trim() || slug;
  const skip = lint ? new Set() : new Set(["eslint.config.js", "prettierrc"]);
  const copy = (from, to) => {
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const src = path.join(from, ent.name);
      // Dotfiles are stored without the dot (npm and git treat dotfiles in packages specially).
      const destName = ["gitignore", "prettierrc"].includes(ent.name) ? `.${ent.name}` : ent.name;
      const dest = path.join(to, destName);
      if (ent.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); copy(src, dest); continue; }
      if (/\.(png|jpe?g|webp|avif|gif|mp3|ogg|wav|m4a)$/i.test(ent.name)) { fs.copyFileSync(src, dest); continue; }
      fs.writeFileSync(dest, fs.readFileSync(src, "utf8").replaceAll("__TITLE__", title));
    }
  };
  copy(NEW_PROJECT_TEMPLATE, dir);
  const pkg = {
    name: slug,
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: {
      dev: "vite",
      build: lint ? "tsc && eslint . && vite build" : "tsc && vite build",
      preview: "vite preview",
      ...(lint ? { lint: "eslint .", format: "prettier --write ." } : {}),
    },
    dependencies: NEW_PROJECT_DEPS,
    devDependencies: Object.fromEntries(Object.entries({ ...NEW_PROJECT_DEV_DEPS, ...(lint ? NEW_PROJECT_LINT_DEPS : {}) }).sort()),
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return dir;
}

/** Runs `npm install` once in `dir`, calling `onLog` with output. Resolves with the output's error kind. */
function npmInstallOnce(dir, onLog) {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    // --prefer-offline: packages already in npm's cache (from other projects) are not downloaded again.
    const child = spawn(win ? "npm.cmd" : "npm", ["install", "--prefer-offline", "--no-fund", "--no-audit"], { cwd: dir, shell: win, env: process.env });
    let out = "";
    const take = (d) => { out += d; onLog(String(d)); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => reject(Object.assign(new Error(err.code === "ENOENT" ? "npm was not found. Install Node.js (it includes npm) and try again." : String(err.message || err)), { fatal: true })));
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      const network = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|network/i.test(out);
      reject(Object.assign(new Error(network
        ? "npm could not download the packages (network error). Check your internet connection or proxy, then press Retry."
        : `npm install failed (exit code ${code}).`), { network }));
    });
  });
}

/** `npm install` with automatic retries for network errors (connections reset, timeouts…). */
async function npmInstall(dir, onLog, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await npmInstallOnce(dir, onLog);
    } catch (err) {
      if (err.fatal || !err.network || i >= attempts) throw err;
      onLog(`\nNetwork error — retrying (${i + 1}/${attempts})…\n`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
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
  const jobs = new Map(); // install-and-open jobs (new projects, missing node_modules)
  let jobCounter = 0;
  /** npm install (optional) then open `dir`, in the background; the page polls the job. */
  function startJob(dir, install) {
    const id = String(++jobCounter);
    const job = { id, state: install ? "installing" : "opening", log: "", dir, error: null, project: null };
    jobs.set(id, job);
    (async () => {
      try {
        if (install) await npmInstall(dir, (t) => { job.log = (job.log + t).slice(-6000); });
        job.state = "opening";
        const task = switching.then(() => openProject(dir));
        switching = task.catch(() => {});
        await task;
        job.project = publicProject();
        job.state = "done";
      } catch (err) {
        job.state = "error";
        job.error = String(err.message || err);
      }
    })();
    return job;
  }

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

    // New project: write the files, npm install (a job the page polls), then open it.
    if (p === `${BASE}api/new` && req.method === "POST") {
      const body = await readBody(req);
      let dir;
      try { dir = writeNewProject(body); } catch (err) { return json(res, 200, { ok: false, error: String(err.message || err) }); }
      const job = startJob(dir, body.install !== false);
      return json(res, 200, { ok: true, id: job.id, dir });
    }
    // Install the dependencies of an existing folder (e.g. a project created while offline), then open it.
    if (p === `${BASE}api/install` && req.method === "POST") {
      const body = await readBody(req);
      const dir = path.resolve(expandHome(String(body.path || "").trim()));
      if (!fs.existsSync(path.join(dir, "package.json"))) return json(res, 200, { ok: false, error: "That folder has no package.json." });
      const job = startJob(dir, true);
      return json(res, 200, { ok: true, id: job.id, dir });
    }
    if (p === `${BASE}api/job-retry` && req.method === "POST") {
      const body = await readBody(req);
      const old = jobs.get(String(body.id || ""));
      if (!old || old.state !== "error") return json(res, 200, { ok: false, error: "Nothing to retry." });
      const job = startJob(old.dir, true);
      return json(res, 200, { ok: true, id: job.id, dir: old.dir });
    }
    if (p === `${BASE}api/new-status`) {
      const job = jobs.get(url.searchParams.get("id") || "");
      return json(res, 200, job ? { state: job.state, log: job.log, dir: job.dir, error: job.error, project: job.project } : { state: "error", error: "Unknown job" });
    }

    // Close the project: stop its Vite and go back to the start screen.
    if (p === `${BASE}api/close` && req.method === "POST") {
      const task = switching.then(async () => {
        if (current) { const vite = current.vite; current = null; await vite.close(); }
      });
      switching = task.catch(() => {});
      try { await task; } catch { /* already closed */ }
      return json(res, 200, { ok: true });
    }

    // Project explorer: list folders, search files, serve a file for previews.
    if (p === `${BASE}api/files` || p === `${BASE}api/file`) {
      await switching;
      if (!current) return json(res, 200, { error: "No project open" });
      const root = current.path;
      if (p === `${BASE}api/files`) {
        const q = (url.searchParams.get("q") || "").trim();
        if (q) return json(res, 200, { root: current.name, entries: findFiles(root, q) });
        const dir = projectPath(root, url.searchParams.get("dir"));
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 200, { error: "Folder not found" });
        return json(res, 200, { root: current.name, entries: listDir(root, dir) });
      }
      const file = projectPath(root, url.searchParams.get("path"));
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 20e6) {
        res.statusCode = 404;
        return res.end("Not found");
      }
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      return res.end(fs.readFileSync(file));
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
