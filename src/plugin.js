// Vite plugin: instruments the project's code, injects the runtime into the game
// page and saves editor changes by rewriting the project's source files.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { instrument } from "./instrument.js";
import { parse, parseExpression } from "@babel/parser";
import { planEdits, planImport, findLiteral, detectQuote, quoteString, fmt, lineDiff } from "./writeback.js";
import { FACTORY_RE, instrument as instrumentCode } from "./instrument.js";
import { analyzeObject, deleteEdits, duplicateEdits, pruneImports, namesIn, moveEdits } from "./refactor.js";
import { htmlRegistry, markHtml, planHtmlEdits, applyHtmlEdits, jsEscaper } from "./html.js";
import { cssRegistry, planCssEdits, scanCss, ruleKeys } from "./css.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = fs.readFileSync(path.resolve(HERE, "runtime.js"), "utf8");
// Components: one file per component, grouped in category folders (core, layout, ui, animation…),
// copied into the project's src/pixi-components/ the first time a category is used.
const COMPONENTS_TEMPLATE = path.resolve(HERE, "../templates/pixi-components");
const LEGACY_TEMPLATE = path.resolve(HERE, "../templates/legacy/pixi-components.ts");
const CATALOG = JSON.parse(fs.readFileSync(path.resolve(HERE, "../templates/components-catalog.json"), "utf8"));
const CATEGORY_OF = new Map(CATALOG.categories.flatMap((c) => c.components.map((comp) => [comp.name, c.id])));
const BUILTIN_COMPONENTS = new Set(CATEGORY_OF.keys());
const CORE_EXPORTS = ["addComponent", "useApp"]; // names the editor writes that come from core
const BEHAVIOR_TEMPLATE = path.resolve(HERE, "../templates/behavior.ts");
const PREVIEW_URL = "/@pixi-editor/components.ts";
const PREVIEW_QUERY = "?pixi-editor-preview"; // a template file the project doesn't have yet
const ALL_QUERY = "?pixi-editor-all"; // the editor's view of every component
// The project's own pixi.js, for the editor UI (textures list, creating objects live).
const PIXI_URL = "/@pixi-editor/pixi.ts";
const PIXI_ID = "__pixi_editor_pixi.ts?pixi-editor-pixi";
// The project's Spine runtime (if any), for previewing skeletons from the Project panel.
const SPINE_URL = "/@pixi-editor/spine.ts";
const SPINE_ID = "__pixi_editor_spine.ts?pixi-editor-spine";
const SPINE_PACKAGES = ["@esotericsoftware/spine-pixi-v8", "@esotericsoftware/spine-pixi"];
const BASE = "/__pixi-editor/";
const EDITOR_DIRS = ["src", "templates", "editor", "bin"].map((d) => path.resolve(HERE, "..", d));

export default function pixiEditor() {
  let root = process.cwd();
  let counter = 0;
  const nextId = (p) => `${p}${++counter}`;
  const sites = new Map(); // id -> { id, file, kind, form, args:[{start,end,text}] }
  const decls = new Map(); // id -> { id, file, name, access, insertAt, indent, start }
  const byFile = new Map(); // file -> Set(ids)
  const selfWrites = new Map(); // file -> contents written by the editor

  async function isSelfWrite(file, read) {
    const key = path.normalize(file);
    if (!selfWrites.has(key)) return false;
    const expected = selfWrites.get(key);
    // Kept while the file still has the editor's contents: Vite 6+ calls hotUpdate once per
    // environment (client, ssr…), and every call must be told it's ours.
    let same = false;
    try { same = (await read()) === expected; } catch { /* deleted */ }
    if (!same) selfWrites.delete(key);
    return same;
  }

  /**
   * Records the code sites of a freshly transformed file. When the file still has the contents the
   * editor wrote, the previous sites stay valid too (the game may still use them: Vite can
   * re-transform a file without reloading the page).
   */
  function register(file, siteList, declList, code) {
    const old = byFile.get(file);
    const ours = code != null && selfWrites.get(path.normalize(file)) === code;
    if (old && !ours) for (const id of old) { sites.delete(id); decls.delete(id); }
    const ids = ours && old ? old : new Set();
    for (const s of siteList) { s.file = file; sites.set(s.id, s); ids.add(s.id); }
    for (const d of declList) { d.file = file; decls.set(d.id, d); ids.add(d.id); }
    byFile.set(file, ids);
  }

  // index.html: its elements' code sites, with ids kept across rescans (element order + kind).
  const htmlIds = new Map(); // file -> Map(key -> id)
  /** Registers the elements of an HTML file; returns the markers that tie each tag to its element in the page. */
  function registerHtml(file, code) {
    if (!htmlIds.has(file)) htmlIds.set(file, new Map());
    const ids = htmlIds.get(file);
    const idFor = (key, prefix) => { if (!ids.has(key)) ids.set(key, nextId(prefix)); return ids.get(key); };
    const reg = htmlRegistry(code, idFor);
    register(file, reg.sites, reg.decls);
    return reg.marks;
  }
  const isHtmlFile = (file) => /\.html?$/i.test(file);
  // HTML in innerHTML templates: stable ids per file (template order + element order + kind)
  const tplIds = new Map();
  const tplIdFor = (file) => {
    if (!tplIds.has(file)) tplIds.set(file, new Map());
    const ids = tplIds.get(file);
    return (key, prefix) => { if (!ids.has(key)) ids.set(key, nextId(prefix)); return ids.get(key); };
  };
  /** After the editor rewrote a file: the template sites again (same ids, new positions, new ones added). */
  function refreshTemplates(file, code) {
    const out = instrument(code, file, () => "x", { htmlIdFor: tplIdFor(file) });
    if (!out) return [];
    const ids = byFile.get(file) || new Set();
    byFile.set(file, ids);
    const fresh = out.sites.filter((st) => st.tpl);
    for (const st of fresh) { st.file = file; sites.set(st.id, st); ids.add(st.id); }
    for (const d of out.decls.filter((x) => x.tpl)) { d.file = file; decls.set(d.id, d); ids.add(d.id); }
    return fresh;
  }
  const isCssFile = (file) => /\.css$/i.test(file);

  // CSS files: their rules' declarations, with ids kept across rescans (rule key + property).
  const cssIds = new Map(); // file -> Map(key -> id)
  function registerCss(file, code) {
    if (!cssIds.has(file)) cssIds.set(file, new Map());
    const ids = cssIds.get(file);
    const idFor = (key, prefix) => { if (!ids.has(key)) ids.set(key, nextId(prefix)); return ids.get(key); };
    const reg = cssRegistry(code, idFor);
    register(file, reg.sites, reg.decls);
    return reg;
  }
  /** A stylesheet of the game page -> its file: Vite's dev id (an absolute path) or a URL path. */
  function cssFileOf(ref) {
    const clean = String(ref || "").split("?")[0];
    if (!clean || !/\.css$/i.test(clean)) return null;
    const inRoot = (f) => { const r = path.relative(root, f); return r && !r.startsWith("..") && !path.isAbsolute(r) && fs.existsSync(f) ? f : null; };
    if (path.isAbsolute(clean) && inRoot(path.normalize(clean))) return path.normalize(clean);
    const rel = decodeURIComponent(clean.replace(/^https?:\/\/[^/]+/, "")).replace(/^\/+/, "");
    return inRoot(path.join(root, rel)) || inRoot(path.join(root, "public", rel));
  }
  // Inline <style> sheets (CSS imported with ?inline and injected at runtime) carry no file id.
  // Each rule they hold is matched to the project .css file whose scanned keys contain it.
  function listCssFiles() {
    const out = [];
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.name === "node_modules" || ent.name.startsWith(".") || ent.name === "dist" || ent.name === "build") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.css$/i.test(ent.name)) out.push(full);
      }
    };
    walk(root);
    return out;
  }
  const cssKeysCache = new Map(); // file -> { mtime, keys: Set }
  function cssFileKeys(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const hit = cssKeysCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.keys;
    let keys;
    try { keys = new Set(ruleKeys(scanCss(fs.readFileSync(file, "utf8")))); } catch { keys = new Set(); }
    cssKeysCache.set(file, { mtime: st.mtimeMs, keys });
    return keys;
  }
  /**
   * Maps each requested rule key to the project .css file that holds it. One injected <style> may
   * concatenate several files (base.css + sidebar.css + …), so a key is resolved to its own file,
   * not the whole sheet to one file. A key in several files goes to the one that shares the most of
   * the sheet's other keys (rules of an element cluster in related files). Returns null when the
   * sheet is mostly foreign (so an unrelated stylesheet doesn't latch onto a file by a chance rule).
   */
  function resolveKeysToFiles(wanted, candidates) {
    if (!wanted || !wanted.length) return null;
    const overlap = new Map(); // file -> how many of the sheet's keys it holds
    const found = new Set();
    for (const c of candidates) {
      let h = 0;
      for (const k of wanted) if (c.keys.has(k)) { h++; found.add(k); }
      overlap.set(c.file, h);
    }
    if (!found.size || found.size * 2 < wanted.length) return null;
    const map = new Map();
    for (const k of wanted) {
      let best = null, bestScore = -1;
      for (const c of candidates) {
        if (!c.keys.has(k)) continue;
        const score = overlap.get(c.file);
        if (score > bestScore || (score === bestScore && best && c.file < best)) { best = c.file; bestScore = score; }
      }
      if (best) map.set(k, best);
    }
    return map;
  }

  /** The rules the editor asks for (by key), with their declarations' code sites. */
  function cssRules(b) {
    const out = [];
    let candidates = null; // [{ file, keys }], scanned once per call if an inline sheet needs matching
    const regCache = new Map(); // file -> { reg, code }, so each file is read and scanned once
    const regOf = (file) => {
      if (!regCache.has(file)) { const code = fs.readFileSync(file, "utf8"); regCache.set(file, { reg: registerCss(file, code), code }); }
      return regCache.get(file);
    };
    for (const sheet of b.sheets || []) {
      const keys = sheet.keys || [];
      const direct = cssFileOf(sheet.file);
      let keyFile = null; // Map(key -> file) when the sheet is an injected one spanning project files
      if (!direct) {
        if (!candidates) candidates = listCssFiles().map((file) => ({ file, keys: cssFileKeys(file) || new Set() }));
        keyFile = resolveKeysToFiles(keys, candidates);
      }
      const rules = {};
      for (const key of keys) {
        const file = direct || (keyFile && keyFile.get(key));
        if (!file) continue;
        const { reg, code } = regOf(file);
        const d = reg.decls.find((x) => x.key === key);
        if (!d) continue;
        const own = reg.sites.filter((x) => x.declId === d.id);
        rules[key] = {
          declId: d.id, name: d.name, file: path.relative(root, file), line: lineOf(code, d.start), props: d.props,
          sites: Object.fromEntries(own.map((x) => [x.kind, x.id])),
          values: Object.fromEntries(own.map((x) => [x.kind, x.args[0].text])),
        };
      }
      out.push({ file: sheet.file, rules });
    }
    return out;
  }

  function lineOf(code, pos) {
    let line = 1;
    for (let i = 0; i < pos && i < code.length; i++) if (code.charCodeAt(i) === 10) line++;
    return line;
  }

  function info(id) {
    const rec = sites.get(id) || decls.get(id);
    if (!rec) return null;
    let code = "";
    try { code = fs.readFileSync(rec.file, "utf8"); } catch { /* ignore */ }
    const pos = rec.args ? rec.args[0].start : rec.start;
    const line = lineOf(code, pos);
    const lineText = code.split("\n")[line - 1] || "";
    const col = pos - (code.lastIndexOf("\n", pos - 1) + 1) + 1;
    return {
      id, kind: rec.kind || "decl", name: rec.name,
      file: path.relative(root, rec.file), line, col,
      code: lineText.trim(),
      arg: rec.args && rec.args[0] && rec.args[0].text.length <= 200 ? rec.args[0].text : null, // the value as written
      canInsert: rec.insertAt != null,
      // A spine chosen by an expression (SPINES[key].SKEL) can't be rewritten by the editor.
      ...(rec.kind === "spine" ? { fixed: rec.args.some((a) => assetText(a.text, ["__probe__"], '"') == null) } : {}),
    };
  }

  // Where the components live in the project: src/pixi-components/{core.ts, layout/, ui/, …}
  const srcDir = () => (fs.existsSync(path.join(root, "src")) ? path.join(root, "src") : root);
  const componentsDir = () => path.join(srcDir(), "pixi-components");
  const legacyFile = () => path.join(srcDir(), "pixi-components.ts"); // the old single file
  /** Import path from `file` to a module of the components folder ("core", "ui", …). */
  const componentSpec = (file, sub) => {
    let rel = path.relative(path.dirname(file), path.join(componentsDir(), sub)).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  };
  const inComponents = (file) => file.startsWith(componentsDir() + path.sep);

  // ---------------------------------------------------------------- behaviors (per-object scripts)
  const behaviorsDir = () => path.join(srcDir(), "behaviors");
  const toUrl = (file) => "/" + path.relative(root, file).split(path.sep).join("/");
  function listBehaviors() {
    const dir = behaviorsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /^[A-Z][A-Za-z0-9_]*\.ts$/.test(f))
      .map((f) => ({ name: f.slice(0, -3), file: path.join(dir, f), url: toUrl(path.join(dir, f)), rel: path.relative(root, path.join(dir, f)) }));
  }
  const behaviorSpec = (fromFile, behaviorFile) => {
    let rel = path.relative(path.dirname(fromFile), behaviorFile.replace(/\.ts$/, "")).split(path.sep).join("/");
    return rel.startsWith(".") ? rel : `./${rel}`;
  };

  /** Formats a file the editor creates with the project's Prettier (it's ours, so always). */
  async function formatNew(file, code) {
    const prettier = await loadPrettier();
    if (!prettier) return code;
    try {
      const config = (await prettier.resolveConfig(file)) || {};
      return await prettier.format(code, { ...config, filepath: file });
    } catch {
      return code;
    }
  }

  /** Template files (relative paths) for core and the given categories. */
  function componentTemplateFiles(categories) {
    const out = ["core.ts"];
    for (const cat of categories) {
      const dir = path.join(COMPONENTS_TEMPLATE, cat);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).sort()) out.push(`${cat}/${f}`);
    }
    return out;
  }
  /** Files the project would get for these categories (relative to the project), without writing. */
  const missingComponentFiles = (categories) =>
    componentTemplateFiles(categories).filter((rel) => !fs.existsSync(path.join(componentsDir(), rel))).map((rel) => path.relative(root, path.join(componentsDir(), rel)));
  /**
   * Copies core.ts and the given category folders into src/pixi-components/ (only missing files: the
   * team may have edited theirs). Returns the files created (relative to the project).
   */
  async function ensureComponentFiles(categories = []) {
    const created = [];
    for (const rel of componentTemplateFiles(categories)) {
      const dest = path.join(componentsDir(), rel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const code = await formatNew(dest, fs.readFileSync(path.join(COMPONENTS_TEMPLATE, rel), "utf8"));
      selfWrites.set(path.normalize(dest), code); // the game already uses the preview copy: no reload
      fs.writeFileSync(dest, code);
      created.push(path.relative(root, dest));
    }
    return created;
  }

  // ---------------------------------------------------------------- migrating the old single file
  /** Which module of the components folder exports each name ("Anchor" -> "layout", "addComponent" -> "core"). */
  function componentExportMap() {
    const map = new Map();
    for (const rel of componentTemplateFiles(CATALOG.categories.map((c) => c.id))) {
      if (rel.endsWith("index.ts")) continue;
      const sub = rel === "core.ts" ? "core" : rel.split("/")[0];
      const code = fs.readFileSync(path.join(COMPONENTS_TEMPLATE, rel), "utf8");
      for (const m of code.matchAll(/^export\s+(?:abstract\s+)?(?:class|function|const|let|interface|type)\s+([A-Za-z_$][\w$]*)/gm)) map.set(m[1], sub);
    }
    return map;
  }
  const normalizeCode = (t) => t.replace(/\s+/g, "").replace(/'/g, '"').replace(/,([)\]}])/g, "$1").replace(/;/g, "");

  /**
   * Moves a project from src/pixi-components.ts to src/pixi-components/: rewrites every import of the
   * old file (one import per module: core, layout, ui…), adds the folders it needs and removes the old
   * file (or keeps it as pixi-components.ts.legacy when the team changed it).
   */
  async function migrateComponents({ dryRun = false } = {}) {
    const legacy = legacyFile();
    if (!fs.existsSync(legacy)) return { ok: false, error: "This project has no src/pixi-components.ts to migrate." };
    const exportsOf = componentExportMap();
    const legacyNoExt = legacy.replace(/\.ts$/, "");
    const changes = []; // { file, original, code }
    const categories = new Set();
    const problems = [];
    const walkDir = async (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name.startsWith(".") || ent.name === "dist") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (full !== componentsDir()) await walkDir(full); continue; }
        if (!/\.(m?[jt]sx?)$/.test(ent.name) || full === legacy) continue;
        const original = fs.readFileSync(full, "utf8");
        if (!original.includes("pixi-components")) continue;
        let ast;
        try { ast = parse(original, { sourceType: "module", plugins: ["typescript", "decorators-legacy", "jsx"] }); } catch { continue; }
        const edits = [];
        for (const decl of ast.program.body) {
          if (decl.type !== "ImportDeclaration" || !decl.source.value.startsWith(".")) continue;
          const target = path.resolve(path.dirname(full), decl.source.value).replace(/\.(ts|js)$/, "");
          if (target !== legacyNoExt) continue;
          const groups = new Map();
          for (const sp of decl.specifiers) {
            if (sp.type !== "ImportSpecifier") { problems.push(`${path.relative(root, full)}: "${original.slice(decl.start, decl.end)}" can't be split automatically.`); continue; }
            const name = sp.imported.name || sp.imported.value;
            const sub = exportsOf.get(name);
            if (!sub) { problems.push(`${path.relative(root, full)}: "${name}" doesn't exist in the new components (it was only used by the editor).`); continue; }
            if (sub !== "core") categories.add(sub);
            const local = sp.local.name !== name ? `${name} as ${sp.local.name}` : name;
            if (!groups.has(sub)) groups.set(sub, []);
            groups.get(sub).push(sp.importKind === "type" && decl.importKind !== "type" ? `type ${local}` : local);
          }
          const q = original[decl.source.start];
          const order = ["core", ...CATALOG.categories.map((c) => c.id)];
          const lineStart = original.lastIndexOf("\n", decl.start - 1) + 1;
          const indent = /^[ \t]*/.exec(original.slice(lineStart))[0];
          const text = [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
            .map(([sub, names]) => `import ${decl.importKind === "type" ? "type " : ""}{ ${names.join(", ")} } from ${q}${componentSpec(full, sub)}${q};`)
            .join(`\n${indent}`);
          edits.push({ start: decl.start, end: decl.end, text });
        }
        if (!edits.length) continue;
        const code = applyText(original, edits);
        changes.push({ file: full, original, code: (await formatLikeProject(full, original, code)) || code });
      }
    };
    await walkDir(srcDir());
    if (problems.length) return { ok: false, error: `Can't migrate automatically:\n${problems.join("\n")}` };
    const legacyChanged = normalizeCode(fs.readFileSync(legacy, "utf8")) !== normalizeCode(fs.readFileSync(LEGACY_TEMPLATE, "utf8"));
    const rel = (f) => path.relative(root, f);
    const summary = {
      ok: true,
      diffs: changes.map((c) => ({ file: rel(c.file), hunks: lineDiff(c.original, c.code) })),
      newFiles: missingComponentFiles(categories),
      legacy: rel(legacy),
      legacyChanged,
      keptAs: legacyChanged ? `${rel(legacy)}.legacy` : null,
    };
    if (dryRun) return summary;
    await ensureComponentFiles(categories);
    for (const c of changes) fs.writeFileSync(c.file, c.code);
    if (legacyChanged) fs.renameSync(legacy, `${legacy}.legacy`);
    else fs.unlinkSync(legacy);
    return summary;
  }

  /** Creates src/behaviors/<Name>.ts from the template. */
  async function createBehavior(name, objectName) {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name || "")) throw new Error("Behavior names must start with a capital letter and use only letters, digits and _ (e.g. SpinningCoin).");
    if (BUILTIN_COMPONENTS.has(name)) throw new Error(`"${name}" is a built-in component name.`);
    const file = path.join(behaviorsDir(), `${name}.ts`);
    const created = !fs.existsSync(file);
    if (created) {
      fs.mkdirSync(behaviorsDir(), { recursive: true });
      let code = fs.readFileSync(BEHAVIOR_TEMPLATE, "utf8")
        .replaceAll("__COMPONENTS__", componentSpec(file, "core"))
        .replaceAll("__NAME__", name)
        .replaceAll("__OBJECT__", String(objectName || name).replace(/["\n]/g, ""));
      code = await formatNew(file, code);
      fs.writeFileSync(file, code);
    }
    const createdModule = (await ensureComponentFiles([])).length > 0;
    return { name, url: toUrl(file), file: path.relative(root, file), abs: file, created, createdModule };
  }

  /** Opens a file at a line in VS Code (or the editor set in PIXI_EDITOR_IDE: "code", "cursor"…). */
  function openInIde(file, line = 1, col = 1) {
    const abs = path.resolve(root, file);
    if (!abs.startsWith(root) || !fs.existsSync(abs)) return Promise.resolve({ ok: false, error: "File not found in the project." });
    const ide = process.env.PIXI_EDITOR_IDE || "code";
    const scheme = ide === "code" ? "vscode" : ide;
    const url = `${scheme}://file${abs.startsWith("/") ? "" : "/"}${abs.split(path.sep).join("/")}:${line}:${col}`;
    return new Promise((resolve) => {
      execFile(ide, ["-g", `${abs}:${line}:${col}`], (err) => {
        if (!err) return resolve({ ok: true });
        // No CLI on the PATH (common on macOS): use the app's URL handler instead.
        const opener = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
        execFile(opener[0], opener[1], (err2) =>
          resolve(err2
            ? { ok: false, error: `Could not open VS Code (is it installed? set PIXI_EDITOR_IDE=cursor for Cursor). File: ${path.relative(root, abs)}:${line}` }
            : { ok: true }));
      });
    });
  }

  // ---------------------------------------------------------------- creating objects
  const OBJECT_KINDS = {
    container: { cls: "Container", name: "group" },
    sprite: { cls: "Sprite", name: "sprite" },
    text: { cls: "Text", name: "label" },
    rect: { cls: "Graphics", name: "box" },
    circle: { cls: "Graphics", name: "circle" },
    // HTML inside the scene: Pixi's DOMContainer moves its element with the game.
    htmlPanel: { cls: "DOMContainer", name: "panel" },
    htmlButton: { cls: "DOMContainer", name: "button" },
    htmlInput: { cls: "DOMContainer", name: "input" },
    htmlText: { cls: "DOMContainer", name: "note" },
  };
  // What each HTML kind starts with: [tag, element properties, inline style] (shared with the editor).
  const HTML_KINDS = JSON.parse(fs.readFileSync(path.resolve(HERE, "../templates/html-kinds.json"), "utf8"));
  const camelName = (text, fallback) => {
    const words = String(text || "").split(/[^A-Za-z0-9]+/).filter(Boolean);
    let n = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join("");
    if (!n || /^[0-9]/.test(n)) n = fallback + n;
    return n;
  };
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /**
   * Where a new child of `parent` goes: after the last statement in the parent's block that uses the
   * parent (so it's drawn on top of the existing children), but before a `return`.
   */
  function insertionPoint(code, parent) {
    let ast;
    try { ast = parse(code, { sourceType: "module", plugins: ["typescript", "decorators-legacy", "jsx"], errorRecovery: true }); }
    catch { return parent.insertAt; }
    let list = null, index = -1;
    const visit = (n) => {
      if (list || !n || typeof n.type !== "string") return;
      for (const key of ["body", "consequent"]) {
        const arr = n[key];
        if (Array.isArray(arr)) {
          const i = arr.findIndex((st) => st && st.end === parent.insertAt);
          if (i >= 0) { list = arr; index = i; return; }
        }
      }
      for (const k in n) {
        if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v.type === "string") visit(v);
      }
    };
    visit(ast.program);
    if (!list) return parent.insertAt;
    const uses = new RegExp(`(^|[^\\w$.])${escapeRe(parent.access)}\\b`);
    // Uses inside functions (event handlers, update functions…) run later: they don't count.
    const FN = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassDeclaration|ClassMethod|ObjectMethod)$/;
    const directText = (st) => {
      if (FN.test(st.type)) return "";
      let text = code.slice(st.start, st.end);
      const blank = (n) => {
        if (!n || typeof n.type !== "string") return;
        if (FN.test(n.type)) {
          const a = n.start - st.start, z = n.end - st.start;
          text = text.slice(0, a) + " ".repeat(z - a) + text.slice(z);
          return;
        }
        for (const k in n) {
          if (k === "loc" || k === "leadingComments" || k === "trailingComments" || k === "innerComments") continue;
          const v = n[k];
          if (Array.isArray(v)) v.forEach(blank);
          else if (v && typeof v.type === "string") blank(v);
        }
      };
      blank(st);
      return text;
    };
    let end = parent.insertAt;
    for (let i = index + 1; i < list.length; i++) {
      const st = list[i];
      if (st.type === "ReturnStatement") break;
      if (uses.test(directText(st))) end = st.end;
    }
    return end;
  }

  /** Writes the code for a new object inside `parent` and registers its code sites. */
  async function createObject(b) {
    const kind = OBJECT_KINDS[b.kind];
    if (!kind) throw new Error(`Unknown object type: ${b.kind}`);
    const parent = decls.get(b.parentDeclId);
    if (!parent || parent.insertAt == null || !parent.access) {
      throw new Error("Select a container that is stored in a variable in the code (for example a HUD group).");
    }
    const file = parent.file;
    const original = fs.readFileSync(file, "utf8");
    const quote = detectQuote(original);
    const q = (t) => quoteString(t, quote);
    let v = camelName(b.name, kind.name);
    for (let i = 2; new RegExp(`\\b${v}\\b`).test(original); i++) v = camelName(b.name, kind.name) + i;
    const x = fmt(Number(b.x) || 0, 0), y = fmt(Number(b.y) || 0, 0);
    const lines = {
      container: [`const ${v} = new Container();`],
      sprite: [`const ${v} = Sprite.from(${q(b.texture || "")});`, `${v}.anchor.set(0.5);`],
      text: [`const ${v} = new Text({ text: ${q(b.text || "New text")}, style: { fill: 0xffffff, fontSize: 32 } });`, `${v}.anchor.set(0.5);`],
      rect: [`const ${v} = new Graphics().rect(-50, -50, 100, 100).fill(0xffffff);`],
      circle: [`const ${v} = new Graphics().circle(0, 0, 50).fill(0xffffff);`],
    }[b.kind] || htmlLines(v, HTML_KINDS[b.kind], q);
    lines.push(`${v}.position.set(${x}, ${y});`, `${parent.access}.addChild(${v});`);
    const at = insertionPoint(original, parent);
    const scratch = { applied: [], inserted: [], saved: 0 };
    let code = applyEdits(file, original, [{ start: at, end: at, text: lines.map((l) => `\n${parent.indent}${l}`).join("") }], scratch);
    const imp = planImport(code, "pixi.js", [kind.cls], { addOnly: true });
    if (imp) code = applyEdits(file, code, [imp], scratch);

    // Register the new object's declaration and code sites (so it can be edited right away).
    const out = instrumentCode(code, file, nextId);
    const decl = out && out.decls.find((d) => d.access === v);
    if (!decl) throw new Error("Could not create the object's code.");
    const ids = byFile.get(file) || new Set();
    byFile.set(file, ids);
    decl.file = file;
    decls.set(decl.id, decl);
    ids.add(decl.id);
    const optIds = new Set(Object.values(decl.opts || {}));
    const newSites = out.sites.filter((st) => st.obj === v || st.obj === `${v}.element` || optIds.has(st.id));
    for (const st of newSites) { st.file = file; sites.set(st.id, st); ids.add(st.id); }

    const formatted = await formatLikeProject(file, original, code);
    if (formatted && formatted !== code && remapAfterFormat(file, formatted)) code = formatted;
    selfWrites.set(path.normalize(file), code);
    fs.writeFileSync(file, code);
    return {
      ok: true,
      file: path.relative(root, file),
      line: lineOf(code, decl.start),
      declId: decl.id,
      name: v,
      opts: decl.opts || {},
      sites: newSites.filter((st) => !optIds.has(st.id) && st.obj === v).map((st) => ({ kind: st.kind, id: st.id })),
      html: HTML_KINDS[b.kind] || null, // what the editor builds live
      // Sites of the DOMContainer's element: `panel.element.style.padding = …`
      elementSites: newSites.filter((st) => st.obj === `${v}.element`).map((st) => ({ kind: st.kind, id: st.id })),
    };
  }

  /** Code for a new DOMContainer: its element, then one line per property and style. */
  function htmlLines(v, spec, q) {
    const lines = [`const ${v} = new DOMContainer({ element: document.createElement(${q(spec.tag)}), anchor: 0.5 });`];
    for (const [k, val] of Object.entries(spec.props || {})) lines.push(`${v}.element.${k} = ${typeof val === "string" ? q(val) : String(val)};`);
    for (const [k, val] of Object.entries(spec.style || {})) lines.push(`${v}.element.style.${k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())} = ${q(val)};`);
    return lines;
  }

  // ---------------------------------------------------------------- deleting and duplicating objects
  /**
   * Deletes or duplicates the code of an object (see refactor.js). With `dryRun`, returns the diff
   * that would be written.
   */
  async function objectAction(b) {
    const verb = b.action === "duplicate" ? "duplicate" : "delete";
    const decl = decls.get(b.declId);
    if (!decl) throw new Error("This object is not linked to its code (reload the game).");
    const file = decl.file;
    const original = fs.readFileSync(file, "utf8");
    const a = analyzeObject(original, decl);
    const rel = path.relative(root, file);
    // Other code that uses the object only blocks deleting it: a copy simply doesn't get those uses.
    const blocked = verb === "delete" ? !a.ok : !a.declStmt && !(a.parts.length === 1 && a.parts[0].kind === "stmt");
    if (blocked) {
      const why = a.blockers.slice(0, 3).map((x) => (x.line ? `line ${x.line}: ${x.text}` : x.text)).join(" · ");
      return { ok: false, error: `Can't ${verb} ${decl.name} automatically — ${why} (${rel}). Change that code first.` };
    }
    let edits, newName = null;
    if (verb === "delete") edits = deleteEdits(original, a);
    else {
      if (decl.access) {
        const base = decl.access.replace(/\d+$/, "");
        newName = `${base}2`;
        for (let i = 3; new RegExp(`\\b${newName}\\b`).test(original); i++) newName = `${base}${i}`;
      }
      const dup = duplicateEdits(original, a, decl.access, newName);
      if (dup.errors.length) return { ok: false, error: `Can't duplicate ${decl.name} automatically — ${dup.errors.join(" ")}` };
      edits = dup.edits;
      if (dup.standalone) newName = null;
    }
    let code = applyText(original, edits);
    let prune = [];
    if (verb === "delete") {
      const removedNames = namesIn(edits.map((e) => original.slice(e.start, e.end)).join("\n"));
      prune = pruneImports(code, removedNames);
      code = applyText(code, prune);
    }
    const formatted = await formatLikeProject(file, original, code);
    if (b.dryRun) return { ok: true, diffs: [{ file: rel, hunks: lineDiff(original, formatted || code) }] };

    // For real: keep the registry of code sites in sync.
    const ids = byFile.get(file) || new Set();
    byFile.set(file, ids);
    const scratch = { applied: [], inserted: [], saved: 0 };
    let copied = null;
    if (verb === "delete") {
      const inside = (pos) => edits.some((e) => pos >= e.start && pos < Math.max(e.end, e.start + 1));
      for (const id of [...ids]) {
        const st = sites.get(id), d = decls.get(id);
        if ((st && inside(st.args[0].start)) || (d && d.start != null && inside(d.start))) { sites.delete(id); decls.delete(id); ids.delete(id); }
      }
      code = applyEdits(file, original, edits.map((e) => ({ ...e })), scratch);
      if (prune.length) code = applyEdits(file, code, prune.map((e) => ({ ...e })), scratch);
    } else {
      const main = edits[0]; // the copied statements, inserted after the original ones
      code = applyEdits(file, original, edits.map((e) => ({ ...e })), scratch);
      const shift = edits.filter((e) => e !== main && e.start < main.start).reduce((n, e) => n + e.text.length - (e.end - e.start), 0);
      copied = { start: main.start + shift, end: main.start + shift + main.text.length };
    }
    let result = { ok: true, file: rel };
    if (copied) {
      // Register the copy's declaration and code sites so it can be edited right away.
      const out = instrumentCode(code, file, nextId);
      const inRange = (pos) => pos >= copied.start && pos < copied.end;
      const nd = out && out.decls.find((d) => inRange(d.start) && (!newName || d.access === newName));
      if (!nd) throw new Error("Could not find the copied code.");
      nd.file = file;
      decls.set(nd.id, nd);
      ids.add(nd.id);
      const optIds = new Set(Object.values(nd.opts || {}));
      const newSites = out.sites.filter((st) => optIds.has(st.id) || (inRange(st.args[0].start) && (!newName || st.obj === newName || st.obj === `${newName}.element`)));
      for (const st of newSites) { st.file = file; sites.set(st.id, st); ids.add(st.id); }
      result = {
        ...result, declId: nd.id, name: newName || decl.name, opts: nd.opts || {}, line: lineOf(code, nd.start),
        sites: newSites.filter((st) => !optIds.has(st.id) && !(newName && st.obj === `${newName}.element`)).map((st) => ({ kind: st.kind, id: st.id })),
        elementSites: newName ? newSites.filter((st) => st.obj === `${newName}.element`).map((st) => ({ kind: st.kind, id: st.id })) : [],
      };
    } else {
      result.lines = edits.length;
    }
    if (formatted && formatted !== code && remapAfterFormat(file, formatted)) code = formatted;
    selfWrites.set(path.normalize(file), code);
    fs.writeFileSync(file, code);
    return result;
  }

  // ---------------------------------------------------------------- draw order
  /**
   * Changes the order in which an object is added to its parent, so it's drawn between `prev` and
   * `next` (parent code sites of its new neighbours). Tries, in order: moving its line before next,
   * after prev, or moving the neighbour's line instead (when nothing else is added in between).
   */
  async function orderObject(b) {
    const site = sites.get(b.siteId);
    if (!site) throw new Error("The line that adds this object to its parent wasn't found (reload the game).");
    const file = site.file;
    const original = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    const kindOf = (st) => (st.form === "children" ? "element" : "stmt");
    const tries = [];
    const next = b.nextSiteId && sites.get(b.nextSiteId);
    const prev = b.prevSiteId && sites.get(b.prevSiteId);
    const same = (o) => o && o.file === file && kindOf(o) === kindOf(site);
    if (same(next)) tries.push([site, next, "before"]);
    if (same(prev)) tries.push([site, prev, "after"]);
    if (same(next)) tries.push([next, site, "after", true]);
    if (same(prev)) tries.push([prev, site, "before", true]);
    if (!tries.length) return { ok: false, error: "Its new neighbours are added in another file or in another way, so the order can't be written." };
    let plan = null, lastError = "";
    for (const [mover, anchor, place, neighbourMoves] of tries) {
      const r = moveEdits(original, mover.args[0].start, anchor.args[0].start, place, kindOf(site));
      if (r.error) { lastError = r.error; continue; }
      // Moving a neighbour is only right if no other object is added between the two lines.
      const [lo, hi] = r.moved.start < r.anchor.start ? [r.moved.end, r.anchor.start] : [r.anchor.end, r.moved.start];
      if (neighbourMoves && /\.addChild(At)?\(|\bchildren\s*:|\bparent\s*:/.test(original.slice(lo, hi))) { lastError = lastError || "other objects are added between them"; continue; }
      plan = r;
      break;
    }
    if (!plan) return { ok: false, error: `Can't change the order in the code: ${lastError || "other objects are added between them"} (${rel}).` };
    let code = applyText(original, plan.edits);
    const formatted = await formatLikeProject(file, original, code);
    if (b.dryRun) return { ok: true, diffs: [{ file: rel, hunks: lineDiff(original, formatted || code) }] };

    // Code sites inside the moved text move with it.
    const ids = byFile.get(file) || new Set();
    byFile.set(file, ids);
    const { moved, removed, insert } = plan;
    const carried = [];
    for (const id of [...ids]) {
      const st = sites.get(id), d = decls.get(id);
      const pos = st ? st.args[0].start : d ? d.start : null;
      if (pos == null || pos < moved.start || pos >= moved.end) continue;
      carried.push(st || d);
      ids.delete(id);
    }
    code = applyEdits(file, original, plan.edits.map((e) => ({ ...e })), { applied: [], inserted: [], saved: 0 });
    // Where the moved text starts in the new code.
    const removedLen = removed.end - removed.start;
    const newStart = (insert.start >= removed.end ? insert.start - removedLen : insert.start) + insert.prefix;
    const delta = newStart - moved.start;
    const move = (r) => { if (r) { r.start += delta; r.end += delta; } };
    for (const rec of carried) {
      if (rec.args) { rec.args.forEach(move); move(rec.stmt); }
      else { rec.start += delta; if (rec.end != null) rec.end += delta; if (rec.insertAt != null) rec.insertAt += delta; }
      ids.add(rec.id);
    }
    if (formatted && formatted !== code && remapAfterFormat(file, formatted)) code = formatted;
    selfWrites.set(path.normalize(file), code);
    fs.writeFileSync(file, code);
    return { ok: true, file: rel };
  }

  /** Moves range `r` to account for an edit that replaced [ed.start, ed.end) with `delta` more chars. */
  function shiftRange(r, ed, delta) {
    const ins = ed.start === ed.end;
    if (ins ? r.start >= ed.start : r.start >= ed.end) { r.start += delta; r.end += delta; }
    else if (!ins && r.start <= ed.start && r.end >= ed.end) r.end += delta;
    else if (ins && r.start < ed.start && r.end > ed.start) r.end += delta;
  }
  function shiftPoint(pos, ed, delta) {
    const ins = ed.start === ed.end;
    return (ins ? pos >= ed.start : pos >= ed.end) ? pos + delta : pos;
  }

  /** Applies edits (descending) to `code`, keeping every registered range of `file` in sync. */
  function applyEdits(file, code, edits, result) {
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    const ids = byFile.get(file) || new Set();
    byFile.set(file, ids);
    for (const ed of edits) {
      code = code.slice(0, ed.start) + ed.text + code.slice(ed.end);
      const delta = ed.text.length - (ed.end - ed.start);
      for (const id of ids) {
        const s = sites.get(id);
        if (s && s !== ed.site) {
          for (const a of s.args) shiftRange(a, ed, delta);
          if (s.stmt) shiftRange(s.stmt, ed, delta);
        } else if (s && s === ed.site && !ed.remove && s.stmt) {
          shiftRange(s.stmt, ed, delta);
        }
        const d = decls.get(id);
        if (d && ed.rangeDecl === d) {
          d.end += delta; // Object.assign( … ) wrapper: same start, longer range
        } else if (d && ed.decl !== d) {
          if (d.insertAt != null) d.insertAt = shiftPoint(d.insertAt, ed, delta);
          if (d.scope) shiftRange(d.scope, ed, delta);
          if (d.start != null) {
            const r = { start: d.start, end: d.end ?? d.start };
            shiftRange(r, ed, delta);
            d.start = r.start;
            d.end = r.end;
          }
        }
      }
      if (ed.site && ed.remove) {
        sites.delete(ed.site.id);
        ids.delete(ed.site.id);
        result.applied.push(ed.site.id);
        result.saved++;
      } else if (ed.site) {
        if (ed.expand) {
          const [A, B] = ed.expand;
          const [oa, ob] = ed.offsets || [0, A.length + 2];
          ed.site.args = [
            { start: ed.start + oa, end: ed.start + oa + A.length, text: A },
            { start: ed.start + ob, end: ed.start + ob + B.length, text: B },
          ];
        } else if (ed.literal != null) {
          const a = ed.site.args[0];
          a.start = ed.start + (ed.text.length - ed.literal.length);
          a.end = ed.start + ed.text.length;
          a.text = ed.literal;
          delete a.prefix;
        } else {
          const a = ed.site.args[ed.argIndex];
          a.end = ed.start + ed.text.length;
          a.text = ed.text;
        }
        if (!result.applied.includes(ed.site.id)) result.applied.push(ed.site.id);
        result.saved++;
      }
      if (ed.insert) {
        for (const ns of ed.insert) {
          const id = nextId("s");
          const site = {
            id, file, kind: ns.kind, form: ns.form, vecStyle: ns.vecStyle,
            args: ns.args.map((a) => ({ start: ed.start + a.relStart, end: ed.start + a.relStart + a.text.length, text: a.text })),
          };
          if (ns.stmt) site.stmt = { start: ed.start + ns.stmt.relStart, end: ed.start + ns.stmt.relStart + ns.stmt.text.length, text: ns.stmt.text };
          sites.set(id, site);
          ids.add(id);
          result.inserted.push({ declId: ns.declId, kind: ns.kind, siteId: id, ...(ns.from ? { from: ns.from } : {}) });
          result.saved++;
        }
      }
      if (ed.decl) ed.decl.insertAt = ed.start + ed.text.length;
    }
    // Refresh the texts (used to detect changes made outside the editor), also for other ids that
    // describe the same place.
    for (const id of ids) {
      const s = sites.get(id);
      if (!s) continue;
      for (const a of s.args) a.text = code.slice(a.start, a.end);
      if (s.stmt) s.stmt.text = code.slice(s.stmt.start, s.stmt.end);
    }
    return code;
  }

  // Keys that a factory helper is known to accept: every key used in any call to it in the project.
  let factoryKeysCache = null;
  function factoryKeys(name) {
    if (!factoryKeysCache || Date.now() - factoryKeysCache.at > 5000) {
      const map = new Map();
      const base = fs.existsSync(path.join(root, "src")) ? path.join(root, "src") : root;
      const walkDir = (dir) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name === "node_modules" || ent.name.startsWith(".") || ent.name === "dist") continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walkDir(full);
          else if (/\.(m?[jt]sx?)$/.test(ent.name)) collect(full);
        }
      };
      const collect = (file) => {
        let ast;
        try {
          ast = parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "decorators-legacy", ...(/x$/.test(file) ? ["jsx"] : [])], errorRecovery: true });
        } catch { return; }
        const visit = (n) => {
          if (!n || typeof n.type !== "string") return;
          if (n.type === "CallExpression" && n.callee.type === "Identifier" && FACTORY_RE.test(n.callee.name) && n.arguments[0]?.type === "ObjectExpression") {
            // key -> shapes seen for its value ("array" for position: [x, y], "object" for { x, y }, …)
            const keys = map.get(n.callee.name) || new Map();
            for (const p of n.arguments[0].properties) {
              if (p.type !== "ObjectProperty" || p.key.type !== "Identifier") continue;
              const shapes = keys.get(p.key.name) || new Set();
              shapes.add(p.value.type === "ArrayExpression" ? "array" : p.value.type === "ObjectExpression" ? "object" : "other");
              keys.set(p.key.name, shapes);
            }
            map.set(n.callee.name, keys);
          }
          for (const k in n) {
            if (k === "loc" || k === "start" || k === "end") continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v.type === "string") visit(v);
          }
        };
        visit(ast.program);
      };
      try { walkDir(base); } catch { /* ignore */ }
      factoryKeysCache = { at: Date.now(), map };
    }
    return factoryKeysCache.map.get(name) || new Map();
  }

  const PIXI_OPTION_KEYS = new Set(["position", "scale", "pivot", "rotation", "angle", "alpha", "label", "tint", "x", "y"]);

  /**
   * Where to save a property of an object that has no variable: inside its options object when the
   * factory/constructor accepts that key, otherwise by wrapping the creation in Object.assign(…, {…}).
   */
  function placeWithoutStatement(decl, e) {
    const key = e.kind;
    if (key.startsWith("style.")) return { error: `"${decl.name}" has no variable, so its text style can only be saved where the style is defined.` };
    const code = fs.readFileSync(decl.file, "utf8");
    const literal = findLiteral(code, decl);
    if (!literal) return { error: `Could not find where "${decl.name}" is created.` };
    // Object.assign and Pixi constructors take points as { x, y }; factories as the project already uses them.
    if (literal.kind === "assign") return { mode: "literal", literal, vecStyle: "object" };
    if (literal.kind === "options") {
      if (decl.factory) {
        const keys = factoryKeys(decl.factory);
        if (keys.has(key)) {
          const usesArray = [...keys.values()].some((shapes) => shapes.has("array"));
          return { mode: "literal", literal, vecStyle: usesArray ? "array" : "object" };
        }
      } else if (PIXI_OPTION_KEYS.has(key) || (key === "anchor" && /Sprite|Text/.test(e.type || "")) || (key === "text" && /Text/.test(e.type || ""))) {
        return { mode: "literal", literal, vecStyle: "object" };
      }
    }
    return { mode: "wrap", vecStyle: "object" };
  }

  // The project's own Prettier, used to keep already-formatted files formatted after a save.
  let prettierPromise = null;
  function loadPrettier() {
    if (!prettierPromise) {
      prettierPromise = (async () => {
        try {
          const req = createRequire(path.join(root, "package.json"));
          const mod = await import(pathToFileURL(req.resolve("prettier")).href);
          return mod.default && mod.default.format ? mod.default : mod;
        } catch {
          return null;
        }
      })();
    }
    return prettierPromise;
  }

  /**
   * Formats `code` with the project's Prettier, but only if the file was Prettier-clean before the
   * edit (we never reformat code the team didn't format). Returns null to keep `code` as it is.
   */
  async function formatLikeProject(file, original, code) {
    const prettier = await loadPrettier();
    if (!prettier) return null;
    try {
      const config = (await prettier.resolveConfig(file)) || {};
      const opts = { ...config, filepath: file };
      if (!(await prettier.check(original, opts))) return null;
      return await prettier.format(code, opts);
    } catch {
      return null;
    }
  }

  /** After formatting, re-locate every registered site/declaration of `file` (same order, new offsets). */
  function remapAfterFormat(file, formatted) {
    let n = 0;
    const out = instrumentCode(formatted, file, (p) => `tmp${p}${++n}`);
    if (!out) return false;
    const ids = [...(byFile.get(file) || [])];
    // Several ids can describe the same place (kept across re-transforms): group them.
    const group = (list, key, pos) => {
      const map = new Map();
      for (const x of list) { const k = key(x); if (!map.has(k)) map.set(k, []); map.get(k).push(x); }
      return [...map.values()].sort((a, b) => pos(a[0]) - pos(b[0]));
    };
    const siteKey = (s) => `${s.kind}|${s.args.map((r) => `${r.start}-${r.end}`).join(",")}|${s.obj || ""}`;
    const declKey = (d) => `${d.start}-${d.end}|${d.access || ""}`;
    const oldSites = group(ids.map((id) => sites.get(id)).filter(Boolean), siteKey, (s) => s.args[0].start);
    const oldDecls = group(ids.map((id) => decls.get(id)).filter(Boolean), declKey, (d) => d.start);
    const newSites = group(out.sites, siteKey, (s) => s.args[0].start).map((g) => g[0]);
    const newDecls = group(out.decls, declKey, (d) => d.start).map((g) => g[0]);
    if (oldSites.length !== newSites.length || oldDecls.length !== newDecls.length) return false;
    if (oldSites.some((g, i) => g[0].kind !== newSites[i].kind || g[0].args.length !== newSites[i].args.length)) return false;
    oldSites.forEach((g, i) => {
      for (const s of g) {
        s.args = newSites[i].args.map((r) => ({ ...r }));
        s.stmt = newSites[i].stmt && { ...newSites[i].stmt };
      }
    });
    oldDecls.forEach((g, i) => {
      const nd = newDecls[i];
      for (const d of g) Object.assign(d, { start: nd.start, end: nd.end, insertAt: nd.insertAt, indent: nd.indent, scope: nd.scope && { ...nd.scope } });
    });
    return true;
  }


  // ---------------------------------------------------------------- assets and parents
  // String constants of the project, e.g. TEX.HUD.LOGO = "maingame_logo", so a texture change is
  // saved as `TEX.HUD.COIN` instead of a raw string when the code already uses those constants.
  let constantsCache = null;
  function assetConstants() {
    if (constantsCache && Date.now() - constantsCache.at < 5000) return constantsCache.map;
    const map = new Map(); // root name -> [{ path: ["TEX", "HUD", "LOGO"], value }]
    const base = fs.existsSync(path.join(root, "src")) ? path.join(root, "src") : root;
    const flatten = (obj, pathParts, out) => {
      for (const p of obj.properties) {
        if (p.type !== "ObjectProperty" || p.computed) continue;
        const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null;
        if (key == null) continue;
        let v = p.value;
        while (v && (v.type === "TSAsExpression" || v.type === "TSSatisfiesExpression")) v = v.expression;
        if (v.type === "StringLiteral") out.push({ path: [...pathParts, key], value: v.value });
        else if (v.type === "TemplateLiteral" && !v.expressions.length) out.push({ path: [...pathParts, key], value: v.quasis[0].value.cooked });
        else if (v.type === "ObjectExpression") flatten(v, [...pathParts, key], out);
      }
    };
    const walkDir = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name.startsWith(".") || ent.name === "dist") continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walkDir(full); continue; }
        if (!/\.(m?[jt]sx?)$/.test(ent.name)) continue;
        const code = fs.readFileSync(full, "utf8");
        if (!/const\s+\w+\s*(:[^=]+)?=\s*\{/.test(code)) continue;
        let ast;
        try { ast = parse(code, { sourceType: "module", plugins: ["typescript", "decorators-legacy", ...(/x$/.test(full) ? ["jsx"] : [])], errorRecovery: true }); } catch { continue; }
        for (let st of ast.program.body) {
          if (st.type === "ExportNamedDeclaration" && st.declaration) st = st.declaration;
          if (st.type !== "VariableDeclaration") continue;
          for (const d of st.declarations) {
            let init = d.init;
            while (init && (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression")) init = init.expression;
            if (d.id.type !== "Identifier" || !init || init.type !== "ObjectExpression") continue;
            const out = [];
            flatten(init, [d.id.name], out);
            if (out.length) map.set(d.id.name, [...(map.get(d.id.name) || []), ...out]);
          }
        }
      }
    };
    try { walkDir(base); } catch { /* ignore */ }
    constantsCache = { at: Date.now(), map };
    return map;
  }

  const memberPath = (n) => {
    const parts = [];
    while (n && n.type === "MemberExpression") {
      if (n.computed) {
        if (n.property.type !== "StringLiteral") return null;
        parts.unshift(n.property.value);
      } else parts.unshift(n.property.name);
      n = n.object;
    }
    if (!n || n.type !== "Identifier") return null;
    parts.unshift(n.name);
    return parts;
  };
  const pathText = (parts) => parts[0] + parts.slice(1).map((p) => (/^[A-Za-z_$][\w$]*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join("");

  /** The key (of the asset's cache aliases) that looks most like `old` ("coin.png" vs "coin" vs "/assets/coin.png"). */
  function pickKey(keys, old) {
    if (old != null && keys.includes(old)) return old;
    const shape = (k) => `${k.includes("/")}:${/\.[a-z0-9]+$/i.test(k)}`;
    return (old != null && keys.find((k) => shape(k) === shape(old))) || keys[0];
  }

  /**
   * New source text for an asset reference (texture or spine file), keeping its style:
   *   "coin.png" -> "gem.png"   Texture.from("coin") -> Texture.from("gem")   TEX.COIN -> TEX.GEM
   * Returns null when the reference is an expression the editor can't rewrite.
   */
  function assetText(oldText, keys, quote) {
    let node;
    try { node = parseExpression(oldText, { plugins: ["typescript"] }); } catch { return null; }
    while (node && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
    if (!node) return null;
    const lit = (n) => n && (n.type === "StringLiteral" ? n.value : n.type === "TemplateLiteral" && !n.expressions.length ? n.quasis[0].value.cooked : null);
    if (lit(node) != null) return quoteString(pickKey(keys, lit(node)), node.type === "TemplateLiteral" ? "`" : oldText[node.start]);
    if (node.type === "CallExpression" && lit(node.arguments[0]) != null) {
      const a = node.arguments[0];
      return oldText.slice(0, a.start) + quoteString(pickKey(keys, lit(a)), a.type === "TemplateLiteral" ? "`" : oldText[a.start]) + oldText.slice(a.end);
    }
    const parts = memberPath(node);
    if (parts) {
      const entries = assetConstants().get(parts[0]) || [];
      const matches = entries.filter((e) => keys.includes(e.value));
      if (matches.length) {
        // Prefer the constant closest to the old one (same group: TEX.HUD.*).
        const common = (p) => { let i = 0; while (i < p.length && p[i] === parts[i]) i++; return i; };
        matches.sort((a, b) => common(b.path) - common(a.path) || a.path.length - b.path.length);
        return pathText(matches[0].path);
      }
      const old = entries.find((e) => e.path.join("\0") === parts.join("\0"));
      if (old) return quoteString(pickKey(keys, old.value), quote); // a string constant: a string works too
    }
    return null;
  }

  /** True if the variable of `decl` can be used at `pos` in `file`. */
  function reachable(decl, file, pos) {
    if (!decl || !decl.access || decl.file !== file || !decl.scope) return false;
    if (pos < decl.scope.start || pos > decl.scope.end) return false;
    return decl.access.startsWith("this.") || pos > decl.start;
  }

  /** The statement (directly inside a block) that contains `pos`. */
  function statementAt(code, pos) {
    let ast;
    try { ast = parse(code, { sourceType: "module", plugins: ["typescript", "decorators-legacy", "jsx"], errorRecovery: true }); } catch { return null; }
    let found = null;
    const visit = (n) => {
      if (!n || typeof n.type !== "string" || pos < n.start || pos > n.end) return;
      for (const key of ["body", "consequent"]) {
        const arr = n[key];
        if (Array.isArray(arr)) for (const st of arr) if (st && st.start <= pos && pos < st.end) found = st;
      }
      for (const k in n) {
        if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
        const v = n[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v.type === "string") visit(v);
      }
    };
    visit(ast.program);
    return found ? { ast, stmt: found } : null;
  }

  /** Edits for a texture, spine or parent change (see planEdits → ctx.resolve). */
  function resolveValue(site, value, type, code, ctx) {
    const short = (t) => (t.length > 40 ? t.slice(0, 39) + "…" : t);
    if (type === "texture") {
      const keys = (value && value.keys) || [];
      if (!keys.length) return { error: "That texture has no name in the asset cache, so it can't be written in the code." };
      const a = site.args[0];
      let text = assetText(a.text, keys, ctx.quote);
      if (text == null) {
        text = `Texture.from(${quoteString(keys[0], ctx.quote)})`;
        ctx.pixiNames.add("Texture");
      }
      return { edits: [{ start: a.start, end: a.end, text, argIndex: 0 }] };
    }
    if (type === "spine") {
      const edits = [];
      for (const [i, keys] of [value.skeleton || [], value.atlas || []].entries()) {
        const a = site.args[i];
        if (!a || !keys.length) return { error: "Spine change: missing skeleton or atlas." };
        const text = assetText(a.text, keys, ctx.quote);
        if (text == null) return { error: `The spine is chosen by code (${short(a.text)}), so it can't be changed here.` };
        if (text !== a.text) edits.push({ start: a.start, end: a.end, text, argIndex: i });
      }
      return { edits };
    }
    if (type === "parent") {
      let target = decls.get(value);
      if (typeof value === "string" && value.startsWith("stage:")) {
        const app = decls.get(value.slice(6));
        target = app && app.access ? { ...app, access: `${app.access}.stage` } : null;
      }
      if (!target || !target.access) return { error: "The new parent is not stored in a variable in the code, so the move can't be saved." };
      const a = site.args[0];
      if (site.form === "children") {
        // createContainer({ children: [a, b] }): take it out of the list, add it to the new parent after that statement.
        const found = statementAt(code, a.start);
        if (!found) return { error: "Could not find where this object is added." };
        const { stmt } = found;
        if (!reachable(target, site.file, stmt.end)) return { error: `${target.access} can't be used where ${short(a.text)} is added (${path.relative(root, site.file)}) — move it in the code.` };
        let arr = null;
        const visit = (n) => {
          if (arr || !n || typeof n.type !== "string") return;
          if (n.type === "ArrayExpression" && n.elements.some((e) => e && e.start === a.start && e.end === a.end)) { arr = n; return; }
          for (const k in n) {
            if (k === "loc" || k === "leadingComments" || k === "trailingComments") continue;
            const v = n[k];
            if (Array.isArray(v)) v.forEach(visit);
            else if (v && typeof v.type === "string") visit(v);
          }
        };
        visit(stmt);
        if (!arr) return { error: "Could not find the children list of this object." };
        const els = arr.elements;
        const i = els.findIndex((e) => e && e.start === a.start);
        let start = a.start, end = a.end;
        if (i < els.length - 1) end = els[i + 1].start; // "a, " before the next one
        else if (i > 0) start = els[i - 1].end; // ", a" at the end
        const lineStart = code.lastIndexOf("\n", stmt.start - 1) + 1;
        const indent = /^[ \t]*/.exec(code.slice(lineStart))[0];
        const head = `\n${indent}`;
        const line = `${target.access}.addChild(${a.text});`;
        return {
          edits: [
            { start, end, text: "", remove: true },
            { start: stmt.end, end: stmt.end, text: head + line, site: null, insert: [{ kind: "parent", form: "call", from: site.id, declId: null, args: [{ relStart: head.length, text: target.access }] }] },
          ],
        };
      }
      if (!reachable(target, site.file, a.start)) {
        const line = code.slice(0, a.start).split("\n").length;
        return { error: `${target.access} can't be used at ${path.relative(root, site.file)}:${line}, where this object is added (${short(a.text)}). Move it in the code.` };
      }
      return { edits: [{ start: a.start, end: a.end, text: target.access, argIndex: 0 }] };
    }
    return { error: `Unknown value type ${type}` };
  }

  /** Applies edits to a string only (dry run: the registry of code sites is left untouched). */
  const applyText = (code, edits) =>
    [...edits].sort((a, b) => b.start - a.start || b.end - a.end).reduce((c, ed) => c.slice(0, ed.start) + ed.text + c.slice(ed.end), code);

  /**
   * Writes the editor's changes into the source files. With `dryRun`, nothing is written: returns
   * `diffs` (per file, line hunks) so the editor can show what a save would change.
   */
  async function save(body, { dryRun = false } = {}) {
    const result = { ok: true, saved: 0, applied: [], inserted: [], errors: [], files: [], failed: [], diffs: [] };
    const apply = dryRun ? (file, code, edits) => applyText(code, edits) : applyEdits;
    const perFile = new Map();
    const bucket = (file) => {
      if (!perFile.has(file)) perFile.set(file, { siteEdits: [], inserts: [], names: new Set() });
      return perFile.get(file);
    };
    for (const e of body.siteEdits || []) {
      const site = sites.get(e.siteId);
      if (!site) { result.errors.push(`Unknown code reference (${e.siteId}). Reload the game.`); continue; }
      bucket(site.file).siteEdits.push({ site, deltas: e.deltas, params: e.params, remove: e.remove, value: e.value, valueType: e.valueType });
    }
    for (const e of body.inserts || []) {
      const decl = decls.get(e.declId);
      if (!decl) { result.errors.push(`Unknown declaration (${e.declId}). Reload the game.`); continue; }
      const b = bucket(decl.file);
      if (e.kind === "useApp") {
        // Only once per file: skip if the code already calls useApp.
        if (/\buseApp\s*\(/.test(fs.readFileSync(decl.file, "utf8"))) continue;
        b.names.add("useApp");
      }
      if (e.kind.startsWith("component:") && fs.existsSync(legacyFile())) {
        result.errors.push("This project still uses the old src/pixi-components.ts: migrate it first (Components → Migrate…).");
        continue;
      }
      if (e.kind.startsWith("component:")) {
        const type = e.kind.slice(10);
        if (!BUILTIN_COMPONENTS.has(type) && !listBehaviors().some((bh) => bh.name === type)) {
          result.errors.push(`Behavior "${type}" was not found in ${path.relative(root, behaviorsDir())}.`);
          continue;
        }
        if (decl.insertAt == null) {
          result.errors.push(`"${decl.name}" has no variable in the code, so components can't be saved for it.`);
          continue;
        }
        b.names.add("addComponent");
        b.names.add(e.kind.slice(10));
      }
      if (/^(css|attr):/.test(e.kind) && decl.insertAt == null) {
        result.errors.push(`"${decl.name}" has no line of its own to add ${e.kind.replace(/^\w+:/, "")} after.`);
        continue;
      }
      const ins = { decl, kind: e.kind, values: e.values, value: e.value, params: e.params, mode: "stmt", type: e.type, via: e.via === "element" ? "element" : undefined };
      if (decl.insertAt == null && e.kind !== "useApp" && !e.kind.startsWith("component:")) {
        const placed = placeWithoutStatement(decl, e);
        if (placed.error) { result.errors.push(placed.error); continue; }
        Object.assign(ins, placed);
      }
      b.inserts.push(ins);
    }

    const neededCategories = new Set();
    let needsCore = false;
    for (const [file, { siteEdits, inserts, names }] of perFile) {
      const original = fs.readFileSync(file, "utf8");
      if (isCssFile(file)) {
        // a CSS file: declarations replaced in place, new ones added at the end of their rule
        const { edits, errors } = planCssEdits(original, siteEdits, inserts);
        result.errors.push(...errors);
        if (!edits.length) continue;
        const code = applyHtmlEdits(original, edits);
        if (dryRun) { result.diffs.push({ file: path.relative(root, file), hunks: lineDiff(original, code) }); continue; }
        selfWrites.set(path.normalize(file), code);
        fs.writeFileSync(file, code);
        result.files.push(path.relative(root, file));
        const reg = registerCss(file, code); // same ids, new positions; new properties get new sites
        for (const ed of edits) if (ed.site) { result.applied.push(ed.site.id); result.saved++; }
        for (const ins of inserts) {
          const ns = reg.sites.find((st) => st.declId === ins.decl.id && st.kind === ins.kind);
          if (ns) { result.inserted.push({ declId: ins.decl.id, kind: ins.kind, siteId: ns.id }); result.saved++; }
        }
        continue;
      }
      if (isHtmlFile(file)) {
        // index.html: attributes, style declarations and text of its elements
        const own = [...(byFile.get(file) || [])].map((id) => sites.get(id)).filter(Boolean);
        const styleSiteOf = (declId) => own.find((st) => st.declId === declId && st.kind === "html:style") || null;
        const { edits, errors } = planHtmlEdits(original, siteEdits, inserts, styleSiteOf);
        result.errors.push(...errors);
        if (!edits.length) continue;
        const code = applyHtmlEdits(original, edits);
        if (dryRun) { result.diffs.push({ file: path.relative(root, file), hunks: lineDiff(original, code) }); continue; }
        selfWrites.set(path.normalize(file), code);
        fs.writeFileSync(file, code);
        result.files.push(path.relative(root, file));
        registerHtml(file, code); // same ids, new positions; new properties get new sites
        const now = [...(byFile.get(file) || [])].map((id) => sites.get(id)).filter(Boolean);
        for (const ed of edits) if (ed.site) { result.applied.push(ed.site.id); result.saved++; }
        for (const ins of inserts) {
          const ns = now.find((st) => st.declId === ins.decl.id && st.kind === ins.kind);
          if (ns) { result.inserted.push({ declId: ins.decl.id, kind: ins.kind, siteId: ns.id }); result.saved++; }
        }
        continue;
      }
      const ctx = { quote: detectQuote(original), failed: result.failed, pixiNames: new Set() };
      ctx.resolve = (site, value, type, code) => resolveValue(site, value, type, code, ctx);
      // HTML written in templates (innerHTML) is rewritten as HTML, escaped for its JS string
      const isTpl = (e) => (e.site && e.site.tpl) || (e.decl && e.decl.tpl);
      const { edits, errors } = planEdits(original, siteEdits.filter((e) => !isTpl(e)), inserts.filter((e) => !isTpl(e)), ctx);
      result.errors.push(...errors);
      const tplSiteEdits = siteEdits.filter(isTpl), tplInserts = inserts.filter(isTpl);
      for (const quote of new Set([...tplSiteEdits.map((e) => e.site.jsQuote), ...tplInserts.map((e) => e.decl.jsQuote)])) {
        const own = [...(byFile.get(file) || [])].map((id) => sites.get(id)).filter(Boolean);
        const styleSiteOf = (declId) => own.find((st) => st.declId === declId && st.kind === "html:style") || null;
        const r = planHtmlEdits(original, tplSiteEdits.filter((e) => e.site.jsQuote === quote), tplInserts.filter((e) => e.decl.jsQuote === quote), styleSiteOf,
          { attrQuote: quote === '"' ? "'" : '"', escape: jsEscaper(quote), where: path.relative(root, file) });
        result.errors.push(...r.errors);
        edits.push(...r.edits);
      }
      if (!edits.length) continue;
      let code = apply(file, original, edits, result);
      if (ctx.pixiNames.size) {
        const imp = planImport(code, "pixi.js", [...ctx.pixiNames], { addOnly: true });
        if (imp) code = apply(file, code, [imp], { applied: [], inserted: [], saved: 0 });
      }
      // Second pass: keep the imports in sync with the components and behaviors the file uses.
      const touchesComponents = names.size || siteEdits.some((e) => e.remove);
      if (touchesComponents) {
        const scratch = { applied: [], inserted: [], saved: 0 };
        // core (addComponent, useApp) and one import per category: { Anchor } from ".../layout"
        const modules = [["core", (n) => CORE_EXPORTS.includes(n)], ...CATALOG.categories.map((c) => [c.id, (n) => CATEGORY_OF.get(n) === c.id])];
        for (const [sub, owns] of modules) {
          const imp = planImport(code, componentSpec(file, sub), [...names].filter(owns));
          if (imp) code = apply(file, code, [imp], scratch);
        }
        for (const bh of listBehaviors()) {
          const bimp = planImport(code, behaviorSpec(file, bh.file), names.has(bh.name) ? [bh.name] : []);
          if (bimp) code = apply(file, code, [bimp], scratch);
        }
        if (names.size) needsCore = true;
        for (const n of names) if (CATEGORY_OF.has(n)) neededCategories.add(CATEGORY_OF.get(n));
      }
      const formatted = await formatLikeProject(file, original, code);
      if (dryRun) {
        result.diffs.push({ file: path.relative(root, file), hunks: lineDiff(original, formatted || code) });
        continue;
      }
      if (formatted && formatted !== code && remapAfterFormat(file, formatted)) code = formatted;
      selfWrites.set(path.normalize(file), code);
      fs.writeFileSync(file, code);
      result.files.push(path.relative(root, file));
      if (tplSiteEdits.length || tplInserts.length) {
        const fresh = refreshTemplates(file, code);
        for (const ins of tplInserts) {
          const ns = fresh.find((st) => st.declId === ins.decl.id && st.kind === ins.kind);
          if (ns) { result.inserted.push({ declId: ins.decl.id, kind: ins.kind, siteId: ns.id }); result.saved++; }
        }
      }
    }

    if (dryRun) {
      if (needsCore) result.newFiles = missingComponentFiles(neededCategories);
      return result;
    }
    if (needsCore) {
      const created = await ensureComponentFiles(neededCategories);
      if (created.length) { result.files.push(...created); result.createdModule = true; }
    }
    result.ok = result.errors.length === 0;
    return result;
  }

  return {
    name: "pixi-editor",
    enforce: "pre",
    apply: "serve",

    configResolved(config) { root = config.root; },

    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const tags = [{ tag: "script", children: RUNTIME, injectTo: "head-prepend" }];
        // Mark the page's own elements so the editor can show and save them (only when the HTML is
        // exactly the file on disk: the positions must match it).
        const file = ctx && ctx.filename;
        let disk = null;
        try { disk = file ? fs.readFileSync(file, "utf8") : null; } catch { /* virtual page */ }
        if (disk == null || disk !== html) return tags;
        return { html: markHtml(html, registerHtml(file, html)), tags };
      },
    },

    // Live preview of the components module before it exists in the project.
    resolveId(id, importer) {
      if (id === PREVIEW_URL) return path.join(componentsDir(), "__editor_all__.ts") + ALL_QUERY;
      // Inside the editor's view of the components: use the project's file when it exists,
      // otherwise the template (not copied into the project yet).
      if (importer && (importer.endsWith(PREVIEW_QUERY) || importer.endsWith(ALL_QUERY)) && id.startsWith(".")) {
        let abs = path.resolve(path.dirname(importer.split("?")[0]), id);
        if (!/\.ts$/.test(abs)) abs += ".ts";
        if (fs.existsSync(abs)) return abs;
        const tpl = path.join(COMPONENTS_TEMPLATE, path.relative(componentsDir(), abs));
        if (inComponents(abs) && fs.existsSync(tpl)) return abs + PREVIEW_QUERY;
        return null;
      }
      if (id === PIXI_URL) return path.join(root, PIXI_ID);
      if (id === SPINE_URL) return path.join(root, SPINE_ID);
      return null;
    },
    load(id) {
      if (id.endsWith(ALL_QUERY) && id.startsWith(componentsDir())) {
        // Every component (project copy or template), plus a name -> class map for the editor.
        const lines = ['export * from "./core.ts";'];
        const names = [];
        for (const cat of CATALOG.categories) {
          const list = cat.components.map((c) => c.name);
          lines.push(`import { ${list.join(", ")} } from "./${cat.id}/index.ts";`);
          names.push(...list);
        }
        lines.push(`export const componentTypes = { ${names.join(", ")} };`);
        lines.push(`export const catalog = ${JSON.stringify(CATALOG)};`);
        return lines.join("\n") + "\n";
      }
      if (id.endsWith(PREVIEW_QUERY) && id.startsWith(componentsDir())) {
        const rel = path.relative(componentsDir(), id.slice(0, -PREVIEW_QUERY.length));
        return fs.readFileSync(path.join(COMPONENTS_TEMPLATE, rel), "utf8");
      }
      if (id === path.join(root, PIXI_ID)) return 'export * from "pixi.js";\n';
      if (id === path.join(root, SPINE_ID)) {
        const req = createRequire(path.join(root, "package.json"));
        const installed = (name) => {
          for (const spec of [name, `${name}/package.json`]) { try { req.resolve(spec); return true; } catch { /* ESM-only exports */ } }
          for (let dir = root; ; dir = path.dirname(dir)) {
            if (fs.existsSync(path.join(dir, "node_modules", name, "package.json"))) return true;
            if (path.dirname(dir) === dir) return false;
          }
        };
        const pkg = SPINE_PACKAGES.find(installed);
        return pkg ? `export * from ${JSON.stringify(pkg)};\nexport const available = true;\n` : "export const available = false;\n";
      }
      return null;
    },

    transform(code, id) {
      const file = id.split("?")[0];
      if (inComponents(file) || file === legacyFile()) return null; // components are the editor's own code
      if (!/\.(m?[jt]sx?)$/.test(file) || file.includes("/node_modules/") || !file.startsWith(root)) return null;
      // The editor's own files (templates, runtime) are never instrumented; its test fixtures are.
      if (EDITOR_DIRS.some((d) => file.startsWith(d + path.sep))) return null;
      const out = instrument(code, file, nextId, { htmlIdFor: tplIdFor(file) });
      if (!out) { register(file, [], [], code); return null; }
      register(file, out.sites, out.decls, code);
      return { code: out.code, map: out.map };
    },

    // Changes written by the editor are already live in the game: skip Vite's reload.
    // `hotUpdate` is Vite 6+ (also sees newly created files); `handleHotUpdate` covers Vite 5.
    async hotUpdate({ file, read }) {
      return (await isSelfWrite(file, read)) ? [] : undefined;
    },
    async handleHotUpdate({ file, read }) {
      return (await isSelfWrite(file, read)) ? [] : undefined;
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, "http://x");
        if (url.pathname === `${BASE}api/info`) {
          const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
          const out = {};
          for (const id of ids) out[id] = info(id);
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify(out));
        }
        if (url.pathname === `${BASE}api/components`) {
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({
            url: PREVIEW_URL,
            dir: path.relative(root, componentsDir()),
            catalog: CATALOG,
            legacy: fs.existsSync(legacyFile()) ? path.relative(root, legacyFile()) : null,
            behaviors: listBehaviors().map(({ name, url: u, rel }) => ({ name, url: u, file: rel })),
          }));
        }
        const readJson = () => new Promise((resolve) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
        });
        const sendJson = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
        if (url.pathname === `${BASE}api/css-rules` && req.method === "POST") {
          readJson().then((b) => { try { sendJson({ ok: true, sheets: cssRules(b) }); } catch (err) { sendJson({ ok: false, error: String(err.message || err) }); } });
          return;
        }
        if (url.pathname === `${BASE}api/open-in-ide` && req.method === "POST") {
          readJson().then(async (b) => sendJson(await openInIde(b.file, b.line, b.col)));
          return;
        }
        if (url.pathname === `${BASE}api/create` && req.method === "POST") {
          readJson().then(async (b) => {
            try { sendJson(await createObject(b)); }
            catch (err) { sendJson({ ok: false, error: String(err.message || err) }); }
          });
          return;
        }
        if (url.pathname === `${BASE}api/behavior` && req.method === "POST") {
          readJson().then(async (b) => {
            try { sendJson({ ok: true, ...(await createBehavior(b.name, b.objectName)) }); }
            catch (err) { sendJson({ ok: false, error: String(err.message || err) }); }
          });
          return;
        }
        if (url.pathname === `${BASE}api/migrate-components` && req.method === "POST") {
          readJson().then(async (b) => {
            try { sendJson(await migrateComponents(b)); }
            catch (err) { sendJson({ ok: false, error: String(err.message || err) }); }
          });
          return;
        }
        if (url.pathname === `${BASE}api/order` && req.method === "POST") {
          readJson().then(async (b) => {
            try { sendJson(await orderObject(b)); }
            catch (err) { sendJson({ ok: false, error: String(err.message || err) }); }
          });
          return;
        }
        if (url.pathname === `${BASE}api/object` && req.method === "POST") {
          readJson().then(async (b) => {
            try { sendJson(await objectAction(b)); }
            catch (err) { sendJson({ ok: false, error: String(err.message || err) }); }
          });
          return;
        }
        if (url.pathname === `${BASE}api/preview` && req.method === "POST") {
          readJson().then(async (b) => {
            try { sendJson(await save(b, { dryRun: true })); }
            catch (err) { sendJson({ ok: false, errors: [String((err && err.message) || err)], diffs: [] }); }
          });
          return;
        }
        if (url.pathname === `${BASE}api/save` && req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", async () => {
            let out;
            try { out = await save(JSON.parse(body)); } catch (err) {
              console.error("[pixi-editor] save failed:", err, "\nrequest:", body);
              out = { ok: false, errors: [String((err && err.message) || err)] };
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(out));
          });
          return;
        }
        next();
      });
    },
  };
}
