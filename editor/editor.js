// Editor UI. Talks directly to the game (same origin)
// through iframe.contentWindow.__PIXI_EDITOR__.
const $ = (s) => document.querySelector(s);
const iframe = $("#game");
const overlay = $("#overlay");
const gizmo = $("#gizmo");
const ctx = gizmo.getContext("2d");
const treeEl = $("#tree");
const inspectorEl = $("#inspector");
const statusEl = $("#status");

const state = {
  win: null, pe: null, app: null,
  mode: "edit",
  selected: null, hover: null,
  pending: new Map(), // key -> { obj, prop, original, current }
  undo: [], redo: [],
  expanded: new WeakSet(),
  uids: new WeakMap(), nextUid: 1,
  info: new Map(), // id -> server info (file, line, code)
  drag: null,
  treeSig: "",
  project: null, // { name, path, pixi, warnings }
  recent: [],
  compMod: null, // the project's components module, loaded inside the game iframe
  behaviors: [], // [{ name, url, file }] — the project's src/behaviors/*.ts
  PIXI: null, // the project's pixi.js module (same instance as the game's)
  behaviorClasses: {}, // name -> class (loaded inside the game iframe)
  compOriginal: new Map(), // `${uid}:${type}` -> { obj, type, original: params | null }
  view: { z: 1, x: 0, y: 0 }, // viewport zoom and pan
  tool: "move", // "move" (move/scale/rotate) or "pivot" (drag the origin)
  pan: null,
  spaceDown: false,
  stopped: false,
  treeQuery: "", // hierarchy search
  treeMatches: [],
};

// ---------------------------------------------------------------- properties
const PROPS = {
  x: { get: (o) => o.x, set: (o, v) => (o.x = v) },
  y: { get: (o) => o.y, set: (o, v) => (o.y = v) },
  scaleX: { get: (o) => o.scale.x, set: (o, v) => (o.scale.x = v) },
  scaleY: { get: (o) => o.scale.y, set: (o, v) => (o.scale.y = v) },
  rotation: { get: (o) => o.rotation, set: (o, v) => (o.rotation = v) },
  alpha: { get: (o) => o.alpha, set: (o, v) => (o.alpha = v) },
  pivotX: { get: (o) => o.pivot.x, set: (o, v) => (o.pivot.x = v) },
  pivotY: { get: (o) => o.pivot.y, set: (o, v) => (o.pivot.y = v) },
  anchorX: { get: (o) => (o.anchor ? o.anchor.x : 0), set: (o, v) => o.anchor && (o.anchor.x = v) },
  anchorY: { get: (o) => (o.anchor ? o.anchor.y : 0), set: (o, v) => o.anchor && (o.anchor.y = v) },
  text: { get: (o) => String(o.text ?? ""), set: (o, v) => (o.text = v) },
  label: { get: (o) => customLabel(o), set: (o, v) => (o.label = v) },
  tint: { get: (o) => (typeof o.tint === "number" ? o.tint : 0xffffff), set: (o, v) => (o.tint = v) },
  textFill: { get: (o) => colorToNumber(o.style && o.style.fill), set: (o, v) => (o.style.fill = v) },
  texture: { get: (o) => o.texture, set: (o, v) => { if (v) o.texture = v; } },
  // Parent container. Moves keep the index order simple: the object goes on top of its new siblings.
  parent: { get: (o) => o.parent, set: (o, v) => { if (v && o.parent !== v) v.addChild(o); } },
  // Spine skeleton: "" = as created by the code, otherwise JSON { skeleton: keys[], atlas: keys[] }.
  spine: { get: (o) => o.__peSpine || "", set: (o, v) => setSpine(o, v) },
  // Spine animation on track 0.
  animation: {
    get: (o) => (o.state && o.state.tracks && o.state.tracks[0] && o.state.tracks[0].animation ? o.state.tracks[0].animation.name : ""),
    set: (o, v) => { if (v && o.state) { o.state.setAnimation(0, v, true); if (typeof o.update === "function") o.update(0); } },
  },
  ...Object.fromEntries(["fontFamily", "fontSize", "fontWeight", "fontStyle", "align", "letterSpacing", "lineHeight"].map((k) => [k, {
    get: (o) => { const v = o.style ? o.style[k] : undefined; return Array.isArray(v) ? v.join(", ") : v ?? (/Size|Spacing|Height/.test(k) ? 0 : ""); },
    set: (o, v) => { if (o.style) o.style[k] = v; },
  }])),
  // Index among its siblings (draw order).
  order: { get: (o) => (o.parent ? o.parent.getChildIndex(o) : 0), set: (o, v) => { if (o.parent) o.parent.setChildIndex(o, Math.max(0, Math.min(v, o.parent.children.length - 1))); } },
};
// Graphics fills: "gfill:0", "gfill:1"… map to the n-th fill instruction of the Graphics context.
function fillInstructions(o) {
  const list = o && o.context && Array.isArray(o.context.instructions) ? o.context.instructions : [];
  return list.filter((i) => i.action === "fill" && i.data && i.data.style);
}
function propDef(p) {
  if (PROPS[p]) return PROPS[p];
  const m = /^gfill:(\d+)$/.exec(p);
  if (!m) throw new Error(`Unknown property ${p}`);
  const n = Number(m[1]);
  return {
    get: (o) => { const f = fillInstructions(o)[n]; return f ? f.data.style.color : 0; },
    set: (o, v) => {
      const f = fillInstructions(o)[n];
      if (!f) return;
      f.data.style.color = v;
      if (typeof o.context.onUpdate === "function") o.context.onUpdate();
      else o.context.emit("update", o.context);
    },
  };
}
// Value properties are saved by replacing a literal, not by adjusting a number.
const VALUE_TYPE = { text: "string", label: "string", tint: "color", textFill: "color", texture: "texture", parent: "parent", spine: "spine", order: "order",
  animation: "string", fontFamily: "string", fontWeight: "string", fontStyle: "string", align: "string" };
const valueTypeOf = (p) => VALUE_TYPE[p] || (p.startsWith("gfill:") ? "color" : null);
const sameValue = (a, b) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b);

const colorCtx = document.createElement("canvas").getContext("2d");
/** Pixi color input (number, "#hex", "red", "rgb()") -> 0xRRGGBB, or null for gradients/patterns. */
function colorToNumber(c) {
  if (typeof c === "number") return c >>> 0 & 0xffffff;
  if (typeof c !== "string") return c && typeof c === "object" && typeof c.color === "number" ? c.color : null;
  colorCtx.fillStyle = "#000";
  colorCtx.fillStyle = c;
  const v = colorCtx.fillStyle;
  if (v.startsWith("#")) return parseInt(v.slice(1, 7), 16);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]) : null;
}
const toHex = (n) => "#" + (Number(n) >>> 0 & 0xffffff).toString(16).padStart(6, "0");
// Which code lines can store each property: [site kind, component, conversion factor]
const CANDIDATES = {
  x: [["x"], ["position", 0]],
  y: [["y"], ["position", 1]],
  scaleX: [["scale.x"], ["scale", 0]],
  scaleY: [["scale.y"], ["scale", 1]],
  rotation: [["rotation"], ["angle", null, 180 / Math.PI]],
  alpha: [["alpha"]],
  pivotX: [["pivot.x"], ["pivot", 0]],
  pivotY: [["pivot.y"], ["pivot", 1]],
  anchorX: [["anchor.x"], ["anchor", 0]],
  anchorY: [["anchor.y"], ["anchor", 1]],
  text: [["text"]],
  label: [["label"]],
  tint: [["tint"]],
  textFill: [["style.fill"]],
  texture: [["texture"]],
  parent: [["parent"]],
  spine: [["spine"]],
  animation: [["animation"]],
  fontFamily: [["style.fontFamily"]], fontSize: [["style.fontSize"]], fontWeight: [["style.fontWeight"]],
  fontStyle: [["style.fontStyle"]], align: [["style.align"]], letterSpacing: [["style.letterSpacing"]], lineHeight: [["style.lineHeight"]],
};
const ASSET_PROPS = new Set(["texture", "parent", "spine"]);
// Shown only for some kinds of objects (spines, texts): not listed as "missing" for the others.
const OPTIONAL_PROPS = new Set(["animation", "fontFamily", "fontSize", "fontWeight", "fontStyle", "align", "letterSpacing", "lineHeight"]);
const candidatesOf = (p) => CANDIDATES[p] || (p.startsWith("gfill:") ? [[p]] : []);
const INSERT_GROUP = {
  x: "position", y: "position", scaleX: "scale", scaleY: "scale", rotation: "rotation", alpha: "alpha",
  pivotX: "pivot", pivotY: "pivot", anchorX: "anchor", anchorY: "anchor",
  text: "text", label: "label", tint: "tint", textFill: "style.fill",
  fontFamily: "style.fontFamily", fontSize: "style.fontSize", fontWeight: "style.fontWeight", fontStyle: "style.fontStyle",
  align: "style.align", letterSpacing: "style.letterSpacing", lineHeight: "style.lineHeight",
};

// ---------------------------------------------------------------- components
const COMPONENT_TYPES = ["Anchor", "Button", "Tween"];
const TWEEN_AMOUNT = { pulse: 0.05, float: 6, spin: 1, fade: 0.5 };
const SCHEMAS = {
  Anchor: {
    help: "Keeps the object at a fixed offset from a screen edge or corner. Dragging the object edits the offset.",
    fields: [
      { key: "h", label: "Horizontal", type: "select", options: ["left", "center", "right"] },
      { key: "v", label: "Vertical", type: "select", options: ["top", "middle", "bottom"] },
      { key: "x", label: "Offset X", type: "number", step: 1 },
      { key: "y", label: "Offset Y", type: "number", step: 1 },
    ],
  },
  Button: {
    help: "Pointer cursor plus hover and press feedback. Handle clicks in code with target.on(\"pointertap\", …).",
    fields: [
      { key: "hoverScale", label: "Hover scale", type: "number", step: 0.01 },
      { key: "pressScale", label: "Press scale", type: "number", step: 0.01 },
      { key: "cursor", label: "Cursor", type: "select", options: ["pointer", "default", "grab", "help"] },
    ],
  },
  Tween: {
    help: "Looping idle animation on top of the object's values. Paused in Edit mode — switch to Play to preview.",
    fields: [
      { key: "kind", label: "Kind", type: "select", options: ["pulse", "float", "spin", "fade"] },
      { key: "amount", label: "Amount", type: "number", step: 0.01 },
      { key: "speed", label: "Speed", type: "number", step: 0.05 },
    ],
  },
};

const compName = (c) => c.constructor.componentName;
function compList(obj) {
  if (!state.compMod || !obj) return [];
  try {
    const list = [...state.compMod.getComponents(obj)];
    for (const c of list) if (!state.behaviorClasses[compName(c)] && !COMPONENT_TYPES.includes(compName(c))) state.behaviorClasses[compName(c)] = c.constructor;
    return list;
  } catch { return []; }
}
const getComp = (obj, type) => compList(obj).find((c) => compName(c) === type) || null;
const isBuiltin = (type) => COMPONENT_TYPES.includes(type);
function typeClass(type) {
  return (state.compMod && state.compMod.componentTypes[type]) || state.behaviorClasses[type] || null;
}
async function loadBehaviorClass(name, url) {
  if (state.behaviorClasses[name]) return state.behaviorClasses[name];
  const mod = await state.win.eval(`import(${JSON.stringify(url)})`);
  if (!mod[name]) throw new Error(`${url} does not export a class named ${name}`);
  state.behaviorClasses[name] = mod[name];
  return mod[name];
}
/** { Anchor: {...params}, Button: {...} } for the components currently on `obj`. */
function compSnapshot(obj) {
  const snap = {};
  for (const c of compList(obj)) snap[compName(c)] = { ...c.params };
  return snap;
}
/** Makes the components on `obj` match `snap` (used by undo/redo). */
function compRestore(obj, snap) {
  if (!state.compMod) return;
  const types = new Set([...COMPONENT_TYPES, ...Object.keys(snap), ...compList(obj).map(compName)]);
  for (const type of types) {
    const want = snap[type];
    const have = getComp(obj, type);
    const cls = typeClass(type);
    if (want && have) { have.params = { ...want }; have.apply(); }
    else if (want && cls) state.compMod.addComponent(obj, cls, { ...want });
    else if (have && cls) state.compMod.removeComponent(obj, cls);
  }
  render();
}
const sameParams = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Component changes not saved yet: [{ obj, type, original, current }] */
function compChanges() {
  const out = [];
  for (const rec of state.compOriginal.values()) {
    const cur = getComp(rec.obj, rec.type);
    const current = cur ? { ...cur.params } : null;
    if (!sameParams(rec.original, current)) out.push({ ...rec, current });
  }
  return out;
}
const pendingCount = () => state.pending.size + compChanges().length;

const uid = (o) => {
  let id = state.uids.get(o);
  if (!id) { id = state.nextUid++; state.uids.set(o, id); }
  return id;
};
const metaOf = (o) => (state.pe && o ? state.pe.meta(o) : null);
const isEditable = (o) => { const m = metaOf(o); return !!(m && (m.declId || Object.keys(m.sites).length)); };
const typeOf = (o) => ((o && o.constructor && o.constructor.name) || "Object").replace(/^_+/, "");
/** A label set by the game or the user (Pixi gives some classes a default label equal to the class name). */
const customLabel = (o) => {
  const l = o && o.label;
  if (!l || typeof l !== "string") return "";
  const cls = (o.constructor && o.constructor.name) || "";
  return l === cls || l === typeOf(o) ? "" : l;
};
const nameOf = (o) => {
  if (state.app && o === state.app.stage) return "Stage";
  const m = metaOf(o);
  return customLabel(o) || (m && m.name) || typeOf(o);
};
const isModified = (o) => {
  for (const p of state.pending.values()) if (p.obj === o) return true;
  return compChanges().some((c) => c.obj === o);
};

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

// ---------------------------------------------------------------- connection to the game
let pollTimer = null;
iframe.addEventListener("load", () => {
  if (!state.project || !iframe.getAttribute("src")) return;
  state.win = state.pe = state.app = null;
  state.mode = "play"; // let the game boot (loading screens, tweens…); switch to Edit when ready
  state.selected = state.hover = null;
  state.pending.clear(); state.undo = []; state.redo = [];
  state.compOriginal.clear(); state.compMod = null;
  state.info.clear();
  updateSaveButton(); renderInspector();
  const c = $("#connecting");
  c.textContent = "Connecting to the game…"; c.className = "connecting";
  let tries = 0;
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    tries++;
    const win = iframe.contentWindow;
    const pe = win && win.__PIXI_EDITOR__;
    const app = pe && (pe.apps.find((a) => a.renderer && a.stage) || (win.__PIXI_APP__ && win.__PIXI_APP__.renderer ? win.__PIXI_APP__ : null));
    if (app) {
      clearInterval(pollTimer);
      state.win = win; state.pe = pe; state.app = app;
      state.expanded.add(app.stage);
      c.className = "connecting hidden";
      win.addEventListener("keydown", onKey, true);
      setMode(state.mode);
      if (iframe.classList.contains("sized")) setTimeout(zoomFit, 300); // a screen size preset: show all of it
      applyMute();
      if (state.afterReload) { setStatus(state.afterReload, "ok"); state.afterReload = null; }
      else setStatus(`Connected to ${state.project ? state.project.name : "the game"} — the game is running. Press Edit (Ctrl/Cmd+E) to select objects.`);
      loadComponents();
    } else if (tries === 40) {
      c.textContent = pe
        ? "No Pixi Application created with `new Application()` was found."
        : "The game did not load the editor runtime. Is this a Vite project?";
      c.className = "connecting error";
    }
  }, 250);
});


async function loadComponents() {
  try {
    const info = await (await fetch("/__pixi-editor/api/components")).json();
    const win = state.win;
    const mod = await win.eval(`import(${JSON.stringify(info.url)})`);
    if (state.win !== win) return;
    state.compMod = mod;
    state.behaviors = info.behaviors || [];
    state.PIXI = await win.eval(`import("/@pixi-editor/pixi.ts")`);
    mod.useApp(state.app);
    renderInspector();
  } catch (err) {
    console.warn("[pixi-editor] components unavailable:", err);
  }
}

// ---------------------------------------------------------------- modes
function setMode(mode) {
  state.mode = mode;
  $("#mode-edit").classList.toggle("active", mode === "edit");
  $("#mode-play").classList.toggle("active", mode === "play");
  overlay.classList.toggle("play", mode === "play");
  const app = state.app;
  if (state.pe) state.pe.paused = mode === "edit";
  if (app && app.ticker) {
    if (mode === "edit") { app.ticker.stop(); render(); overlay.focus(); }
    else { app.ticker.start(); iframe.focus(); }
  }
  if (state.app) setStatus(mode === "edit" ? "Edit mode — the game is paused" : "Play mode — the editor does not capture the mouse");
}
$("#mode-edit").onclick = () => setMode("edit");
$("#mode-play").onclick = () => setMode("play");
$("#btn-reload").onclick = () => {
  if (!state.project) return;
  if (pendingCount() && !window.confirm("You have unsaved changes. Reload anyway?")) return;
  iframe.contentWindow.location.reload();
};
$("#btn-undo").onclick = () => undo();
$("#btn-save").onclick = () => save();

function render() {
  try { if (state.app && state.app.renderer) state.app.render(); } catch { /* the game may be half-initialized */ }
}

// ---------------------------------------------------------------- coordinates
function canvasRect() {
  return state.app.canvas.getBoundingClientRect(); // relative to the iframe = relative to the overlay
}
// Pixi global coords -> iframe coords -> overlay coords (the iframe is zoomed/panned with a CSS transform).
function globalToOverlay(gx, gy) {
  const r = canvasRect(), s = state.app.screen, v = state.view;
  return { x: v.x + (r.left + (gx * r.width) / s.width) * v.z, y: v.y + (r.top + (gy * r.height) / s.height) * v.z };
}
function overlayToGlobal(px, py) {
  const r = canvasRect(), s = state.app.screen, v = state.view;
  const cx = (px - v.x) / v.z, cy = (py - v.y) / v.z;
  return { x: ((cx - r.left) * s.width) / r.width, y: ((cy - r.top) * s.height) / r.height };
}

// ---------------------------------------------------------------- zoom and pan
function applyView() {
  const v = state.view;
  iframe.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  $("#zoom-level").textContent = `${Math.round(v.z * 100)}%`;
}
function zoomAt(px, py, z) {
  const v = state.view;
  const nz = Math.min(8, Math.max(0.1, z));
  v.x = px - ((px - v.x) * nz) / v.z;
  v.y = py - ((py - v.y) * nz) / v.z;
  v.z = nz;
  applyView();
}
function zoomBy(factor) {
  zoomAt(overlay.clientWidth / 2, overlay.clientHeight / 2, state.view.z * factor);
}
function zoomReset() { state.view = { z: 1, x: 0, y: 0 }; applyView(); }
function zoomFit() {
  if (!state.app && !iframe.classList.contains("sized")) return zoomReset();
  // With a screen size preset, show the whole "screen"; otherwise the game's canvas.
  const r = iframe.classList.contains("sized") ? { left: 0, top: 0, width: iframe.offsetWidth, height: iframe.offsetHeight } : canvasRect();
  const W = overlay.clientWidth, H = overlay.clientHeight;
  const z = Math.min(8, Math.max(0.1, Math.min((W * 0.94) / r.width, (H * 0.94) / r.height)));
  state.view = { z, x: W / 2 - (r.left + r.width / 2) * z, y: H / 2 - (r.top + r.height / 2) * z };
  applyView();
}
$("#zoom-out").onclick = () => zoomBy(1 / 1.25);
$("#zoom-in").onclick = () => zoomBy(1.25);
$("#zoom-level").onclick = zoomReset;
$("#zoom-fit").onclick = zoomFit;
overlay.addEventListener("wheel", (e) => {
  if (!state.app) return;
  e.preventDefault();
  const pt = eventPoint(e);
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomAt(pt.x, pt.y, state.view.z * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });
function eventPoint(e) {
  const r = overlay.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function boundsOf(o) {
  try {
    const b = o.getBounds();
    if (!isFinite(b.minX) || !isFinite(b.maxX) || b.maxX - b.minX <= 0 && b.maxY - b.minY <= 0) return null;
    return b;
  } catch { return null; }
}

/** Every object under the point, top-most first (each resolved to its editable ancestor). */
function pickAll(gx, gy) {
  const stage = state.app.stage;
  const out = [];
  (function visit(o) {
    const kids = o.children || [];
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (!c.visible || c.alpha === 0) continue;
      visit(c);
      if (c.children.length === 0) {
        const b = boundsOf(c);
        if (b && gx >= b.minX && gx <= b.maxX && gy >= b.minY && gy <= b.maxY) {
          let t = c;
          while (t && t !== stage && !isEditable(t)) t = t.parent;
          const r = t && t !== stage ? t : c;
          if (!out.includes(r)) out.push(r);
        }
      }
    }
  })(stage);
  return out;
}

// Deepest, top-most object under the point; if not editable, walk up to an editable ancestor.
function pick(gx, gy) {
  const stage = state.app.stage;
  function visit(o) {
    const kids = o.children || [];
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (!c.visible || c.alpha === 0) continue;
      const hit = visit(c);
      if (hit) return hit;
      if (c.children.length === 0) {
        const b = boundsOf(c);
        if (b && gx >= b.minX && gx <= b.maxX && gy >= b.minY && gy <= b.maxY) return c;
      }
    }
    return null;
  }
  let hit = visit(stage);
  if (!hit) return null;
  let o = hit;
  while (o && o !== stage && !isEditable(o)) o = o.parent;
  return o && o !== stage ? o : hit;
}

// ---------------------------------------------------------------- changes, undo
function setLive(obj, vals) {
  for (const [p, v] of Object.entries(vals)) propDef(p).set(obj, v);
  render();
}
/** Moves an object; anchored objects update their Anchor offset instead. */
function moveTo(obj, x, y) {
  const anchor = getComp(obj, "Anchor");
  if (anchor && anchor.setFromPosition) { anchor.setFromPosition(x, y); render(); }
  else setLive(obj, { x, y });
}
function readVals(obj, props) {
  const out = {};
  for (const p of props) out[p] = propDef(p).get(obj);
  return out;
}
function trackPending(obj, before, after) {
  for (const p of Object.keys(after)) {
    const key = `${uid(obj)}:${p}`;
    let rec = state.pending.get(key);
    if (!rec) { rec = { obj, prop: p, original: before[p], current: after[p] }; state.pending.set(key, rec); }
    rec.current = after[p];
    if (sameValue(rec.current, rec.original)) state.pending.delete(key);
  }
  updateSaveButton();
}
/**
 * Records a finished change for undo and saving. `compBefore`/`compAfter` are component
 * snapshots; pass them when the change touches components (otherwise they are taken as equal).
 */
function commit(obj, before, after, compBefore = null, compAfter = null) {
  const propsChanged = Object.keys(after).some((p) => !sameValue(after[p], before[p]));
  const compsChanged = compBefore && compAfter && !sameParams(compBefore, compAfter);
  if (!propsChanged && !compsChanged) return;
  if (compsChanged) {
    for (const type of new Set([...COMPONENT_TYPES, ...Object.keys(compBefore), ...Object.keys(compAfter)])) {
      const key = `${uid(obj)}:${type}`;
      if (!state.compOriginal.has(key)) state.compOriginal.set(key, { obj, type, original: compBefore[type] ? { ...compBefore[type] } : null });
    }
  }
  state.undo.push({ obj, before, after, compBefore: compsChanged ? compBefore : null, compAfter: compsChanged ? compAfter : null });
  state.redo = [];
  if (propsChanged) trackPending(obj, before, after);
  afterChange();
}
function afterChange() {
  if (state.replaced) { state.replaced = false; renderInspector(); }
  updateSaveButton();
  refreshInspectorValues(true);
  renderComponentValues();
  state.treeSig = "";
}
function undo() {
  const e = state.undo.pop();
  if (!e) return;
  state.redo.push(e); // first: replacing an object (spine change) updates the entries in the lists
  setLive(e.obj, e.before);
  trackPending(e.obj, e.after, e.before);
  if (e.compBefore) { compRestore(e.obj, e.compBefore); renderInspector(); }
  afterChange();
}
function redo() {
  const e = state.redo.pop();
  if (!e) return;
  state.undo.push(e);
  setLive(e.obj, e.after);
  trackPending(e.obj, e.before, e.after);
  if (e.compAfter) { compRestore(e.obj, e.compAfter); renderInspector(); }
  afterChange();
}
function updateSaveButton() {
  const n = pendingCount();
  $("#btn-save").disabled = n === 0;
  $("#save-count").textContent = n ? String(n) : "";
}

// ---------------------------------------------------------------- save to code
function bestSite(meta, prop) {
  let best = null;
  for (const [kind, comp, factor] of candidatesOf(prop)) {
    const s = meta && meta.sites[kind];
    // Lines inside pointer handlers (hover/press) only count when nothing else sets the property.
    const better = (x, y) => (!!x.transient !== !!y.transient ? !x.transient : x.seq > y.seq);
    if (s && (!best || better(s, best))) best = { ...s, kind, comp, factor };
  }
  return best;
}

/** Undoes a parent change that can't be saved (and the position that kept the object in place). */
function revertMove(rec) {
  const o = rec.obj;
  setLive(o, { parent: rec.original });
  state.pending.delete(`${uid(o)}:parent`);
  for (const p of ["x", "y"]) {
    const r = state.pending.get(`${uid(o)}:${p}`);
    if (r) { setLive(o, { [p]: r.original }); state.pending.delete(`${uid(o)}:${p}`); }
  }
}

/**
 * Parent changes are saved first, on their own: if one can't be written, the move is undone before
 * the positions (which were adjusted to keep the object in place) are saved.
 */
async function saveParents(reviewed = false) {
  const recs = [...state.pending.values()].filter((p) => p.prop === "parent");
  const msgs = [];
  msgs.files = [];
  if (!recs.length) return msgs;
  const edits = [];
  for (const rec of recs) {
    const site = bestSite(metaOf(rec.obj), "parent");
    const value = saveValue(rec);
    if (!site || value == null) {
      msgs.push(!site
        ? `${nameOf(rec.obj)}: the line that adds it to its parent wasn't found — moved back`
        : `${nameOf(rec.current)} is not stored in a variable in the code — ${nameOf(rec.obj)} moved back`);
      revertMove(rec);
      continue;
    }
    edits.push({ rec, site, value });
  }
  if (edits.length) {
    const shared = edits.filter((e) => (state.pe.siteUse.get(e.site.id) || 0) > 1);
    if (shared.length && !reviewed && !window.confirm(`The line that adds ${nameOf(shared[0].rec.obj)} adds ${state.pe.siteUse.get(shared[0].site.id)} objects. Moving it moves all of them. Continue?`)) return null;
    let res;
    try {
      res = await (await fetch("/__pixi-editor/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteEdits: edits.map((e) => ({ siteId: e.site.id, value: e.value, valueType: "parent" })), inserts: [] }),
      })).json();
    } catch (err) {
      return [`Save failed: ${err}`];
    }
    const applied = new Set(res.applied || []);
    for (const { rec, site } of edits) {
      if (!applied.has(site.id)) { revertMove(rec); continue; }
      state.pending.delete(`${uid(rec.obj)}:parent`);
      const moved = (res.inserted || []).find((i) => i.from === site.id);
      if (moved) state.pe.s(rec.obj, "parent", moved.siteId); // children: [ … ] became parent.addChild(…)
    }
    msgs.push(...(res.errors || []).map((e) => `${e} — moved back`));
    msgs.files.push(...(res.files || []));
    state.info.clear();
  }
  updateSaveButton();
  state.treeSig = "";
  render();
  return msgs;
}

/** The request that writes an object's draw order: its parent line and its new neighbours' lines. */
function orderRequest(o) {
  const site = bestSite(metaOf(o), "parent");
  if (!site || !o.parent) return null;
  const kids = o.parent.children;
  const i = kids.indexOf(o);
  const siteOf = (x) => { const st = x && bestSite(metaOf(x), "parent"); return st ? st.id : null; };
  return { siteId: site.id, nextSiteId: siteOf(kids[i + 1]), prevSiteId: siteOf(kids[i - 1]) };
}

/** Draw order changes, one at a time (each moves a line of code). Failed ones are put back. */
async function saveOrders() {
  const msgs = [];
  msgs.files = [];
  for (const [key, rec] of [...state.pending].filter(([, r]) => r.prop === "order")) {
    const req = orderRequest(rec.obj);
    let res = req ? null : { ok: false, error: `${nameOf(rec.obj)}: the line that adds it to its parent wasn't found` };
    if (req) {
      try {
        res = await (await fetch("/__pixi-editor/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) })).json();
      } catch (err) { res = { ok: false, error: String(err) }; }
    }
    if (res.ok) { msgs.files.push(res.file); state.pending.delete(key); continue; }
    setLive(rec.obj, { order: rec.original });
    state.pending.delete(key);
    msgs.push(`${nameOf(rec.obj)}: ${res.error} — order put back`);
  }
  if (msgs.files.length) state.info.clear();
  updateSaveButton();
  state.treeSig = "";
  return msgs;
}

/** The value sent to the server for texture, parent and spine changes (null = can't be saved). */
function saveValue(p) {
  if (p.prop === "texture") { const keys = textureKeys(p.current); return keys.length ? { keys } : null; }
  if (p.prop === "spine") return p.current ? JSON.parse(p.current) : null;
  if (p.prop === "parent") {
    if (state.app && p.current === state.app.stage) {
      const app = state.pe.appDecls && state.pe.appDecls.get(state.app);
      return app ? `stage:${app.declId}` : null;
    }
    const m = metaOf(p.current);
    return m && m.declId ? m.declId : null;
  }
  return null;
}

/** What saving the pending changes sends to the server (site edits and new lines). */
function buildSave() {
  const siteEdits = new Map();
  const inserts = new Map();
  const unsaved = [];
  const plan = []; // [{ key, target }]
  const compPlan = []; // [{ rec, target, kind }]

  for (const [key, p] of state.pending) {
    if (p.prop === "order") continue; // saved on its own (saveOrders)
    const meta = metaOf(p.obj);
    const site = bestSite(meta, p.prop);
    const vtype = valueTypeOf(p.prop);
    if (vtype) {
      if (ASSET_PROPS.has(p.prop)) {
        const value = saveValue(p);
        if (!site || value == null) { unsaved.push(`${nameOf(p.obj)} (${p.prop === "parent" ? "the line that adds it to its parent" : p.prop})`); continue; }
        siteEdits.set(site.id, { siteId: site.id, value, valueType: vtype });
        plan.push({ key, target: site.id });
        continue;
      }
      if (site) {
        siteEdits.set(site.id, { siteId: site.id, value: p.current, valueType: vtype });
        plan.push({ key, target: site.id });
      } else if (meta && meta.declId && INSERT_GROUP[p.prop]) {
        const kind = INSERT_GROUP[p.prop];
        inserts.set(`${meta.declId}:${kind}`, { declId: meta.declId, kind, value: p.current, obj: p.obj, type: typeOf(p.obj) });
        plan.push({ key, target: meta.declId });
      } else {
        unsaved.push(nameOf(p.obj));
      }
      continue;
    }
    const delta = (p.current - p.original) * (site && site.factor ? site.factor : 1);
    if (site) {
      const isVec = site.comp != null;
      let e = siteEdits.get(site.id);
      if (!e) { e = { siteId: site.id, deltas: isVec ? [0, 0] : [0] }; siteEdits.set(site.id, e); }
      e.deltas[isVec ? site.comp : 0] = delta;
      plan.push({ key, target: site.id });
    } else if (meta && meta.declId) {
      const group = INSERT_GROUP[p.prop];
      const ik = `${meta.declId}:${group}`;
      const o = p.obj;
      const values =
        group === "position" ? [o.x, o.y]
        : group === "scale" ? [o.scale.x, o.scale.y]
        : group === "pivot" ? [o.pivot.x, o.pivot.y]
        : group === "anchor" ? [o.anchor.x, o.anchor.y]
        : [propDef(p.prop).get(o)];
      inserts.set(ik, { declId: meta.declId, kind: group, values, obj: o, type: typeOf(o) });
      plan.push({ key, target: meta.declId });
    } else {
      unsaved.push(nameOf(p.obj));
    }
  }

  // Components: edit, remove or add `addComponent(...)` lines.
  for (const c of compChanges()) {
    const meta = metaOf(c.obj);
    const kind = `component:${c.type}`;
    const site = meta && meta.sites[kind];
    if (site && c.current) { siteEdits.set(site.id, { siteId: site.id, params: c.current }); compPlan.push({ c, target: site.id }); }
    else if (site && !c.current) { siteEdits.set(site.id, { siteId: site.id, remove: true }); compPlan.push({ c, target: site.id, removed: kind }); }
    else if (!site && c.current && meta && meta.declId) {
      inserts.set(`${meta.declId}:${kind}`, { declId: meta.declId, kind, params: c.current, obj: c.obj });
      compPlan.push({ c, target: meta.declId });
      if (c.type === "Anchor") {
        const appDecl = state.pe.appDecls && state.pe.appDecls.get(state.app);
        if (appDecl) inserts.set(`${appDecl.declId}:useApp`, { declId: appDecl.declId, kind: "useApp" });
      }
    } else if (!site && !c.current) {
      state.compOriginal.delete(`${uid(c.obj)}:${c.type}`); // added and removed again: nothing to save
    } else {
      unsaved.push(`${nameOf(c.obj)} (${c.type})`);
    }
  }

  return { siteEdits, inserts, unsaved, plan, compPlan };
}

/** Saves, after showing the review dialog unless the user turned it off. */
function save() {
  if (!pendingCount()) return;
  if (reviewEnabled()) openReview();
  else saveNow();
}

async function saveNow({ reviewed = false } = {}) {
  if (!pendingCount()) return;
  const parentMsgs = await saveParents(reviewed);
  if (parentMsgs === null) { setStatus("Save canceled"); return; }
  const orderMsgs = await saveOrders();
  parentMsgs.push(...orderMsgs);
  parentMsgs.files.push(...orderMsgs.files);
  if (!pendingCount()) {
    if (parentMsgs.length) setStatus(parentMsgs.join(" · "), "err");
    else setStatus(`Saved to ${[...new Set(parentMsgs.files)].join(", ")}`, "ok");
    renderInspector();
    return;
  }
  const { siteEdits, inserts, unsaved, plan, compPlan } = buildSave();

  // Lines shared by several objects (loops, helpers): confirm before changing all of them.
  const shared = [...siteEdits.keys()].filter((id) => (state.pe.siteUse.get(id) || 0) > 1);
  if (shared.length && !reviewed) {
    const n = Math.max(...shared.map((id) => state.pe.siteUse.get(id)));
    if (!window.confirm(`${shared.length} of these code lines create or move several objects (up to ${n}). Saving changes all of them. Save anyway?`)) {
      setStatus("Save canceled");
      return;
    }
  }

  setStatus("Saving…");
  let res;
  try {
    const r = await fetch("/__pixi-editor/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteEdits: [...siteEdits.values()],
        inserts: [...inserts.values()].map(({ obj, ...rest }) => rest),
      }),
    });
    res = await r.json();
  } catch (err) {
    setStatus(`Save failed: ${err}`, "err");
    return;
  }

  // New lines become the site for that property.
  for (const ins of res.inserted || []) {
    for (const i of inserts.values()) if (i.obj && i.declId === ins.declId && i.kind === ins.kind) state.pe.s(i.obj, ins.kind, ins.siteId);
  }
  const done = new Set([...(res.applied || []), ...(res.inserted || []).map((i) => i.declId)]);
  for (const { key, target } of plan) if (done.has(target)) state.pending.delete(key);
  // Values that can never be saved (computed by code): undo them so the game matches the code again.
  const failed = new Set(res.failed || []);
  for (const { key, target } of plan) {
    const rec = state.pending.get(key);
    if (!rec || !failed.has(target)) continue;
    setLive(rec.obj, { [rec.prop]: rec.original });
    state.pending.delete(key);
  }
  for (const { c, target, removed } of compPlan) {
    if (!done.has(target)) continue;
    const rec = state.compOriginal.get(`${uid(c.obj)}:${c.type}`);
    if (rec) rec.original = c.current ? { ...c.current } : null;
    if (removed) { const m = metaOf(c.obj); if (m) delete m.sites[removed]; }
  }
  state.info.clear();
  updateSaveButton();
  renderInspector();

  const msgs = [...parentMsgs, ...(res.errors || [])];
  if (unsaved.length) msgs.push(`No code line for: ${[...new Set(unsaved)].join(", ")}`);
  if (failed.size) msgs.push("those values were reverted");
  if (msgs.length) setStatus(msgs.join(" · "), "err");
  else {
    const saved = `Saved to ${[...new Set([...parentMsgs.files, ...res.files])].join(", ")}`;
    const spineSaved = plan.some((x) => x.key.endsWith(":spine") && done.has(x.target));
    // The spine preview replaced the object, so the game's code still points at the old one:
    // reload so the game runs with the new skeleton (only when nothing is left unsaved).
    if (spineSaved && !pendingCount()) {
      state.afterReload = `${saved} — game reloaded with the new spine`;
      setStatus(`${saved} — reloading the game…`, "ok");
      iframe.contentWindow.location.reload();
    } else setStatus(`${saved}${spineSaved ? " — press Reload to run the game with the new spine" : ""}`, "ok");
  }
  state.treeSig = "";
}

// ---------------------------------------------------------------- review changes before saving
const REVIEW_KEY = "pixi-editor:review";
function reviewEnabled() {
  try { return localStorage.getItem(REVIEW_KEY) !== "off"; } catch { return true; }
}
const PROP_LABEL = {
  x: "x", y: "y", scaleX: "scale x", scaleY: "scale y", rotation: "rotation", alpha: "alpha",
  pivotX: "pivot x", pivotY: "pivot y", anchorX: "anchor x", anchorY: "anchor y", text: "text", label: "name",
  tint: "tint", textFill: "text color", texture: "texture", parent: "parent", spine: "spine", order: "draw order",
  animation: "animation", fontFamily: "font", fontSize: "font size", fontWeight: "weight", fontStyle: "style", align: "align",
  letterSpacing: "letter spacing", lineHeight: "line height",
};
function showValue(prop, v) {
  if (prop === "rotation") return `${fmtNum((v * 180) / Math.PI, 1)}°`;
  if (typeof v === "number") return VALUE_TYPE[prop] === "color" || prop.startsWith("gfill:") ? toHex(v) : fmtNum(v);
  if (prop === "texture") return textureKeys(v)[0] || "(texture)";
  if (prop === "parent") return v ? nameOf(v) : "—";
  if (prop === "spine") return v ? baseName(JSON.parse(v).skeleton[0]) : "as in the code";
  if (prop === "order") return `#${v + 1}`;
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 39) + "…" : v);
  return String(v);
}
/** Puts one pending change back to its original value. */
function discardChange(item) {
  if (item.rec) {
    const r = item.rec;
    if (r.prop === "parent") revertMove(r);
    else { setLive(r.obj, { [r.prop]: r.original }); state.pending.delete(item.key); }
  } else {
    const snap = compSnapshot(item.c.obj);
    if (item.c.original) snap[item.c.type] = { ...item.c.original }; else delete snap[item.c.type];
    compRestore(item.c.obj, snap);
  }
  afterChange();
  renderInspector();
}

/** Draws file diffs (from the server: [{ file, hunks }]) into `box`. */
function renderDiffs(box, diffs) {
  for (const d of diffs || []) {
    if (!d.hunks.length) continue;
    const file = document.createElement("div");
    file.className = "diff-file";
    const head = document.createElement("b");
    head.textContent = d.file;
    file.appendChild(head);
    for (const h of d.hunks) {
      const hunk = document.createElement("div");
      hunk.className = "diff-hunk";
      let o = h.oldStart, n = h.newStart;
      for (const l of h.lines) {
        const line = document.createElement("div");
        line.className = "diff-line" + (l.t === "+" ? " add" : l.t === "-" ? " del" : "");
        line.innerHTML = `<span class="ln"></span><span class="ln"></span><span class="sign"></span><span class="code"></span>`;
        const [lo, ln, sign, codeEl] = line.children;
        lo.textContent = l.t === "+" ? "" : o;
        ln.textContent = l.t === "-" ? "" : n;
        sign.textContent = l.t === " " ? "" : l.t;
        codeEl.textContent = l.s;
        if (l.t !== "+") o++;
        if (l.t !== "-") n++;
        hunk.appendChild(line);
      }
      file.appendChild(hunk);
    }
    box.appendChild(file);
  }
}

let reviewToken = 0;
async function openReview() {
  const modal = $("#review-modal");
  const list = $("#review-changes");
  const diffBox = $("#review-diff");
  const toggle = $("#review-toggle");
  toggle.checked = true;
  toggle.parentElement.style.display = "";
  $("#review-title").textContent = "Review changes";
  $("#review-save").textContent = "Save to code";
  $("#review-cancel").textContent = "Keep editing";
  modal.classList.remove("hidden");
  const close = () => { modal.classList.add("hidden"); window.removeEventListener("keydown", onKeyReview, true); };
  const onKeyReview = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
    if (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s")) { e.stopPropagation(); e.preventDefault(); $("#review-save").click(); }
  };
  window.addEventListener("keydown", onKeyReview, true);
  $("#review-cancel").onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  toggle.onchange = () => { try { localStorage.setItem(REVIEW_KEY, toggle.checked ? "on" : "off"); } catch { /* private mode */ } };
  $("#review-save").onclick = () => { close(); saveNow({ reviewed: true }); };

  const refresh = async () => {
    const token = ++reviewToken;
    if (!pendingCount()) { close(); setStatus("Nothing to save"); return; }
    // Left: the changes, each with Discard.
    const items = [
      ...[...state.pending].map(([key, rec]) => ({ key, rec, obj: rec.obj })),
      ...compChanges().map((c) => ({ c, obj: c.obj })),
    ];
    list.innerHTML = "";
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "change";
      row.innerHTML = `<div class="what"><span class="obj"></span><span class="val"></span></div><button class="ghost">Discard</button>`;
      if (it.rec) {
        row.querySelector(".obj").textContent = `${nameOf(it.obj)} · ${PROP_LABEL[it.rec.prop] || it.rec.prop.replace(/^gfill:(\d+)$/, (_, n) => `fill ${+n + 1}`)}`;
        row.querySelector(".val").textContent = `${showValue(it.rec.prop, it.rec.original)} → ${showValue(it.rec.prop, it.rec.current)}`;
      } else {
        row.querySelector(".obj").textContent = `${nameOf(it.obj)} · ${it.c.type}`;
        row.querySelector(".val").textContent = !it.c.original ? "added" : !it.c.current ? "removed" : "changed";
      }
      row.querySelector("button").onclick = () => { discardChange(it); refresh(); };
      list.appendChild(row);
    }
    $("#review-sub").textContent = `${items.length} change${items.length > 1 ? "s" : ""}`;
    // Right: what the code will look like.
    diffBox.innerHTML = `<p class="note" style="padding:10px">Computing the changes…</p>`;
    const { siteEdits, inserts, unsaved } = buildSave();
    let res;
    try {
      res = await (await fetch("/__pixi-editor/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteEdits: [...siteEdits.values()], inserts: [...inserts.values()].map(({ obj, ...rest }) => rest) }),
      })).json();
    } catch (err) {
      res = { diffs: [], errors: [`Preview failed: ${err}`] };
    }
    // Draw order changes are written one by one: preview each.
    for (const rec of [...state.pending.values()].filter((r) => r.prop === "order")) {
      const req = orderRequest(rec.obj);
      if (!req) { (res.errors = res.errors || []).push(`${nameOf(rec.obj)}: the line that adds it to its parent wasn't found`); continue; }
      try {
        const r = await (await fetch("/__pixi-editor/api/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...req, dryRun: true }) })).json();
        if (r.ok) res.diffs = [...(res.diffs || []), ...r.diffs.map((d) => ({ ...d, file: `${d.file} — order of ${nameOf(rec.obj)}` }))];
        else (res.errors = res.errors || []).push(`${nameOf(rec.obj)}: ${r.error}`);
      } catch { /* shown on save */ }
    }
    if (token !== reviewToken) return;
    diffBox.innerHTML = "";
    const msg = (text, cls = "") => { const p = document.createElement("div"); p.className = `review-msg ${cls}`; p.textContent = text; list.appendChild(p); };
    for (const e of res.errors || []) msg(e, "err");
    if (unsaved.length) msg(`Can't be saved (no code line): ${[...new Set(unsaved)].join(", ")}`, "err");
    const shared = [...siteEdits.keys()].filter((id) => (state.pe.siteUse.get(id) || 0) > 1);
    if (shared.length) msg(`${shared.length} of these lines create or move several objects (up to ${Math.max(...shared.map((id) => state.pe.siteUse.get(id)))}): the change applies to all of them.`);
    for (const f of res.newFiles || []) msg(`New file: ${f} (the components module).`);
    renderDiffs(diffBox, res.diffs);
    if (!diffBox.children.length) diffBox.innerHTML = `<p class="note" style="padding:10px">No code changes.</p>`;
  };
  await refresh();
}

// ---------------------------------------------------------------- viewport: drawing
function resizeGizmo() {
  const dpr = window.devicePixelRatio || 1;
  gizmo.width = Math.round(overlay.clientWidth * dpr);
  gizmo.height = Math.round(overlay.clientHeight * dpr);
}
new ResizeObserver(resizeGizmo).observe(overlay);

function rectOf(o) {
  const b = boundsOf(o);
  if (!b) return null;
  const a = globalToOverlay(b.minX, b.minY), z = globalToOverlay(b.maxX, b.maxY);
  return { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
}

// ---------------------------------------------------------------- pivot / anchor
/** Sprites and texts move their origin with `anchor` (0–1); everything else with `pivot` (pixels). */
const usesAnchor = (o) => !!(o.anchor && typeof o.anchor.x === "number");
const pivotProps = (o) => (usesAnchor(o) ? ["anchorX", "anchorY"] : ["pivotX", "pivotY"]);

/** Changes pivot/anchor values while keeping the object where it is on screen. */
function applyKeepingPlace(o, vals) {
  const b0 = boundsOf(o);
  setLive(o, vals);
  const b1 = boundsOf(o);
  if (!b0 || !b1 || !o.parent) return;
  const l0 = o.parent.toLocal({ x: b0.minX, y: b0.minY });
  const l1 = o.parent.toLocal({ x: b1.minX, y: b1.minY });
  moveTo(o, o.x + (l0.x - l1.x), o.y + (l0.y - l1.y));
}
/** Puts the origin at local point `lp` (in the object's own coordinates). */
function setPivotPoint(o, lp) {
  if (usesAnchor(o)) {
    const lb = o.getLocalBounds();
    if (lb.width <= 0 || lb.height <= 0) return;
    // Local bounds already include the current anchor offset.
    const ax = (lp.x - lb.minX) / lb.width;
    const ay = (lp.y - lb.minY) / lb.height;
    applyKeepingPlace(o, { anchorX: Number(ax.toFixed(3)), anchorY: Number(ay.toFixed(3)) });
  } else {
    applyKeepingPlace(o, { pivotX: Math.round(lp.x), pivotY: Math.round(lp.y) });
  }
}
/** Sets the origin to a fraction of the object's bounds (0,0 = top-left, 0.5,0.5 = center). */
function setPivotFraction(o, fx, fy) {
  const before = readVals(o, [...pivotProps(o), "x", "y"]);
  const compBefore = compSnapshot(o);
  if (usesAnchor(o)) applyKeepingPlace(o, { anchorX: fx, anchorY: fy });
  else {
    const lb = o.getLocalBounds();
    applyKeepingPlace(o, { pivotX: Math.round(lb.minX + fx * lb.width), pivotY: Math.round(lb.minY + fy * lb.height) });
  }
  commitPivot(o, before, compBefore);
}
function commitPivot(o, before, compBefore) {
  const props = pivotProps(o);
  if (getComp(o, "Anchor")) {
    // Position is owned by the Anchor component: save the pivot plus the component offset.
    const b = {}, a = {};
    for (const p of props) { b[p] = before[p]; a[p] = propDef(p).get(o); }
    commit(o, b, a, compBefore, compSnapshot(o));
  } else {
    commit(o, before, readVals(o, [...props, "x", "y"]));
  }
}

const HANDLE_GAP = 22;
function handlesOf(r) {
  // Tiny objects get no scale corners: they would cover the whole object and block moving it.
  const small = r.w < 24 || r.h < 24;
  return {
    corners: small ? [] : [
      { id: "nw", x: r.x, y: r.y, cursor: "nwse-resize" },
      { id: "ne", x: r.x + r.w, y: r.y, cursor: "nesw-resize" },
      { id: "sw", x: r.x, y: r.y + r.h, cursor: "nesw-resize" },
      { id: "se", x: r.x + r.w, y: r.y + r.h, cursor: "nwse-resize" },
    ],
    rotate: { id: "rotate", x: r.x + r.w / 2, y: r.y - HANDLE_GAP, cursor: "crosshair" },
  };
}
/** Which gizmo handle of the selected object is under the overlay point, if any. */
function handleAt(pt) {
  const sel = state.selected;
  if (!sel || sel.destroyed || state.mode !== "edit") return null;
  const r = rectOf(sel);
  if (!r) return null;
  if (state.tool === "pivot") {
    // Pivot tool: grab the origin anywhere inside the object (or right on it).
    const o = originOf(sel);
    const inside = pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
    return inside || Math.hypot(pt.x - o.x, pt.y - o.y) <= 8 ? { id: "pivot", x: o.x, y: o.y, cursor: "crosshair" } : null;
  }
  const hs = handlesOf(r);
  for (const h of [hs.rotate, ...hs.corners]) if (Math.abs(pt.x - h.x) <= 7 && Math.abs(pt.y - h.y) <= 7) return h;
  return null;
}
function originOf(o) {
  const gp = o.getGlobalPosition();
  return globalToOverlay(gp.x, gp.y);
}
/** Dashed line from the anchored screen edge to the object. */
function drawAnchorGuide(o) {
  const a = getComp(o, "Anchor");
  const s = state.app.screen;
  const ex = a.params.h === "left" ? 0 : a.params.h === "center" ? s.width / 2 : s.width;
  const ey = a.params.v === "top" ? 0 : a.params.v === "middle" ? s.height / 2 : s.height;
  const e = globalToOverlay(ex, ey), p = originOf(o);
  ctx.save();
  ctx.strokeStyle = "rgba(245,176,74,0.9)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(p.x, p.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(245,176,74,0.9)";
  ctx.beginPath(); ctx.arc(e.x, e.y, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function draw() {
  requestAnimationFrame(draw);
  // In Edit mode the game's ticker is stopped; keep drawing so async changes (loaded scenes) still show.
  if (state.app && state.mode === "edit" && !state.stopped) render();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, gizmo.width, gizmo.height);
  if (!state.app || state.mode !== "edit") return;

  // Game canvas outline
  const s = state.app.screen;
  const c0 = globalToOverlay(0, 0), c1 = globalToOverlay(s.width, s.height);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(c0.x + 0.5, c0.y + 0.5, c1.x - c0.x - 1, c1.y - c0.y - 1);

  if (state.hover && state.hover !== state.selected) {
    const r = rectOf(state.hover);
    if (r) {
      ctx.strokeStyle = "rgba(96,165,250,0.8)";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
      ctx.setLineDash([]);
    }
  }
  const sel = state.selected;
  if (sel && !sel.destroyed) {
    const r = rectOf(sel);
    if (r) {
      ctx.strokeStyle = "#ff4f8b";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // Scale handles (corners) and rotation handle (above the top edge)
      const hs = handlesOf(r);
      if (state.tool === "move") {
        ctx.strokeStyle = "#ff4f8b";
        ctx.beginPath(); ctx.moveTo(hs.rotate.x, r.y); ctx.lineTo(hs.rotate.x, hs.rotate.y + 5); ctx.stroke();
        for (const h of hs.corners) {
          ctx.fillStyle = "#fff"; ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
          ctx.strokeStyle = "#ff4f8b"; ctx.strokeRect(h.x - 4 + 0.5, h.y - 4 + 0.5, 7, 7);
        }
        ctx.beginPath(); ctx.arc(hs.rotate.x, hs.rotate.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#ff4f8b"; ctx.stroke();
      } else {
        // Pivot tool: 3×3 snap points (Shift snaps to them while dragging)
        ctx.fillStyle = "rgba(94,234,212,0.55)";
        for (const fy of [0, 0.5, 1]) for (const fx of [0, 0.5, 1]) ctx.fillRect(r.x + fx * r.w - 2, r.y + fy * r.h - 2, 4, 4);
      }
      if (getComp(sel, "Anchor")) drawAnchorGuide(sel);
      // Label with name and position
      const label = `${nameOf(sel)}  ${fmtNum(sel.x)}, ${fmtNum(sel.y)}`;
      ctx.font = "11px ui-monospace, Menlo, monospace";
      const w = ctx.measureText(label).width + 10;
      const ly = r.y - 44 < 2 ? r.y + r.h + 8 : r.y - 44;
      ctx.fillStyle = "rgba(20,22,26,0.92)";
      ctx.fillRect(r.x, ly, w, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, r.x + 5, ly + 12);
      // Object origin (pivot / anchor point): drag it to move the pivot
      const p = originOf(sel);
      const big = state.tool === "pivot" ? 7 : 5;
      ctx.beginPath(); ctx.arc(p.x, p.y, big, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(20,22,26,0.85)"; ctx.fill();
      ctx.strokeStyle = "#5eead4"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y);
      ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
      ctx.lineWidth = 1; ctx.stroke();
    }
  }
  if (state.drag && state.drag.axis) {
    const d = state.drag;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    if (d.axis === "x") { ctx.moveTo(0, d.startPt.y); ctx.lineTo(overlay.clientWidth, d.startPt.y); }
    else { ctx.moveTo(d.startPt.x, 0); ctx.lineTo(d.startPt.x, overlay.clientHeight); }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
requestAnimationFrame(draw);

// ---------------------------------------------------------------- viewport: mouse
overlay.addEventListener("pointermove", (e) => {
  if (!state.app) return;
  const pt = eventPoint(e);
  if (state.pan) {
    state.view.x = state.pan.vx + (pt.x - state.pan.x);
    state.view.y = state.pan.vy + (pt.y - state.pan.y);
    applyView();
    return;
  }
  const d = state.drag;
  if (d) {
    let dx = pt.x - d.startPt.x, dy = pt.y - d.startPt.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    overlay.classList.add("dragging");
    if (d.type === "move") {
      if (e.shiftKey) { d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y"; } else d.axis = null;
      if (d.axis === "x") dy = 0;
      if (d.axis === "y") dx = 0;
      const g0 = overlayToGlobal(d.startPt.x, d.startPt.y);
      const g1 = overlayToGlobal(d.startPt.x + dx, d.startPt.y + dy);
      const parent = d.obj.parent;
      const l0 = parent.toLocal(g0), l1 = parent.toLocal(g1);
      moveTo(d.obj, Math.round(d.before.x + (l1.x - l0.x)), Math.round(d.before.y + (l1.y - l0.y)));
      renderComponentValues();
    } else if (d.type === "scale") {
      const v0 = { x: d.startPt.x - d.origin.x, y: d.startPt.y - d.origin.y };
      const v1 = { x: pt.x - d.origin.x, y: pt.y - d.origin.y };
      let kx, ky;
      if (e.shiftKey) {
        // Free scale: each axis follows the pointer.
        kx = Math.abs(v0.x) > 4 ? v1.x / v0.x : 1;
        ky = Math.abs(v0.y) > 4 ? v1.y / v0.y : 1;
      } else {
        const len0 = v0.x * v0.x + v0.y * v0.y || 1;
        kx = ky = (v1.x * v0.x + v1.y * v0.y) / len0;
      }
      const clamp = (k) => Math.max(0.01, k); // dragging past the origin doesn't flip the object
      setLive(d.obj, {
        scaleX: Number((d.before.scaleX * clamp(kx)).toFixed(3)),
        scaleY: Number((d.before.scaleY * clamp(ky)).toFixed(3)),
      });
    } else if (d.type === "pivot") {
      let g = overlayToGlobal(pt.x, pt.y);
      const o = d.obj;
      const lb = o.getLocalBounds();
      let lp = o.toLocal(g);
      if (e.shiftKey && lb.width > 0 && lb.height > 0) {
        // Snap to the 3×3 grid of the object's bounds (corners, edge centers, center).
        const sx = Math.round(((lp.x - lb.minX) / lb.width) * 2) / 2;
        const sy = Math.round(((lp.y - lb.minY) / lb.height) * 2) / 2;
        lp = { x: lb.minX + sx * lb.width, y: lb.minY + sy * lb.height };
      }
      setPivotPoint(o, lp);
    } else if (d.type === "rotate") {
      const a0 = Math.atan2(d.startPt.y - d.origin.y, d.startPt.x - d.origin.x);
      const a1 = Math.atan2(pt.y - d.origin.y, pt.x - d.origin.x);
      let deg = ((d.before.rotation + a1 - a0) * 180) / Math.PI;
      deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10;
      setLive(d.obj, { rotation: (deg * Math.PI) / 180 });
    }
    refreshInspectorValues();
    return;
  }
  const h = handleAt(pt);
  if (h) { overlay.style.cursor = h.cursor; state.hover = null; return; }
  overlay.style.cursor = state.spaceDown ? "grab" : "";
  const g = overlayToGlobal(pt.x, pt.y);
  state.hover = pick(g.x, g.y);
  overlay.classList.toggle("over-object", !!state.hover && state.hover === state.selected);
});
overlay.addEventListener("pointerleave", () => { state.hover = null; });
overlay.addEventListener("pointerdown", (e) => {
  if (!state.app) return;
  overlay.focus();
  const pt = eventPoint(e);
  // Pan: middle button, or Space + drag.
  if (e.button === 1 || (e.button === 0 && state.spaceDown)) {
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    state.pan = { x: pt.x, y: pt.y, vx: state.view.x, vy: state.view.y };
    overlay.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;
  const h = handleAt(pt);
  if (h) {
    const o = state.selected;
    overlay.setPointerCapture(e.pointerId);
    if (h.id === "pivot") {
      const props = pivotProps(o);
      state.drag = { type: "pivot", obj: o, startPt: pt, moved: false, before: readVals(o, [...props, "x", "y"]), compBefore: compSnapshot(o) };
      return;
    }
    state.drag = {
      type: h.id === "rotate" ? "rotate" : "scale",
      obj: o, startPt: pt, origin: originOf(o), moved: false,
      before: readVals(o, ["scaleX", "scaleY", "rotation"]),
    };
    return;
  }
  const g = overlayToGlobal(pt.x, pt.y);
  // Pressing inside the current selection drags it, even if something else is on top
  // (a click without dragging still selects the top-most object, on pointerup).
  const sel = state.selected;
  const sb = sel && !e.altKey && state.tool === "move" ? boundsOf(sel) : null;
  if (sb && g.x >= sb.minX && g.x <= sb.maxX && g.y >= sb.minY && g.y <= sb.maxY && sel.parent) {
    overlay.setPointerCapture(e.pointerId);
    state.drag = { type: "move", obj: sel, startPt: pt, before: readVals(sel, ["x", "y"]), compBefore: compSnapshot(sel), moved: false, axis: null, clickPick: g };
    return;
  }
  let target;
  if (e.altKey) {
    // Alt+click: cycle through the objects stacked under the pointer.
    const all = pickAll(g.x, g.y);
    const i = all.indexOf(state.selected);
    target = all.length ? all[(i + 1) % all.length] : null;
    if (all.length > 1) setStatus(`${all.indexOf(target) + 1} of ${all.length} objects here — Alt+click again for the next one`);
  } else {
    target = pick(g.x, g.y);
  }
  select(target);
  if (target && target.parent) {
    overlay.setPointerCapture(e.pointerId);
    state.drag = { type: "move", obj: target, startPt: pt, before: readVals(target, ["x", "y"]), compBefore: compSnapshot(target), moved: false, axis: null };
  }
});
overlay.addEventListener("pointerup", (e) => {
  try { overlay.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (state.pan) { state.pan = null; overlay.style.cursor = state.spaceDown ? "grab" : ""; return; }
  const d = state.drag;
  state.drag = null;
  overlay.classList.remove("dragging");
  if (d && !d.moved && d.clickPick) { select(pick(d.clickPick.x, d.clickPick.y)); return; }
  if (!d || !d.moved) return;
  if (d.type === "move") {
    if (getComp(d.obj, "Anchor")) commit(d.obj, {}, {}, d.compBefore, compSnapshot(d.obj));
    else commit(d.obj, d.before, readVals(d.obj, ["x", "y"]));
  } else if (d.type === "pivot") {
    commitPivot(d.obj, d.before, d.compBefore);
  } else {
    commit(d.obj, d.before, readVals(d.obj, Object.keys(d.before)));
  }
});
overlay.addEventListener("auxclick", (e) => e.preventDefault());

// ---------------------------------------------------------------- keyboard
function setTool(tool) {
  state.tool = tool;
  $("#tool-move").classList.toggle("active", tool === "move");
  $("#tool-pivot").classList.toggle("active", tool === "pivot");
  if (state.app) setStatus(tool === "pivot" ? "Pivot tool — drag inside the object to place its origin (Shift snaps to corners/center)" : "Move tool — drag to move, corners scale, top handle rotates");
}
$("#tool-move").onclick = () => setTool("move");
$("#tool-pivot").onclick = () => setTool("pivot");

function onKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
  if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); setMode(state.mode === "edit" ? "play" : "edit"); return; }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); treeSearch.focus(); treeSearch.select(); return; }
  if (mod && e.key.toLowerCase() === "d" && state.mode === "edit" && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) { e.preventDefault(); duplicateSelected(); return; }
  if (state.mode !== "edit") return;
  const inInput = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
  if (mod && e.key.toLowerCase() === "z" && !inInput) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y" && !inInput) { e.preventDefault(); redo(); return; }
  if (inInput) return;
  if (e.key === " " && !e.repeat) { state.spaceDown = true; overlay.style.cursor = "grab"; e.preventDefault(); return; }
  if (e.key === "Escape") { select(null); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && state.selected) { e.preventDefault(); deleteSelected(); return; }
  if (!mod && (e.key === "f" || e.key === "F")) { zoomFit(); return; }
  if (!mod && (e.key === "v" || e.key === "V")) { setTool("move"); return; }
  if (!mod && (e.key === "p" || e.key === "P")) { setTool("pivot"); return; }
  if (!mod && e.key === "0") { zoomReset(); return; }
  if (!mod && (e.key === "m" || e.key === "M")) { muteBtn.click(); return; }
  if (!mod && (e.key === "+" || e.key === "=")) { zoomBy(1.25); return; }
  if (!mod && (e.key === "-" || e.key === "_")) { zoomBy(1 / 1.25); return; }
  const sel = state.selected;
  const step = e.shiftKey ? 10 : 1;
  const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (sel && arrows[e.key]) {
    e.preventDefault();
    const before = readVals(sel, ["x", "y"]);
    const compBefore = compSnapshot(sel);
    moveTo(sel, before.x + arrows[e.key][0], before.y + arrows[e.key][1]);
    if (getComp(sel, "Anchor")) commit(sel, {}, {}, compBefore, compSnapshot(sel));
    else commit(sel, before, readVals(sel, ["x", "y"]));
  }
}
window.addEventListener("keydown", onKey);
window.addEventListener("keyup", (e) => { if (e.key === " ") { state.spaceDown = false; if (!state.pan) overlay.style.cursor = ""; } });
window.addEventListener("beforeunload", (e) => { if (pendingCount() && !state.stopped) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- selection
function select(o) {
  if (state.selected === o) return;
  state.selected = o;
  if (o) { state.fileView = null; for (const r of document.querySelectorAll("#files .file.selected")) r.classList.remove("selected"); filesState.selected = null; }
  markLinkedFile(o);
  if (o) { let p = o.parent; while (p) { state.expanded.add(p); p = p.parent; } }
  renderTree(true); // rebuilds only if expanding changed the tree; otherwise just moves the highlight
  renderInspector();
}

// ---------------------------------------------------------------- hierarchy
const MAX_CHILDREN = 150;
/** Objects whose name or type matches the hierarchy search, plus their ancestors (null = no search). */
function treeFilter() {
  const q = state.treeQuery.trim().toLowerCase();
  if (!q || !state.app) return null;
  const matches = [];
  const keep = new Set();
  (function walk(o) {
    for (const c of o.children) {
      if (nameOf(c).toLowerCase().includes(q) || typeOf(c).toLowerCase() === q) {
        matches.push(c);
        for (let p = c; p && !keep.has(p); p = p.parent) keep.add(p);
      }
      walk(c);
    }
  })(state.app.stage);
  keep.add(state.app.stage);
  return { q, matches, keep };
}

function treeSignature() {
  if (!state.app) return "none";
  const parts = [state.treeQuery];
  (function walk(o) {
    parts.push(uid(o), o.children.length, o.visible ? 1 : 0, isModified(o) ? 1 : 0);
    if (state.treeQuery) { for (const c of o.children) walk(c); return; } // search: the whole scene
    if (state.expanded.has(o)) for (const c of o.children.slice(0, MAX_CHILDREN)) walk(c);
  })(state.app.stage);
  return parts.join(",");
}
function paintTreeSelection(scrollToSel = false) {
  for (const row of treeEl.querySelectorAll(".node")) {
    const on = row._obj === state.selected;
    row.classList.toggle("selected", on);
    if (on && scrollToSel) row.scrollIntoView({ block: "nearest" });
  }
}
function renderTree(scrollToSel = false) {
  if (!state.app) { treeEl.innerHTML = ""; return; }
  if (treeEl.querySelector("input.rename") || state.dragNode) return;
  const sig = treeSignature();
  if (sig === state.treeSig) { paintTreeSelection(scrollToSel); return; }
  state.treeSig = sig;
  const filter = treeFilter();
  state.treeMatches = filter ? filter.matches : [];
  $("#tree-count").textContent = filter ? `${filter.matches.length}` : "";
  const frag = document.createDocumentFragment();
  let selEl = null;
  (function add(o, depth) {
    if (filter && !filter.keep.has(o)) return;
    const row = document.createElement("div");
    row.className = "node" + (o === state.selected ? " selected" : "") + (o.visible ? "" : " hidden");
    row.style.paddingLeft = `${6 + depth * 14}px`;
    row._obj = o;
    const has = o.children.length > 0;
    const open = filter ? o.children.some((c) => filter.keep.has(c)) : state.expanded.has(o);
    if (filter && o !== state.app.stage && !filter.matches.includes(o)) row.classList.add("match-off");
    const caret = document.createElement("span");
    caret.className = "caret" + (has ? " has" : "");
    caret.textContent = has ? (open ? "▼" : "▶") : "";
    caret.onclick = (ev) => {
      ev.stopPropagation();
      if (filter) return;
      open ? state.expanded.delete(o) : state.expanded.add(o);
      state.treeSig = ""; renderTree();
    };
    const dot = document.createElement("span");
    dot.className = "dot" + (isEditable(o) ? " editable" : "");
    dot.title = isEditable(o) ? "Linked to code" : "Not linked to any code line";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = nameOf(o);
    if (filter) {
      const n = nameOf(o), i = n.toLowerCase().indexOf(filter.q);
      if (i >= 0) {
        name.textContent = "";
        const mark = document.createElement("mark");
        mark.textContent = n.slice(i, i + filter.q.length);
        name.append(n.slice(0, i), mark, n.slice(i + filter.q.length));
      }
    }
    if (isModified(o)) { const m = document.createElement("span"); m.className = "mod"; m.textContent = " •"; name.appendChild(m); }
    const type = document.createElement("span");
    type.className = "type";
    type.textContent = typeOf(o) + (has ? ` · ${o.children.length}` : "");
    const eye = document.createElement("span");
    eye.className = "eye" + (o.visible ? "" : " off");
    eye.title = o.visible ? "Hide while editing (not saved)" : "Show";
    eye.textContent = o.visible ? "◉" : "○";
    eye.onclick = (ev) => {
      ev.stopPropagation();
      o.visible = !o.visible;
      render();
      state.treeSig = "";
      renderTree();
    };
    row.append(caret, dot, name, type, eye);
    row.onclick = () => select(o === state.app.stage ? null : o);
    // Drag a row onto another to change its parent.
    if (o !== state.app.stage) {
      row.draggable = true;
      row.ondragstart = (ev) => { state.dragNode = o; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", nameOf(o)); };
      row.ondragend = () => { state.dragNode = null; treeEl.querySelectorAll(".drop").forEach((r) => r.classList.remove("drop")); };
    }
    // Top/bottom edge of a row: put it before/after that object (draw order). Middle: inside it.
    const zone = (ev) => {
      const r = row.getBoundingClientRect();
      const y = ev.clientY - r.top;
      const moving = state.dragNode;
      const edgeOk = moving && o !== state.app.stage && o !== moving && canHoldChildren(o.parent) && !isInside(o.parent, moving);
      if (edgeOk && y < r.height * 0.3) return "before";
      if (edgeOk && y > r.height * 0.7) return "after";
      if (canDropOn(moving, o)) return "into";
      return edgeOk ? (y < r.height / 2 ? "before" : "after") : null;
    };
    const clearDrop = () => row.classList.remove("drop", "drop-before", "drop-after");
    row.ondragover = (ev) => {
      const z = zone(ev);
      clearDrop();
      if (!z) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      row.classList.add(z === "into" ? "drop" : `drop-${z}`);
    };
    row.ondragleave = clearDrop;
    row.ondrop = (ev) => {
      ev.preventDefault();
      const z = zone(ev);
      clearDrop();
      const moving = state.dragNode;
      state.dragNode = null;
      if (!moving || !z) return;
      if (z === "into") reparent(moving, o);
      else placeNextTo(moving, o, z);
    };
    row.ondblclick = (ev) => {
      if (o === state.app.stage) return;
      ev.stopPropagation();
      const input = document.createElement("input");
      input.className = "rename";
      input.value = nameOf(o);
      name.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        input.remove();
        state.treeSig = "";
        if (ok) renameObject(o, value);
        renderTree();
      };
      input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
      input.onblur = () => finish(true);
    };
    frag.appendChild(row);
    if (o === state.selected) selEl = row;
    if (has && open) {
      const kids = filter ? o.children.filter((c) => filter.keep.has(c)) : o.children;
      for (const c of kids.slice(0, MAX_CHILDREN)) add(c, depth + 1);
      if (kids.length > MAX_CHILDREN) {
        const more = document.createElement("div");
        more.className = "node more";
        more.style.paddingLeft = `${6 + (depth + 1) * 14 + 18}px`;
        more.textContent = `… ${kids.length - MAX_CHILDREN} more`;
        frag.appendChild(more);
      }
    }
  })(state.app.stage, 0);
  const scroll = treeEl.scrollTop;
  treeEl.replaceChildren(frag);
  treeEl.scrollTop = scroll;
  if (scrollToSel && selEl) selEl.scrollIntoView({ block: "nearest" });
}
setInterval(() => renderTree(), 600);

// Hierarchy search: shows the matching objects with their parents. Enter selects the next match
// (and opens the path to it once the search is cleared), Escape clears.
const treeSearch = $("#tree-search");
let treeMatchIndex = -1;
treeSearch.addEventListener("input", () => {
  state.treeQuery = treeSearch.value;
  treeMatchIndex = -1;
  state.treeSig = "";
  renderTree();
});
treeSearch.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") {
    if (treeSearch.value) { treeSearch.value = ""; treeSearch.dispatchEvent(new Event("input")); }
    else treeSearch.blur();
    return;
  }
  if (e.key === "Enter" && state.treeMatches.length) {
    e.preventDefault();
    treeMatchIndex = (treeMatchIndex + (e.shiftKey ? -1 : 1) + state.treeMatches.length) % state.treeMatches.length;
    select(state.treeMatches[treeMatchIndex]);
    paintTreeSelection(true);
  }
});

// ---------------------------------------------------------------- inspector
const FIELDS = [
  { label: "Position", props: [["x", "X", 1], ["y", "Y", 1]] },
  { label: "Scale", props: [["scaleX", "X", 0.01], ["scaleY", "Y", 0.01]] },
  { label: "Rotation", props: [["rotation", "°", 0.5, "deg"]] },
  { label: "Alpha", props: [["alpha", "", 0.01, null, [0, 1]]] },
];
const fmtNum = (v, d = 2) => String(Number(v.toFixed(d)));
const toView = (prop, v) => (prop === "rotation" ? (v * 180) / Math.PI : v);
const fromView = (prop, v) => (prop === "rotation" ? (v * Math.PI) / 180 : v);

function sourceIds(o) {
  const m = metaOf(o);
  if (!m) return [];
  const ids = [];
  if (m.declId) ids.push(m.declId);
  for (const s of Object.values(m.sites).sort((a, b) => a.seq - b.seq)) if (!ids.includes(s.id)) ids.push(s.id);
  return ids;
}
async function loadInfo(ids) {
  const missing = ids.filter((id) => !state.info.has(id));
  if (!missing.length) return;
  const r = await fetch(`/__pixi-editor/api/info?ids=${missing.join(",")}`);
  const data = await r.json();
  for (const [id, v] of Object.entries(data)) state.info.set(id, v);
}

// ---------------------------------------------------------------- inspector: rows
function numberRow(o, f) {
  const row = document.createElement("div");
  row.className = "row" + (f.props.length === 1 ? " single" : "");
  const label = document.createElement("label");
  label.textContent = f.label;
  label.title = f.pivot ? "Drag to adjust — the object stays in place, its origin moves" : "Drag to adjust";
  row.appendChild(label);
  const props = f.props.map((p) => p[0]);
  for (const [prop, axis, , , range] of f.props) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.dataset.prop = prop;
    if (f.props.length > 1) { const sp = document.createElement("span"); sp.textContent = axis; wrap.appendChild(sp); }
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.dataset.prop = prop;
    let before = null;
    input.addEventListener("focus", () => { before = readVals(o, [prop]); input.select(); });
    input.addEventListener("change", () => {
      let v = parseFloat(input.value);
      if (!isFinite(v)) { refreshInspectorValues(true); return; }
      if (range) v = Math.min(range[1], Math.max(range[0], v));
      if (f.pivot) {
        const b = readVals(o, [...props, "x", "y"]);
        const cb = compSnapshot(o);
        applyKeepingPlace(o, { [prop]: v });
        commitPivot(o, b, cb);
        return;
      }
      if ((prop === "x" || prop === "y") && getComp(o, "Anchor")) {
        const compBefore = compSnapshot(o);
        const cur = readVals(o, ["x", "y"]);
        cur[prop] = v;
        moveTo(o, cur.x, cur.y);
        commit(o, {}, {}, compBefore, compSnapshot(o));
        return;
      }
      const b = before || readVals(o, [prop]);
      const after = { [prop]: fromView(prop, v) };
      setLive(o, after);
      commit(o, b, after);
      before = readVals(o, [prop]);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    wrap.appendChild(input);
    row.appendChild(wrap);
  }
  // Dragging the label scrubs the value (like in Unity).
  label.addEventListener("pointerdown", (e) => {
    const start = readVals(o, f.pivot ? [...props, "x", "y"] : props);
    const compStart = compSnapshot(o);
    const anchored = props.includes("x") && !!getComp(o, "Anchor");
    const x0 = e.clientX;
    label.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const vals = {};
      for (const [prop, , step, , range] of f.props) {
        let v = toView(prop, start[prop]) + (ev.clientX - x0) * step;
        if (range) v = Math.min(range[1], Math.max(range[0], v));
        vals[prop] = fromView(prop, step >= 1 ? Math.round(v) : Number(v.toFixed(3)));
      }
      if (f.pivot) applyKeepingPlace(o, vals);
      else if (anchored) moveTo(o, vals.x, vals.y);
      else setLive(o, vals);
      refreshInspectorValues(true);
      renderComponentValues();
    };
    const up = () => {
      label.removeEventListener("pointermove", move);
      label.removeEventListener("pointerup", up);
      if (f.pivot) commitPivot(o, start, compStart);
      else if (anchored) commit(o, {}, {}, compStart, compSnapshot(o));
      else commit(o, start, readVals(o, props));
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
  });
  return row;
}

/** 3×3 grid: put the origin at a corner, an edge center or the center (object stays in place). */
function pivotPresets(o) {
  const row = document.createElement("div");
  row.className = "row single presets-row";
  row.innerHTML = `<label title="Move the origin without moving the object">Origin</label><div class="presets"></div>`;
  const grid = row.querySelector(".presets");
  const cur = usesAnchor(o) ? { x: o.anchor.x, y: o.anchor.y } : null;
  for (const fy of [0, 0.5, 1]) {
    for (const fx of [0, 0.5, 1]) {
      const b = document.createElement("button");
      b.className = "preset" + (cur && Math.abs(cur.x - fx) < 1e-3 && Math.abs(cur.y - fy) < 1e-3 ? " on" : "");
      b.dataset.fx = fx;
      b.dataset.fy = fy;
      b.title = `${fy === 0 ? "Top" : fy === 0.5 ? "Middle" : "Bottom"} ${fx === 0 ? "left" : fx === 0.5 ? "center" : "right"}`;
      b.onclick = () => { setPivotFraction(o, fx, fy); renderInspector(); };
      grid.appendChild(b);
    }
  }
  return row;
}

function renameObject(o, name) {
  const before = { label: customLabel(o) };
  if (name === before.label || (!before.label && name === nameOf(o))) return;
  setLive(o, { label: name });
  commit(o, before, { label: name });
  state.treeSig = "";
  renderTree();
  renderInspector();
}

/** Tint, text, text color and shape fills. */
function renderAppearance(o) {
  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h4>Appearance</h4>`;
  const m = metaOf(o);
  if (isSprite(o)) sec.appendChild(textureRow(o));
  if (isSpine(o)) { sec.appendChild(spineRow(o)); sec.appendChild(animationRow(o)); }
  if (typeof o.tint === "number") sec.appendChild(colorRow(o, "tint", "Tint"));
  if ("text" in o && (typeof o.text === "string" || typeof o.text === "number")) sec.appendChild(textRow(o));
  if (o.style && colorToNumber(o.style.fill) != null) sec.appendChild(colorRow(o, "textFill", "Text color"));
  if (isTextLike(o)) for (const row of textStyleRows(o)) sec.appendChild(row);
  const fills = fillInstructions(o);
  if (m) {
    Object.keys(m.sites).filter((k) => k.startsWith("gfill:")).sort().forEach((k) => {
      const n = Number(k.slice(6));
      if (fills[n]) sec.appendChild(colorRow(o, k, fills.length > 1 ? `Fill ${n + 1}` : "Fill"));
    });
  }
  return sec;
}

function colorRow(o, prop, labelText) {
  const row = document.createElement("div");
  row.className = "row single";
  row.innerHTML = `<label></label><div class="field color-field"><input type="color"><input type="text" spellcheck="false"></div>`;
  row.querySelector("label").textContent = labelText;
  const [picker, hex] = row.querySelectorAll("input");
  picker.dataset.vprop = prop;
  hex.dataset.vprop = prop;
  hex.dataset.hex = "1";
  let before = null;
  const begin = () => { if (before == null) before = readVals(o, [prop]); };
  const apply = (n, done) => {
    begin();
    setLive(o, { [prop]: n });
    if (done) { commit(o, before, { [prop]: n }); before = null; }
    refreshInspectorValues(true);
  };
  picker.addEventListener("input", () => apply(parseInt(picker.value.slice(1), 16), false));
  picker.addEventListener("change", () => apply(parseInt(picker.value.slice(1), 16), true));
  hex.addEventListener("change", () => {
    const n = colorToNumber(hex.value.startsWith("#") || /^[0-9a-f]{6}$/i.test(hex.value) ? (hex.value.startsWith("#") ? hex.value : "#" + hex.value) : hex.value);
    if (n == null) { refreshInspectorValues(true); return; }
    apply(n, true);
  });
  hex.addEventListener("keydown", (e) => { if (e.key === "Enter") hex.blur(); });
  return row;
}

function textRow(o) {
  const row = document.createElement("div");
  row.className = "row single text-row";
  row.innerHTML = `<label>Text</label><div class="field"><textarea rows="2" spellcheck="false"></textarea></div>`;
  const ta = row.querySelector("textarea");
  ta.dataset.vprop = "text";
  let before = null;
  ta.addEventListener("focus", () => { before = readVals(o, ["text"]); });
  ta.addEventListener("input", () => setLive(o, { text: ta.value }));
  ta.addEventListener("change", () => { if (before) commit(o, before, { text: ta.value }); before = readVals(o, ["text"]); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.blur(); } });
  return row;
}

function renderInspector() {
  const o = state.selected;
  if (state.previewCleanup) { state.previewCleanup(); state.previewCleanup = null; }
  if (!o && state.fileView) { renderFileView(state.fileView); return; }
  if (!o) { inspectorEl.innerHTML = `<p class="empty">Select an object in the scene or in the hierarchy.</p>`; return; }
  inspectorEl.innerHTML = "";

  // Header: editable name (saved in the code as the object's `label`)
  const head = document.createElement("div");
  head.className = "obj-head";
  head.innerHTML = `<div class="obj-row"><input class="obj-name" spellcheck="false" title="Rename — saved as the object's label"><button class="ghost icon-btn" data-act="dup" title="Duplicate (Ctrl/Cmd+D)">⧉</button><button class="ghost icon-btn" data-act="del" title="Delete (Delete key)">🗑</button></div><div class="obj-type"></div>`;
  head.querySelector('[data-act="dup"]').onclick = () => duplicateSelected();
  head.querySelector('[data-act="del"]').onclick = () => deleteSelected();
  const nameInput = head.querySelector(".obj-name");
  nameInput.value = nameOf(o);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") nameInput.blur();
    if (e.key === "Escape") { nameInput.value = nameOf(o); nameInput.blur(); }
  });
  nameInput.addEventListener("change", () => renameObject(o, nameInput.value.trim()));
  const m0 = metaOf(o);
  const varName = m0 && m0.name && m0.name !== nameOf(o) ? ` · ${m0.name}` : "";
  head.querySelector(".obj-type").textContent = `${typeOf(o)}${varName}${o.children.length ? ` · ${o.children.length} children` : ""}`;
  inspectorEl.appendChild(head);

  // Transform
  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h4>Transform</h4>`;
  const fields = [
    ...FIELDS,
    usesAnchor(o)
      ? { label: "Anchor", pivot: true, props: [["anchorX", "X", 0.01], ["anchorY", "Y", 0.01]] }
      : { label: "Pivot", pivot: true, props: [["pivotX", "X", 1], ["pivotY", "Y", 1]] },
  ];
  for (const f of fields) sec.appendChild(numberRow(o, f));
  sec.appendChild(pivotPresets(o));
  inspectorEl.appendChild(sec);

  inspectorEl.appendChild(renderAppearance(o));
  inspectorEl.appendChild(renderComponents(o));

  // Linked code
  const code = document.createElement("div");
  code.className = "section";
  code.innerHTML = `<h4>Code</h4><div class="srcs"><p class="note">Loading…</p></div>`;
  inspectorEl.appendChild(code);
  const ids = sourceIds(o);
  if (!ids.length) {
    code.querySelector(".srcs").innerHTML = `<p class="note warn">This object is not linked to any line of code (it is probably created by a library or without its own variable). You can move it to try things out, but it cannot be saved.</p>`;
  } else {
    loadInfo(ids).then(() => {
      if (state.selected !== o) return;
      const box = code.querySelector(".srcs");
      box.innerHTML = "";
      const m = metaOf(o);
      for (const id of ids) {
        const inf = state.info.get(id);
        if (!inf) continue;
        const el = document.createElement("div");
        el.className = "src";
        const kind = id === m.declId ? "creation" : inf.kind + (Object.values(m.sites).some((x) => x.id === id && x.transient) ? " · on pointer" : "");
        el.innerHTML = `<div class="loc"><b></b><span class="kind"></span><button class="open-ide" title="Open this line in VS Code">Open ↗</button></div><code></code>`;
        el.querySelector("b").textContent = `${inf.file}:${inf.line}`;
        el.querySelector(".kind").textContent = kind;
        el.querySelector("code").textContent = inf.code;
        el.querySelector(".open-ide").onclick = () => openInIde(inf.file, inf.line, inf.col);
        el.title = "Double-click to open in VS Code";
        el.ondblclick = () => openInIde(inf.file, inf.line, inf.col);
        box.appendChild(el);
        const uses = state.pe.siteUse.get(id) || 0;
        if (uses > 1 && id !== m.declId) {
          const w = document.createElement("p");
          w.className = "note warn";
          w.textContent = `⚠ This line affects ${uses} objects: saving applies the change to all of them.`;
          box.appendChild(w);
        }
      }
      if (!m.declId || !state.info.get(m.declId)?.canInsert) {
        const missing = Object.keys(CANDIDATES).filter((p) => !ASSET_PROPS.has(p) && !OPTIONAL_PROPS.has(p) && !bestSite(m, p));
        if (missing.length && !m.declId) {
          const n = document.createElement("p");
          n.className = "note";
          n.textContent = `No line for: ${missing.join(", ")} (cannot be saved).`;
          box.appendChild(n);
        }
      }
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = "Saving adjusts the numbers on these lines; if a property has no line, one is added right after the object is created.";
      box.appendChild(n);
    });
  }
  refreshInspectorValues(true);
}

// ---------------------------------------------------------------- open code in VS Code
async function openInIde(file, line = 1, col = 1) {
  setStatus(`Opening ${file}:${line} in VS Code…`);
  try {
    const r = await (await fetch("/__pixi-editor/api/open-in-ide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, line, col }),
    })).json();
    setStatus(r.ok ? `Opened ${file}:${line}` : r.error, r.ok ? "ok" : "err");
  } catch (err) {
    setStatus(`Could not open the editor: ${err}`, "err");
  }
}

// ---------------------------------------------------------------- inspector: components
function changeComponent(o, mutate) {
  const before = compSnapshot(o);
  mutate();
  render();
  commit(o, {}, {}, before, compSnapshot(o));
}

function addComponentTo(o, type) {
  const mod = state.compMod;
  const params = { ...mod.componentTypes[type].defaults };
  changeComponent(o, () => {
    if (type === "Anchor") {
      // Stick to the nearest edges so the object stays where it is.
      const gp = o.getGlobalPosition();
      const s = state.app.screen;
      params.h = gp.x < s.width / 3 ? "left" : gp.x > (s.width * 2) / 3 ? "right" : "center";
      params.v = gp.y < s.height / 3 ? "top" : gp.y > (s.height * 2) / 3 ? "bottom" : "middle";
      const x = o.x, y = o.y;
      const c = mod.addComponent(o, mod.componentTypes.Anchor, params);
      c.setFromPosition(x, y);
    } else {
      mod.addComponent(o, mod.componentTypes[type], params);
    }
  });
  renderInspector();
}

function renderComponents(o) {
  const sec = document.createElement("div");
  sec.className = "section components";
  sec.innerHTML = `<h4>Components</h4>`;
  const mod = state.compMod;
  if (!mod) {
    sec.insertAdjacentHTML("beforeend", `<p class="note">Loading components…</p>`);
    return sec;
  }
  const changes = compChanges().filter((c) => c.obj === o);
  for (const c of compList(o)) {
    const type = compName(c);
    const schema = SCHEMAS[type];
    if (!schema) { sec.appendChild(behaviorCard(o, c, changes)); continue; }
    const card = document.createElement("div");
    card.className = "comp" + (changes.some((ch) => ch.type === type) ? " changed" : "");
    card.dataset.type = type;
    card.innerHTML = `<div class="comp-head"><span class="comp-name"></span><button class="comp-remove" title="Remove component">✕</button></div><p class="comp-help"></p>`;
    card.querySelector(".comp-name").textContent = type;
    card.querySelector(".comp-help").textContent = schema.help;
    card.querySelector(".comp-remove").onclick = () => {
      changeComponent(o, () => mod.removeComponent(o, mod.componentTypes[type]));
      renderInspector();
    };
    for (const f of schema.fields) {
      const row = document.createElement("div");
      row.className = "row single";
      const label = document.createElement("label");
      label.textContent = f.label;
      row.appendChild(label);
      const wrap = document.createElement("div");
      wrap.className = "field";
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const opt of f.options) { const el = document.createElement("option"); el.value = el.textContent = opt; input.appendChild(el); }
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
      }
      input.dataset.comp = type;
      input.dataset.key = f.key;
      input.addEventListener("change", () => {
        const comp = getComp(o, type);
        if (!comp) return;
        let v = input.value;
        if (f.type === "number") { v = parseFloat(v); if (!isFinite(v)) { renderComponentValues(); return; } }
        changeComponent(o, () => {
          const x = o.x, y = o.y;
          const next = { ...comp.params, [f.key]: v };
          if (type === "Tween" && f.key === "kind") next.amount = TWEEN_AMOUNT[v] ?? next.amount;
          comp.params = next;
          if (type === "Anchor" && (f.key === "h" || f.key === "v")) comp.setFromPosition(x, y); // keep the object in place
          else comp.apply();
        });
        renderComponentValues();
        refreshInspectorValues(true);
      });
      if (f.type === "number") {
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
        // Scrub numeric params by dragging the label.
        label.style.cursor = "ew-resize";
        label.addEventListener("pointerdown", (e) => {
          const comp = getComp(o, type);
          if (!comp) return;
          const before = compSnapshot(o);
          const start = comp.params[f.key];
          const x0 = e.clientX;
          label.setPointerCapture(e.pointerId);
          const move = (ev) => {
            let v = start + (ev.clientX - x0) * f.step;
            v = f.step >= 1 ? Math.round(v) : Number(v.toFixed(3));
            comp.params = { ...comp.params, [f.key]: v };
            comp.apply();
            render();
            renderComponentValues();
            refreshInspectorValues(true);
          };
          const up = () => {
            label.removeEventListener("pointermove", move);
            label.removeEventListener("pointerup", up);
            commit(o, {}, {}, before, compSnapshot(o));
          };
          label.addEventListener("pointermove", move);
          label.addEventListener("pointerup", up);
        });
      }
      wrap.appendChild(input);
      row.appendChild(wrap);
      card.appendChild(row);
    }
    sec.appendChild(card);
  }

  // "Add component" menu
  const present = new Set(compList(o).map(compName));
  const available = COMPONENT_TYPES.filter((t) => !present.has(t));
  const behaviors = state.behaviors.filter((b) => !present.has(b.name));
  const add = document.createElement("select");
  add.className = "comp-add";
  add.innerHTML =
    `<option value="">+ Add component…</option>` +
    (available.length ? `<optgroup label="Components">${available.map((t) => `<option value="${t}">${t}</option>`).join("")}</optgroup>` : "") +
    `<optgroup label="Behaviors (your code)">${behaviors.map((b) => `<option value="behavior:${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join("")}<option value="new">New behavior…</option></optgroup>`;
  add.onchange = async () => {
    const v = add.value;
    add.value = "";
    if (!v) return;
    // Components are saved as addComponent(variable, …): the object needs a variable in the code.
    const m = metaOf(o);
    if (m && m.declId) await loadInfo([m.declId]);
    if (!m || !m.declId || !state.info.get(m.declId)?.canInsert) {
      setStatus(`"${nameOf(o)}" isn't stored in a variable in the code, so components and behaviors can't be saved for it.`, "err");
      return;
    }
    if (v === "new") { showNewBehaviorForm(o, sec); return; }
    if (v.startsWith("behavior:")) {
      const b = state.behaviors.find((x) => x.name === v.slice(9));
      try {
        const cls = await loadBehaviorClass(b.name, b.url);
        changeComponent(o, () => state.compMod.addComponent(o, cls, {}));
        renderInspector();
      } catch (err) { setStatus(String(err.message || err), "err"); }
      return;
    }
    addComponentTo(o, v);
  };
  sec.appendChild(add);
  const removedNotes = changes.filter((c) => !c.current);
  if (removedNotes.length) sec.insertAdjacentHTML("beforeend", `<p class="note">Removed (not saved yet): ${removedNotes.map((c) => c.type).join(", ")}</p>`);
  const m = metaOf(o);
  if (!m || !m.declId) sec.insertAdjacentHTML("beforeend", `<p class="note warn">This object has no variable in the code, so components can't be added to it.</p>`);
  else loadInfo([m.declId]).then(() => {
    if (state.selected === o && !state.info.get(m.declId)?.canInsert && !sec.querySelector(".novar")) {
      sec.insertAdjacentHTML("beforeend", `<p class="note warn novar">This object isn't stored in a variable in the code, so components can't be added to it.</p>`);
    }
  });
  setTimeout(renderComponentValues);
  return sec;
}

function behaviorCard(o, c, changes) {
  const type = compName(c);
  const info = state.behaviors.find((b) => b.name === type);
  const card = document.createElement("div");
  card.className = "comp behavior" + (changes.some((ch) => ch.type === type) ? " changed" : "");
  card.dataset.type = type;
  card.innerHTML = `<div class="comp-head"><span class="comp-name"></span><span class="comp-tag">behavior</span><button class="comp-remove" title="Remove behavior from this object">✕</button></div>
    <p class="comp-help"></p><button class="ghost open-code">Open code ↗</button>`;
  card.querySelector(".comp-name").textContent = type;
  card.querySelector(".comp-help").textContent = info ? `Your code in ${info.file}. Edit it in VS Code; the game reloads when you save.` : "Custom behavior.";
  card.querySelector(".comp-remove").onclick = () => {
    changeComponent(o, () => state.compMod.removeComponent(o, c.constructor));
    renderInspector();
  };
  const open = card.querySelector(".open-code");
  if (info) open.onclick = () => openInIde(info.file, 1, 1);
  else open.remove();
  return card;
}

/** "WinAmount coin" -> "WinAmountCoin" */
function pascalCase(text) {
  const words = String(text || "").replace(/["'`]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  let name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (!name || /^[0-9]/.test(name)) name = "Behavior" + name;
  return name;
}

function showNewBehaviorForm(o, sec) {
  if (sec.querySelector(".new-behavior")) return;
  const m = metaOf(o);
  const form = document.createElement("div");
  form.className = "new-behavior";
  let suggestion = pascalCase(nameOf(o));
  if (state.behaviors.some((b) => b.name === suggestion) || COMPONENT_TYPES.includes(suggestion)) suggestion += "Behavior";
  form.innerHTML = `<p class="note">Creates <code>src/behaviors/<span class="nb-file"></span>.ts</code> with a class you can program, attaches it to this object in the code and opens it in VS Code.</p>
    <div class="nb-row"><input type="text" spellcheck="false"><button class="primary">Create</button><button class="ghost">Cancel</button></div>`;
  const input = form.querySelector("input");
  const fileSpan = form.querySelector(".nb-file");
  input.value = suggestion;
  fileSpan.textContent = suggestion;
  input.oninput = () => { fileSpan.textContent = pascalCase(input.value); };
  const [create, cancel] = form.querySelectorAll("button");
  cancel.onclick = () => form.remove();
  input.onkeydown = (e) => { if (e.key === "Enter") create.click(); if (e.key === "Escape") form.remove(); };
  create.onclick = async () => {
    const name = pascalCase(input.value);
    if (!m || !m.declId) { setStatus("This object has no variable in the code, so a behavior can't be attached to it.", "err"); return; }
    create.disabled = true;
    try {
      await createBehaviorFor(o, name);
    } finally {
      create.disabled = false;
    }
  };
  sec.appendChild(form);
  input.focus();
  input.select();
}

/** Creates the behavior file, attaches it live, writes addComponent(...) in the code and opens VS Code. */
async function createBehaviorFor(o, name) {
  const m = metaOf(o);
  setStatus(`Creating behavior ${name}…`);
  const res = await (await fetch("/__pixi-editor/api/behavior", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, objectName: nameOf(o) }),
  })).json();
  if (!res.ok) { setStatus(res.error, "err"); return; }
  if (!state.behaviors.some((b) => b.name === name)) state.behaviors.push({ name, url: res.url, file: res.file });
  let cls;
  try { cls = await loadBehaviorClass(name, res.url); } catch (err) { setStatus(String(err.message || err), "err"); return; }
  state.compMod.addComponent(o, cls, {});
  render();
  // Save just this line right away, so editing the behavior (which reloads the game) keeps it.
  const kind = `component:${name}`;
  const saved = await (await fetch("/__pixi-editor/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteEdits: [], inserts: [{ declId: m.declId, kind, params: {} }] }),
  })).json();
  const ins = (saved.inserted || []).find((i) => i.kind === kind);
  if (!ins) {
    state.compMod.removeComponent(o, cls);
    render();
    setStatus((saved.errors || []).join(" · ") || "Could not attach the behavior in the code.", "err");
    renderInspector();
    return;
  }
  state.pe.s(o, kind, ins.siteId);
  state.info.clear();
  renderInspector();
  setStatus(`Created ${res.file} and attached it to ${nameOf(o)} (${saved.files.join(", ")})`, "ok");
  openInIde(res.file, 1, 1);
}

function renderComponentValues() {
  const o = state.selected;
  if (!o) return;
  for (const input of inspectorEl.querySelectorAll("[data-comp]")) {
    if (document.activeElement === input) continue;
    const comp = getComp(o, input.dataset.comp);
    if (!comp) continue;
    const v = comp.params[input.dataset.key];
    input.value = typeof v === "number" ? fmtNum(v, 3) : String(v);
  }
  const changed = new Set(compChanges().filter((c) => c.obj === o).map((c) => c.type));
  for (const card of inspectorEl.querySelectorAll(".comp")) card.classList.toggle("changed", changed.has(card.dataset.type));
}

function refreshInspectorValues(force = false) {
  const o = state.selected;
  if (!o) return;
  if (usesAnchor(o)) {
    for (const b of inspectorEl.querySelectorAll(".preset")) {
      b.classList.toggle("on", Math.abs(o.anchor.x - b.dataset.fx) < 1e-3 && Math.abs(o.anchor.y - b.dataset.fy) < 1e-3);
    }
  }
  for (const input of inspectorEl.querySelectorAll("[data-vprop]")) {
    if (document.activeElement === input) continue;
    const prop = input.dataset.vprop;
    const v = propDef(prop).get(o);
    const txt = valueTypeOf(prop) === "color" ? toHex(v) : String(v);
    if (input.value !== txt) input.value = txt;
    input.closest(".field").classList.toggle("changed", state.pending.has(`${uid(o)}:${prop}`));
  }
  for (const input of inspectorEl.querySelectorAll("input[data-prop]")) {
    if (!force && document.activeElement === input) continue;
    if (document.activeElement === input && !force) continue;
    const prop = input.dataset.prop;
    const v = toView(prop, propDef(prop).get(o));
    const txt = fmtNum(v, prop === "x" || prop === "y" ? 2 : 3);
    if (document.activeElement !== input && input.value !== txt) input.value = txt;
    input.parentElement.classList.toggle("changed", state.pending.has(`${uid(o)}:${prop}`));
  }
}
// Keep values up to date while the game runs.
setInterval(() => { if (state.mode === "play") refreshInspectorValues(); }, 200);

// ---------------------------------------------------------------- project picker
const projectInput = $("#project-input");
const dropdown = $("#project-dropdown");
const welcome = $("#welcome");
let ddIndex = -1;
let ddItems = [];

const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, i)) + "<mark>" + escapeHtml(text.slice(i, i + query.length)) + "</mark>" + escapeHtml(text.slice(i + query.length));
}
const looksLikePath = (q) => /^(\/|~|[A-Za-z]:[\\/])/.test(q);

async function loadState() {
  const st = await (await fetch("/__pixi-editor/api/state")).json();
  state.recent = st.recent || [];
  renderWelcomeRecent();
  if (st.project) showProject(st.project, false);
}

function showProject(project, reloadGame = true) {
  const changed = !state.project || state.project.path !== project.path;
  state.project = project;
  projectInput.value = project.path;
  projectInput.title = project.path;
  document.title = `Pixi Editor — ${project.name}`;
  welcome.classList.add("hidden");
  if (changed) {
    filesState.expanded = new Set([""]);
    filesState.cache.clear();
    filesState.selected = filesState.linked = null;
    state.fileView = null;
    renderFiles();
  }
  if (changed || reloadGame) {
    state.expanded = new WeakSet();
    select(null);
    iframe.setAttribute("src", `/?pixi-editor=${Date.now()}`);
  }
  const warn = project.warnings && project.warnings.length ? ` · ${project.warnings.join(" ")}` : "";
  setStatus(`Opened ${project.name}${warn}`, warn ? "err" : "ok");
}

async function openProject(path) {
  if (!path) return;
  if (pendingCount() && !window.confirm("You have unsaved changes. Open another project anyway?")) return;
  hideDropdown();
  setStatus(`Opening ${path}…`);
  $("#welcome-error").textContent = "";
  const res = await (await fetch("/__pixi-editor/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })).json();
  if (!res.ok) {
    setStatus(res.error, "err");
    if (!state.project) $("#welcome-error").textContent = res.error;
    projectInput.value = state.project ? state.project.path : path;
    return;
  }
  state.pending.clear(); updateSaveButton();
  showProject(res.project, true);
  const st = await (await fetch("/__pixi-editor/api/state")).json();
  state.recent = st.recent || [];
  renderWelcomeRecent();
}

async function browse() {
  hideDropdown();
  setStatus("Waiting for the folder picker… (check your Dock if it is behind the browser)");
  const res = await (await fetch("/__pixi-editor/api/pick", { method: "POST" })).json();
  if (res.error) {
    setStatus(res.error, "err");
    if (!state.project) $("#welcome-error").textContent = res.error;
    return;
  }
  if (res.canceled) { setStatus(state.project ? `Project: ${state.project.name}` : "Ready"); return; }
  openProject(res.path);
}

function renderDropdown() {
  const q = projectInput.value.trim();
  const isCurrent = state.project && q === state.project.path;
  const query = isCurrent ? "" : q;
  const matches = state.recent.filter((r) => !query || r.name.toLowerCase().includes(query.toLowerCase()) || r.path.toLowerCase().includes(query.toLowerCase()));
  ddItems = [];
  let html = "";
  if (query && looksLikePath(query)) {
    ddItems.push({ action: "open", path: query });
    html += `<div class="dd-item" data-i="0"><span class="n">Open this folder</span><span class="p">${escapeHtml(query)}</span></div>`;
  }
  if (matches.length) {
    html += `<div class="dd-head">Recent projects</div>`;
    for (const r of matches) {
      const i = ddItems.length;
      ddItems.push({ action: "open", path: r.path });
      html += `<div class="dd-item" data-i="${i}"><span class="n">${highlight(r.name, query)}</span><span class="p">${highlight(r.path, query)}</span></div>`;
    }
  } else if (!ddItems.length) {
    html += `<div class="dd-empty">${state.recent.length ? "No recent project matches." : "No recent projects yet."}</div>`;
  }
  const bi = ddItems.length;
  ddItems.push({ action: "browse" });
  html += `<div class="dd-item" data-i="${bi}"><span class="n">Browse for a folder…</span><span class="p">Opens the system folder picker</span></div>`;
  dropdown.innerHTML = html;
  ddIndex = Math.min(Math.max(ddIndex, 0), ddItems.length - 1);
  if (!query) ddIndex = -1;
  paintActive();
  dropdown.classList.remove("hidden");
}
function paintActive() {
  dropdown.querySelectorAll(".dd-item").forEach((el) => el.classList.toggle("active", Number(el.dataset.i) === ddIndex));
}
function hideDropdown() { dropdown.classList.add("hidden"); ddIndex = -1; }
function runItem(item) {
  if (!item) return;
  if (item.action === "browse") browse();
  else openProject(item.path);
}

projectInput.addEventListener("focus", () => { projectInput.select(); renderDropdown(); });
projectInput.addEventListener("input", () => { ddIndex = 0; renderDropdown(); });
projectInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); ddIndex = Math.min(ddIndex + 1, ddItems.length - 1); paintActive(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); ddIndex = Math.max(ddIndex - 1, 0); paintActive(); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const q = projectInput.value.trim();
    if (ddIndex >= 0) runItem(ddItems[ddIndex]);
    else if (looksLikePath(q)) openProject(q);
    else if (ddItems.length > 1) runItem(ddItems[0]);
    projectInput.blur();
  } else if (e.key === "Escape") {
    projectInput.value = state.project ? state.project.path : "";
    hideDropdown(); projectInput.blur();
  }
});
dropdown.addEventListener("mousedown", (e) => {
  const el = e.target.closest(".dd-item");
  if (!el) return;
  e.preventDefault();
  runItem(ddItems[Number(el.dataset.i)]);
  projectInput.blur();
});
projectInput.addEventListener("blur", () => setTimeout(() => {
  hideDropdown();
  if (state.project && !projectInput.value.trim()) projectInput.value = state.project.path;
}, 120));
$("#btn-browse").onclick = browse;
$("#btn-welcome-browse").onclick = browse;
// Cmd/Ctrl+O opens the folder picker, Cmd/Ctrl+P focuses the search bar.
window.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === "o") { e.preventDefault(); browse(); }
  if (k === "p") { e.preventDefault(); projectInput.focus(); }
});

function renderWelcomeRecent() {
  const box = $("#welcome-recent");
  if (!state.recent.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="dd-head">Recent projects</div>` + state.recent.slice(0, 6).map((r, i) =>
    `<div class="dd-item" data-i="${i}"><span class="n">${escapeHtml(r.name)}</span><span class="p">${escapeHtml(r.path)}</span></div>`).join("");
  box.querySelectorAll(".dd-item").forEach((el) => { el.onclick = () => openProject(state.recent[Number(el.dataset.i)].path); });
}

loadState();

// ---------------------------------------------------------------- quit
function showStopped(title, text) {
  state.stopped = true;
  clearInterval(heartbeat);
  const el = document.createElement("div");
  el.className = "stopped";
  el.innerHTML = `<div class="welcome-card"><div class="welcome-logo off"></div><h1></h1><p></p></div>`;
  el.querySelector("h1").textContent = title;
  el.querySelector("p").textContent = text;
  document.body.appendChild(el);
}
$("#btn-quit").onclick = async () => {
  const n = pendingCount();
  if (n && !window.confirm(`You have ${n} unsaved change${n > 1 ? "s" : ""}. Quit without saving?`)) return;
  try { await fetch("/__pixi-editor/api/quit", { method: "POST" }); } catch { /* already stopped */ }
  iframe.removeAttribute("src");
  showStopped("Pixi Editor has stopped", "You can close this tab. Start it again with: node bin/pixi-editor.js");
  setTimeout(() => window.close(), 300);
};
// Notice when the editor process stops (closed terminal, crash…).
let misses = 0;
const heartbeat = setInterval(async () => {
  try {
    await fetch("/__pixi-editor/api/ping", { cache: "no-store", signal: AbortSignal.timeout(2000) });
    misses = 0;
  } catch {
    if (++misses >= 2 && !state.stopped) showStopped("Pixi Editor is not running", "The editor process stopped. Start it again with: node bin/pixi-editor.js — then reload this tab.");
  }
}, 2500);
applyView();

// ---------------------------------------------------------------- creating objects
const createMenu = $("#create-menu");
$("#btn-create").onclick = (e) => {
  e.stopPropagation();
  createMenu.classList.toggle("hidden");
};
document.addEventListener("click", () => createMenu.classList.add("hidden"));
createMenu.querySelectorAll("button").forEach((b) => {
  b.onclick = (e) => {
    e.stopPropagation();
    createMenu.classList.add("hidden");
    createObject(b.dataset.kind);
  };
});

/** The container that will hold the new object: the selection (or its nearest ancestor) stored in a variable. */
async function creationParent() {
  const PIXI = state.PIXI;
  const canHold = (o) => !(PIXI.ViewContainer && o instanceof PIXI.ViewContainer);
  for (let o = state.selected; o && o !== state.app.stage; o = o.parent) {
    const m = metaOf(o);
    if (!canHold(o) || !m || !m.declId) continue;
    await loadInfo([m.declId]);
    if (state.info.get(m.declId)?.canInsert) return o;
  }
  return null;
}

async function createObject(kind) {
  if (!state.app || !state.PIXI) { setStatus("Open a project and wait for the game to load first.", "err"); return; }
  if (state.mode !== "edit") setMode("edit");
  const parent = await creationParent();
  if (!parent) {
    setStatus("Select a container (or an object inside one) that is stored in a variable in the code — the new object will be created there.", "err");
    return;
  }
  let texture = null;
  if (kind === "sprite") {
    texture = await pickTexture();
    if (!texture) return;
  }
  // Put it in the middle of what you're looking at.
  const W = overlay.clientWidth, H = overlay.clientHeight;
  const center = overlayToGlobal(W / 2, H / 2);
  const local = parent.toLocal(center);
  const name = kind === "sprite" ? texture.split(/[/\\]/).pop().replace(/\.[a-z0-9]+$/i, "") : "";
  setStatus("Creating…");
  const res = await (await fetch("/__pixi-editor/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentDeclId: metaOf(parent).declId, kind, name, texture, x: Math.round(local.x), y: Math.round(local.y) }),
  })).json();
  if (!res.ok) { setStatus(res.error, "err"); return; }

  // Same object, live in the game.
  const P = state.PIXI;
  let obj;
  if (kind === "container") obj = new P.Container();
  else if (kind === "sprite") { obj = P.Sprite.from(texture); obj.anchor.set(0.5); }
  else if (kind === "text") { obj = new P.Text({ text: "New text", style: { fill: 0xffffff, fontSize: 32 } }); obj.anchor.set(0.5); }
  else if (kind === "rect") obj = new P.Graphics().rect(-50, -50, 100, 100).fill(0xffffff);
  else obj = new P.Graphics().circle(0, 0, 50).fill(0xffffff);
  obj.position.set(Math.round(local.x), Math.round(local.y));
  parent.addChild(obj);
  state.pe.d(obj, res.declId, res.name, res.opts);
  for (const st of res.sites) state.pe.s(obj, st.kind, st.id);
  render();
  state.expanded.add(parent);
  state.treeSig = "";
  select(obj);
  setStatus(`Created ${res.name} in ${nameOf(parent)} — ${res.file}:${res.line}`, "ok");
}

// ---------------------------------------------------------------- assets: textures and spines
const keyScore = (k) => (k.includes("/") ? 100 : 0) + (k.includes("?") ? 100 : 0) + k.length;
const byScore = (keys) => keys.sort((a, b) => keyScore(a) - keyScore(b));
function cacheEntries() {
  const P = state.PIXI;
  const cache = P && P.Cache && P.Cache._cache;
  return cache ? [...cache] : [];
}
/** Every cache key of a texture, readable ones first ("coin" before "/assets/coin.png"). */
function textureKeys(texture) {
  if (!texture) return [];
  return byScore(cacheEntries().filter(([, v]) => v === texture).map(([k]) => String(k)));
}
function loadedTextures() {
  const P = state.PIXI;
  const byTexture = new Map();
  for (const [key, value] of cacheEntries()) {
    if (!(value instanceof P.Texture) || value === P.Texture.EMPTY || value === P.Texture.WHITE) continue;
    if (value.width <= 1 || value.height <= 1) continue;
    if (!byTexture.has(value)) byTexture.set(value, []);
    byTexture.get(value).push(String(key));
  }
  return [...byTexture].map(([texture, keys]) => ({ texture, keys: byScore(keys), key: byScore(keys)[0] }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
const isSprite = (o) => !!(state.PIXI && state.PIXI.Sprite && o instanceof state.PIXI.Sprite && !isSpine(o));
const isSpine = (o) => !!(o && o.skeleton && o.state && o.skeleton.data && typeof o.constructor.from === "function");
const baseName = (k) => String(k).split(/[/\\]/).pop().replace(/\?.*$/, "").replace(/\.(json|skel|atlas|txt|png|webp|jpe?g)$/i, "");

/** Spine skeletons in the asset cache, paired with their atlas by file name ("hero.json" + "hero.atlas"). */
function loadedSpines() {
  const skels = new Map(); // data -> keys
  const atlases = new Map(); // atlas -> keys
  for (const [key, v] of cacheEntries()) {
    const k = String(key);
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v.pages) && Array.isArray(v.regions)) { if (!atlases.has(v)) atlases.set(v, []); atlases.get(v).push(k); continue; }
    const json = v.skeleton && Array.isArray(v.bones);
    const binary = /\.skel(\?|$)/i.test(k) && (v instanceof Uint8Array || v instanceof ArrayBuffer);
    if (json || binary) { if (!skels.has(v)) skels.set(v, []); skels.get(v).push(k); }
  }
  const atlasList = [...atlases.values()].map(byScore);
  const out = [];
  for (const keys of skels.values()) {
    byScore(keys);
    const name = baseName(keys[0]);
    const atlas = atlasList.find((a) => a.some((k) => baseName(k) === name)) || (atlasList.length === 1 ? atlasList[0] : null);
    if (atlas) out.push({ key: name, skeleton: keys, atlas });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
/** { name, skeleton, atlas } of the skeleton a Spine object shows, found through Spine's own data cache. */
function spineOf(o) {
  if (o.__peSpine) { const v = JSON.parse(o.__peSpine); return { name: baseName(v.skeleton[0]), ...v }; }
  const data = o.skeleton && o.skeleton.data;
  const hit = cacheEntries().find(([, v]) => v === data);
  if (!hit) return null;
  const cacheKey = String(hit[0]); // `${skeleton}-${atlas}-${scale}`
  const s = loadedSpines().find((sp) => sp.skeleton.some((k) => cacheKey.startsWith(`${k}-`)));
  return s ? { name: s.key, skeleton: s.skeleton, atlas: s.atlas } : null;
}

/** Puts `neu` where `old` is (same parent, index and transform) and points the editor at it. */
function replaceObject(old, neu) {
  const p = old.parent;
  if (!p) return;
  const i = p.getChildIndex(old);
  for (const k of ["label", "alpha", "visible", "zIndex", "rotation", "eventMode", "cursor"]) { try { neu[k] = old[k]; } catch { /* read-only */ } }
  for (const k of ["position", "scale", "pivot", "skew"]) neu[k].copyFrom(old[k]);
  p.addChildAt(neu, i);
  p.removeChild(old);
  if (state.pe.adopt) state.pe.adopt(old, neu);
  state.uids.set(neu, uid(old));
  const swap = (x) => (x === old ? neu : x);
  for (const rec of state.pending.values()) { rec.obj = swap(rec.obj); rec.original = swap(rec.original); rec.current = swap(rec.current); }
  for (const e of [...state.undo, ...state.redo]) {
    e.obj = swap(e.obj);
    if (e.before && "parent" in e.before) { e.before.parent = swap(e.before.parent); e.after.parent = swap(e.after.parent); }
  }
  for (const r of state.compOriginal.values()) r.obj = swap(r.obj);
  if (state.selected === old) state.selected = neu;
  if (state.hover === old) state.hover = null;
  state.replaced = true;
  state.treeSig = "";
  render();
}

/** Shows another skeleton on a Spine object (a new Spine replaces it in the scene). "" = back to the code's. */
function setSpine(o, v) {
  if ((o.__peSpine || "") === v) return;
  let neu;
  if (!v) neu = o.__peOriginal;
  else {
    const { skeleton, atlas } = JSON.parse(v);
    try { neu = o.constructor.from({ skeleton: skeleton[0], atlas: atlas[0] }); } catch (err) { setStatus(`Could not create the spine: ${err.message}`, "err"); return; }
    neu.__peSpine = v;
    neu.__peOriginal = o.__peOriginal || o;
    const playing = o.state && o.state.tracks && o.state.tracks[0] && o.state.tracks[0].animation;
    const anims = neu.skeleton.data.animations;
    const anim = (playing && anims.find((a) => a.name === playing.name)) || anims[0];
    if (anim) neu.state.setAnimation(0, anim.name, true);
    if (typeof neu.update === "function") neu.update(0);
    state.spineNote = playing && !anims.some((a) => a.name === playing.name)
      ? `Note: this skeleton has no "${playing.name}" animation — code that plays it will need a new name.` : "";
  }
  if (neu && neu !== o) replaceObject(o, neu);
}

function assetRow(labelText, name, drawThumb, onChange, title) {
  const row = document.createElement("div");
  row.className = "row single asset-row";
  row.innerHTML = `<label></label><div class="field asset-field"><canvas width="64" height="64"></canvas><div class="asset-name"></div><button class="ghost">Change…</button></div>`;
  row.querySelector("label").textContent = labelText;
  const nm = row.querySelector(".asset-name");
  nm.textContent = name || "—";
  nm.title = title || name || "";
  drawThumb(row.querySelector("canvas"));
  row.querySelector("button").onclick = onChange;
  return row;
}

function drawTexture(canvas, texture) { // a Texture or a display object
  try {
    const src = state.app.renderer.extract.canvas(texture);
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, canvas.width, canvas.height);
    const k = Math.min(canvas.width / src.width, canvas.height / src.height, 1);
    const w = src.width * k, h = src.height * k;
    c.drawImage(src, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  } catch { /* some textures can't be extracted */ }
}
function drawSpine(canvas, SpineClass, sp) {
  let tmp = null;
  try {
    tmp = SpineClass.from({ skeleton: sp.skeleton[0], atlas: sp.atlas[0] });
    const anim = tmp.skeleton.data.animations[0];
    if (anim) tmp.state.setAnimation(0, anim.name, false);
    if (typeof tmp.update === "function") tmp.update(0.3);
    drawTexture(canvas, tmp);
  } catch { /* skeleton without a drawable pose */ }
  finally { if (tmp) tmp.destroy(); }
}

function textureRow(o) {
  const keys = textureKeys(o.texture);
  return assetRow("Texture", keys[0] || "(not in the asset cache)", (c) => drawTexture(c, o.texture), async () => {
    const item = await pickAsset({
      title: "Choose a texture",
      note: "Textures the game has loaded. Saving writes the texture's key, or the project's constant for it (e.g. TEX.COIN).",
      items: loadedTextures().map((t) => ({ ...t, title: `${t.key} — ${t.texture.width}×${t.texture.height}`, draw: (c) => drawTexture(c, t.texture) })),
      empty: "The game hasn't loaded any textures yet.",
    });
    if (!item || item.texture === o.texture) return;
    const before = { texture: o.texture };
    setLive(o, { texture: item.texture });
    commit(o, before, { texture: item.texture });
    renderInspector();
  }, keys.join("\n"));
}

function spineRow(o) {
  const cur = spineOf(o);
  const row = assetRow("Spine", cur ? cur.name : "(unknown)", (c) => { if (cur) drawSpine(c, o.constructor, cur); }, async () => {
    const SpineClass = o.constructor;
    const item = await pickAsset({
      title: "Choose a spine",
      note: "Skeletons the game has loaded (skeleton + atlas with the same name). The new spine plays the same animation if it has one, otherwise its first.",
      items: loadedSpines().map((sp) => ({ ...sp, title: `${sp.skeleton[0]} + ${sp.atlas[0]}`, draw: (c) => drawSpine(c, SpineClass, sp) })),
      empty: "The game hasn't loaded any spine skeletons yet.",
    });
    if (!item || (cur && cur.name === item.key)) return;
    const v = JSON.stringify({ skeleton: item.skeleton, atlas: item.atlas });
    const before = { spine: o.__peSpine || "" };
    state.spineNote = "";
    setLive(o, { spine: v });
    const neu = state.selected === o ? o : state.selected; // replaced in the scene
    commit(neu, before, { spine: v });
    renderInspector();
    if (state.spineNote) setStatus(state.spineNote, "err");
  });
  const btn = row.querySelector("button");
  const site = bestSite(metaOf(o), "spine");
  const note = (text) => {
    btn.disabled = true;
    const n = document.createElement("p");
    n.className = "note";
    n.textContent = text;
    row.after(n);
  };
  if (!site) setTimeout(() => note("The code line that chooses this spine wasn't found, so it can't be changed here."));
  else loadInfo([site.id]).then(() => {
    const inf = state.info.get(site.id);
    if (inf && inf.fixed) note(`Chosen by code (${inf.file}:${inf.line}), so it can't be changed here.`);
  });
  return row;
}

/** Grid of assets with lazy thumbnails; resolves with the chosen item, or null. */
function pickAsset({ title, note, items, empty }) {
  return new Promise((resolve) => {
    const modal = $("#texture-modal");
    const grid = $("#texture-grid");
    const search = $("#texture-search");
    $("#texture-title").textContent = title;
    $("#texture-note").textContent = note || "";
    let observer = null;
    const close = (value) => {
      modal.classList.add("hidden");
      if (observer) observer.disconnect();
      window.removeEventListener("keydown", onEsc, true);
      resolve(value);
    };
    const onEsc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
    window.addEventListener("keydown", onEsc, true);
    $("#texture-cancel").onclick = () => close(null);
    modal.onclick = (e) => { if (e.target === modal) close(null); };
    const draw = (filter) => {
      if (observer) observer.disconnect();
      observer = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting || en.target.dataset.done) continue;
          en.target.dataset.done = "1";
          items[Number(en.target.dataset.i)].draw(en.target.querySelector("canvas"));
        }
      }, { root: grid });
      grid.innerHTML = "";
      const f = filter.trim().toLowerCase();
      items.forEach((it, i) => {
        if (f && !it.key.toLowerCase().includes(f)) return;
        const cell = document.createElement("button");
        cell.className = "texture";
        cell.dataset.i = i;
        cell.title = it.title || it.key;
        cell.innerHTML = `<canvas width="72" height="72"></canvas><span></span>`;
        cell.querySelector("span").textContent = it.key;
        cell.onclick = () => close(it);
        grid.appendChild(cell);
        observer.observe(cell);
      });
      if (!grid.children.length) grid.innerHTML = `<p class="note">${items.length ? "Nothing matches." : empty}</p>`;
    };
    search.value = "";
    search.oninput = () => draw(search.value);
    search.onkeydown = (e) => {
      if (e.key === "Enter") { const first = grid.querySelector(".texture"); if (first) first.click(); }
    };
    modal.classList.remove("hidden");
    draw("");
    search.focus();
  });
}

/** Texture key for a new sprite. */
async function pickTexture() {
  const item = await pickAsset({
    title: "Choose a texture",
    note: "Textures the game has loaded. The code uses the texture's key, e.g. Sprite.from('coin').",
    items: loadedTextures().map((t) => ({ ...t, title: `${t.key} — ${t.texture.width}×${t.texture.height}`, draw: (c) => drawTexture(c, t.texture) })),
    empty: "The game hasn't loaded any textures yet.",
  });
  return item ? item.key : null;
}

// ---------------------------------------------------------------- changing the parent (drag in the hierarchy)
const canHoldChildren = (o) => !!o && !(state.PIXI && state.PIXI.ViewContainer && o instanceof state.PIXI.ViewContainer);
const isInside = (o, ancestor) => { for (let p = o; p; p = p.parent) if (p === ancestor) return true; return false; };
function canDropOn(o, target) {
  return !!o && !!target && target !== o.parent && canHoldChildren(target) && !isInside(target, o);
}
/** Moves `o` right before/after `sibling` in the draw order (into sibling's parent if needed). */
function placeNextTo(o, sibling, place) {
  const parent = sibling.parent;
  if (!parent || o === sibling) return;
  if (o.parent !== parent) reparent(o, parent, true);
  const from = parent.getChildIndex(o);
  let to = parent.getChildIndex(sibling) + (place === "after" ? 1 : 0);
  if (from < to) to--;
  if (to === from) { renderTree(true); return; }
  setLive(o, { order: to });
  commit(o, { order: from }, { order: to });
  state.treeSig = "";
  renderTree(true);
  renderInspector();
  setStatus(`${nameOf(o)} is now drawn ${place} ${nameOf(sibling)} — save to write it in the code`);
}

/** Moves `o` into `target`, keeping it in the same place on screen. */
function reparent(o, target, quiet = false) {
  if (!canDropOn(o, target)) return;
  const before = { parent: o.parent, x: o.x, y: o.y };
  const g = o.parent.toGlobal({ x: o.x, y: o.y });
  const l = target.toLocal(g);
  const after = { parent: target, x: Math.round(l.x * 100) / 100, y: Math.round(l.y * 100) / 100 };
  setLive(o, after);
  commit(o, before, after);
  state.expanded.add(target);
  state.treeSig = "";
  renderTree(true);
  renderInspector();
  if (!quiet) setStatus(`Moved ${nameOf(o)} into ${nameOf(target)} — save to write it in the code`);
}

// Small hook for automated tests (Playwright): select an object of the game.
window.pixiEditor = {
  select: (o) => select(o),
  openFile: (p, size = 0) => openFileView({ name: p.split("/").pop(), path: p, size, type: "file" }),
};


// ---------------------------------------------------------------- delete and duplicate
/** Shows a code diff and asks to confirm (same dialog as the save review). */
function confirmCode({ title, sub, notes = [], diffs, confirmLabel }) {
  return new Promise((resolve) => {
    const modal = $("#review-modal");
    $("#review-title").textContent = title;
    $("#review-sub").textContent = sub || "";
    $("#review-toggle").parentElement.style.display = "none";
    $("#review-save").textContent = confirmLabel;
    $("#review-cancel").textContent = "Cancel";
    const list = $("#review-changes");
    list.innerHTML = "";
    for (const n of notes) { const p = document.createElement("div"); p.className = "review-msg"; p.textContent = n; list.appendChild(p); }
    const box = $("#review-diff");
    box.innerHTML = "";
    renderDiffs(box, diffs);
    modal.classList.remove("hidden");
    const done = (ok) => { modal.classList.add("hidden"); window.removeEventListener("keydown", onKeyDlg, true); resolve(ok); };
    const onKeyDlg = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); done(false); }
      if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); done(true); }
    };
    window.addEventListener("keydown", onKeyDlg, true);
    $("#review-cancel").onclick = () => done(false);
    $("#review-save").onclick = () => done(true);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}

async function objectRequest(body) {
  try {
    return await (await fetch("/__pixi-editor/api/object", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Forgets unsaved changes and undo steps of an object and everything inside it. */
function forgetObject(o) {
  const gone = (x) => !!x && isInside(x, o);
  for (const [k, rec] of state.pending) if (gone(rec.obj)) state.pending.delete(k);
  for (const [k, rec] of state.compOriginal) if (gone(rec.obj)) state.compOriginal.delete(k);
  state.undo = state.undo.filter((e) => !gone(e.obj));
  state.redo = state.redo.filter((e) => !gone(e.obj));
}

async function deleteSelected() {
  const o = state.selected;
  if (!o || o === state.app.stage) return;
  const m = metaOf(o);
  if (!m || !m.declId) { setStatus(`${nameOf(o)} is not linked to the code that creates it, so it can't be deleted from here.`, "err"); return; }
  setStatus(`Checking ${nameOf(o)}'s code…`);
  const plan = await objectRequest({ action: "delete", declId: m.declId, dryRun: true });
  if (!plan.ok) { setStatus(plan.error, "err"); return; }
  const notes = [`Deletes ${nameOf(o)} and every line that sets it up.`];
  const uses = state.pe.siteUse.get(m.declId) || 0;
  if (uses > 1) notes.push(`⚠ This code creates ${uses} objects (a loop or a helper): all of them go away.`);
  const linkedKids = [];
  (function walk(x) { for (const c of x.children) { const cm = metaOf(c); if (cm && cm.declId) linkedKids.push(nameOf(c)); walk(c); } })(o);
  if (linkedKids.length) notes.push(`Its children created elsewhere in the code (${linkedKids.slice(0, 4).join(", ")}${linkedKids.length > 4 ? "…" : ""}) stay in the code but are no longer added to the scene.`);
  if (!(await confirmCode({ title: `Delete ${nameOf(o)}`, sub: "These lines are removed from the code", notes, diffs: plan.diffs, confirmLabel: "Delete" }))) { setStatus("Delete canceled"); return; }
  const res = await objectRequest({ action: "delete", declId: m.declId });
  if (!res.ok) { setStatus(res.error, "err"); return; }
  forgetObject(o);
  if (o.parent) o.parent.removeChild(o);
  select(null);
  state.info.clear();
  state.treeSig = "";
  updateSaveButton();
  render();
  setStatus(`Deleted ${nameOf(o)} from ${res.file}`, "ok");
}

/** A live copy of a display object for the preview (its code is copied on the server). */
function cloneLive(o) {
  const P = state.PIXI;
  let c = null;
  try {
    if (isSpine(o)) {
      const sp = spineOf(o);
      if (sp) {
        c = o.constructor.from({ skeleton: sp.skeleton[0], atlas: sp.atlas[0] });
        const playing = o.state && o.state.tracks && o.state.tracks[0] && o.state.tracks[0].animation;
        if (playing) c.state.setAnimation(0, playing.name, true);
      }
    } else if ((P.Text && o instanceof P.Text) || (P.BitmapText && o instanceof P.BitmapText) || (P.HTMLText && o instanceof P.HTMLText)) {
      c = new o.constructor({ text: o.text, style: o.style && o.style.clone ? o.style.clone() : o.style });
    } else if (P.Sprite && o instanceof P.Sprite) {
      c = new P.Sprite(o.texture);
    } else if (P.Graphics && o instanceof P.Graphics) {
      c = new P.Graphics(o.context);
    } else if (o.constructor === P.Container && !o.children.length) {
      c = new P.Container();
    }
  } catch { c = null; }
  if (!c) return null;
  for (const k of ["position", "scale", "pivot", "skew"]) c[k].copyFrom(o[k]);
  if (o.anchor && c.anchor) c.anchor.copyFrom(o.anchor);
  for (const k of ["rotation", "alpha", "visible", "tint", "label", "zIndex", "blendMode", "eventMode", "cursor"]) { try { if (o[k] !== undefined) c[k] = o[k]; } catch { /* read-only */ } }
  return c;
}

async function duplicateSelected() {
  const o = state.selected;
  if (!o || o === state.app.stage) return;
  const m = metaOf(o);
  if (!m || !m.declId) { setStatus(`${nameOf(o)} is not linked to the code that creates it, so it can't be duplicated from here.`, "err"); return; }
  if (isModified(o)) { setStatus(`Save ${nameOf(o)}'s changes first, so the copy gets them too.`, "err"); return; }
  setStatus(`Duplicating ${nameOf(o)}…`);
  const res = await objectRequest({ action: "duplicate", declId: m.declId });
  if (!res.ok) { setStatus(res.error, "err"); return; }
  state.info.clear();
  const c = cloneLive(o);
  if (!c) {
    state.afterReload = `Duplicated ${nameOf(o)} as ${res.name} (${res.file}:${res.line}) — game reloaded`;
    setStatus(`Duplicated as ${res.name} — reloading the game to show it…`, "ok");
    iframe.contentWindow.location.reload();
    return;
  }
  const p = o.parent;
  p.addChildAt(c, p.getChildIndex(o) + 1);
  state.pe.d(c, res.declId, res.name, res.opts);
  for (const st of res.sites || []) state.pe.s(c, st.kind, st.id);
  state.treeSig = "";
  select(c);
  render();
  setStatus(`Duplicated ${nameOf(o)}${res.name !== nameOf(o) ? ` as ${res.name}` : ""} — ${res.file}:${res.line}. It's in the same place: drag it away.`, "ok");
}


// ---------------------------------------------------------------- spine animation and text style rows
/** A dropdown that changes one property (saved like the others). */
function selectRow(o, prop, labelText, options) {
  const row = document.createElement("div");
  row.className = "row single";
  row.innerHTML = `<label></label><div class="field"><select></select></div>`;
  row.querySelector("label").textContent = labelText;
  const sel = row.querySelector("select");
  const cur = String(propDef(prop).get(o));
  const list = options.includes(cur) || !cur ? options : [cur, ...options];
  for (const v of list) { const op = document.createElement("option"); op.value = v; op.textContent = v || "—"; sel.appendChild(op); }
  sel.value = cur;
  sel.dataset.vprop = prop;
  sel.onchange = () => {
    const before = { [prop]: propDef(prop).get(o) };
    const after = { [prop]: sel.value };
    setLive(o, after);
    commit(o, before, after);
  };
  return row;
}

function animationRow(o) {
  const names = ((o.skeleton && o.skeleton.data && o.skeleton.data.animations) || []).map((a) => a.name);
  const row = selectRow(o, "animation", "Animation", names);
  row.title = "Plays in a loop while you edit. Saved where the code chooses the animation (setAnimation / animationName).";
  return row;
}

const isTextLike = (o) => !!(o && o.style && "fontSize" in o.style && (typeof o.text === "string" || typeof o.text === "number"));

function textStyleRows(o) {
  const rows = [];
  // Font: free text, with the fonts the game's page has loaded as suggestions.
  const fontRow = document.createElement("div");
  fontRow.className = "row single";
  fontRow.innerHTML = `<label>Font</label><div class="field"><input type="text" spellcheck="false" list="font-list"><datalist id="font-list"></datalist></div>`;
  const input = fontRow.querySelector("input");
  input.dataset.vprop = "fontFamily";
  const families = new Set(["Arial", "Helvetica", "Verdana", "Georgia", "Times New Roman", "Courier New", "monospace", "sans-serif", "serif"]);
  try { for (const f of state.win.document.fonts) families.add(f.family.replace(/^["']|["']$/g, "")); } catch { /* no font list */ }
  const dl = fontRow.querySelector("datalist");
  for (const f of families) { const op = document.createElement("option"); op.value = f; dl.appendChild(op); }
  let before = null;
  input.addEventListener("focus", () => { before = readVals(o, ["fontFamily"]); });
  input.addEventListener("change", () => {
    const after = { fontFamily: input.value.trim() };
    if (!after.fontFamily) { refreshInspectorValues(true); return; }
    setLive(o, after);
    commit(o, before || readVals(o, ["fontFamily"]), after);
    before = readVals(o, ["fontFamily"]);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  rows.push(fontRow);
  rows.push(numberRow(o, { label: "Size", props: [["fontSize", "", 0.5, null, [1, 1000]]] }));
  rows.push(selectRow(o, "fontWeight", "Weight", ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"]));
  rows.push(selectRow(o, "fontStyle", "Style", ["normal", "italic", "oblique"]));
  rows.push(selectRow(o, "align", "Align", ["left", "center", "right", "justify"]));
  rows.push(numberRow(o, { label: "Spacing", props: [["letterSpacing", "", 0.1]] }));
  return rows;
}


// ---------------------------------------------------------------- screen size presets
const SCREEN_KEY = "pixi-editor:screen";
const screenSelect = $("#screen-size");
/** Gives the game iframe a fixed size (the game sees a window of that size), or the whole viewport. */
function applyScreen(value, fit = true) {
  const m = /^(\d+)x(\d+)$/.exec(value || "");
  if (m) {
    iframe.style.width = `${m[1]}px`;
    iframe.style.height = `${m[2]}px`;
  } else {
    iframe.style.width = iframe.style.height = "";
  }
  iframe.classList.toggle("sized", !!m);
  $("#viewport").classList.toggle("sized", !!m);
  try { localStorage.setItem(SCREEN_KEY, m ? value : ""); } catch { /* private mode */ }
  if (m && ![...screenSelect.options].some((o) => o.value === value)) {
    const op = document.createElement("option");
    op.value = value;
    op.textContent = `Custom · ${m[1]}×${m[2]}`;
    screenSelect.insertBefore(op, screenSelect.lastElementChild);
  }
  screenSelect.value = m ? value : "";
  // Let the game handle its resize, then show all of it.
  if (fit) setTimeout(() => { render(); m ? zoomFit() : zoomReset(); }, 250);
}
screenSelect.onchange = () => {
  let v = screenSelect.value;
  if (v === "custom") {
    const answer = window.prompt("Screen size (width × height in pixels):", "1280x720");
    const m = /(\d+)\s*[x×*, ]\s*(\d+)/.exec(answer || "");
    v = m ? `${m[1]}x${m[2]}` : (iframe.classList.contains("sized") ? `${parseInt(iframe.style.width)}x${parseInt(iframe.style.height)}` : "");
  }
  applyScreen(v);
};
try { const saved = localStorage.getItem(SCREEN_KEY); if (saved) applyScreen(saved, false); } catch { /* private mode */ }

// ---------------------------------------------------------------- resizable panels
const LAYOUT_KEY = "pixi-editor:layout";
const layoutEl = $("#layout");
const LAYOUT_DEFAULT = { left: 260, right: 300, files: 220, filesCollapsed: false };
let layout = { ...LAYOUT_DEFAULT };
try { layout = { ...layout, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") }; } catch { /* private mode */ }
function applyLayout(saveIt = true) {
  const W = window.innerWidth;
  layout.left = Math.round(Math.min(Math.max(layout.left, 180), Math.max(180, W * 0.45)));
  layout.right = Math.round(Math.min(Math.max(layout.right, 240), Math.max(240, W * 0.45)));
  const colH = $("#left-side").clientHeight || window.innerHeight;
  layout.files = Math.round(Math.min(Math.max(layout.files, 90), Math.max(90, colH - 140)));
  layoutEl.style.setProperty("--left-w", `${layout.left}px`);
  layoutEl.style.setProperty("--right-w", `${layout.right}px`);
  layoutEl.style.setProperty("--files-h", `${layout.files}px`);
  $("#files-panel").classList.toggle("collapsed", !!layout.filesCollapsed);
  if (saveIt) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private mode */ } }
}
for (const sp of document.querySelectorAll(".splitter")) {
  const which = sp.dataset.split;
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("dragging");
    document.body.classList.add("resizing");
    const start = { x: e.clientX, y: e.clientY, ...layout };
    const move = (ev) => {
      if (which === "left") layout.left = start.left + (ev.clientX - start.x);
      else if (which === "right") layout.right = start.right - (ev.clientX - start.x);
      else layout.files = start.files - (ev.clientY - start.y);
      applyLayout(false);
    };
    const up = () => {
      sp.releasePointerCapture(e.pointerId);
      sp.classList.remove("dragging");
      document.body.classList.remove("resizing");
      sp.removeEventListener("pointermove", move);
      sp.removeEventListener("pointerup", up);
      applyLayout();
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", up);
  });
  sp.addEventListener("dblclick", () => {
    const key = which === "files" ? "files" : which;
    layout[key] = LAYOUT_DEFAULT[key];
    applyLayout();
  });
}
window.addEventListener("resize", () => applyLayout(false));
applyLayout(false);

// ---------------------------------------------------------------- project explorer
const filesEl = $("#files");
const filesState = { expanded: new Set([""]), cache: new Map(), selected: null, query: "", linked: null };
const IMG_EXT = /\.(png|jpe?g|webp|gif|avif|svg)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a)$/i;
function fileIcon(name, isDir) {
  if (isDir) return { cls: "dir", text: "▸" };
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [, ""])[1].toLowerCase();
  if (IMG_EXT.test(name)) return { cls: "img", text: "IMG" };
  if (AUDIO_EXT.test(name)) return { cls: "audio", text: "♪" };
  if (["ts", "tsx", "js", "mjs", "jsx", "json", "atlas"].includes(ext)) return { cls: ext, text: ext.toUpperCase().slice(0, 4) };
  return { cls: "", text: ext ? ext.toUpperCase().slice(0, 4) : "·" };
}
async function loadDir(dir) {
  if (filesState.cache.has(dir)) return filesState.cache.get(dir);
  const res = await (await fetch(`/__pixi-editor/api/files?dir=${encodeURIComponent(dir)}`)).json();
  const entries = res.entries || [];
  filesState.cache.set(dir, entries);
  return entries;
}
function fileRow(e, depth, flat = false) {
  const row = document.createElement("div");
  row.className = "file" + (filesState.selected === e.path ? " selected" : "") + (filesState.linked === e.path ? " linked" : "");
  row.style.paddingLeft = `${6 + depth * 12}px`;
  row.dataset.path = e.path;
  const isDir = e.type === "dir";
  const open = isDir && filesState.expanded.has(e.path);
  const ico = fileIcon(e.name, isDir);
  row.innerHTML = `<span class="caret"></span><span class="ico"></span><span class="fname"></span>`;
  row.querySelector(".caret").textContent = isDir ? (open ? "▾" : "▸") : "";
  const icoEl = row.querySelector(".ico");
  icoEl.className = `ico ${ico.cls}`;
  icoEl.textContent = isDir ? "" : ico.text;
  row.querySelector(".fname").textContent = e.name;
  if (flat && e.path.includes("/")) {
    const d = document.createElement("span");
    d.className = "fdir";
    d.textContent = e.path.slice(0, e.path.lastIndexOf("/"));
    row.appendChild(d);
  }
  row.title = isDir ? e.path : `${e.path} — ${formatSize(e.size)} · double-click to open`;
  row.onclick = () => {
    if (isDir) {
      open ? filesState.expanded.delete(e.path) : filesState.expanded.add(e.path);
      renderFiles();
      return;
    }
    filesState.selected = e.path;
    for (const r of filesEl.querySelectorAll(".file.selected")) r.classList.remove("selected");
    row.classList.add("selected");
    openFileView(e);
  };
  if (!isDir) row.ondblclick = () => openInIde(e.path, 1, 1);
  return row;
}
const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
let filesToken = 0;
async function renderFiles() {
  if (!state.project) { filesEl.innerHTML = `<p class="note">Open a project to see its files.</p>`; return; }
  const token = ++filesToken;
  const frag = document.createDocumentFragment();
  if (filesState.query) {
    const res = await (await fetch(`/__pixi-editor/api/files?q=${encodeURIComponent(filesState.query)}`)).json();
    if (token !== filesToken) return;
    for (const e of res.entries || []) frag.appendChild(fileRow(e, 0, true));
    if (!(res.entries || []).length) frag.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "No file matches." }));
  } else {
    const add = async (dir, depth) => {
      for (const e of await loadDir(dir)) {
        frag.appendChild(fileRow(e, depth));
        if (e.type === "dir" && filesState.expanded.has(e.path)) await add(e.path, depth + 1);
      }
    };
    await add("", 0);
    if (token !== filesToken) return;
  }
  const scroll = filesEl.scrollTop;
  filesEl.replaceChildren(frag);
  filesEl.scrollTop = scroll;
}
/** Reloads the open folders and redraws only if something changed (so clicks aren't lost). */
let refreshingFiles = false;
async function refreshFiles() {
  if (refreshingFiles || filesState.query) return;
  refreshingFiles = true;
  try {
    let changed = false;
    for (const dir of [...filesState.cache.keys()]) {
      if (dir && !filesState.expanded.has(dir)) { filesState.cache.delete(dir); continue; }
      const res = await (await fetch(`/__pixi-editor/api/files?dir=${encodeURIComponent(dir)}`)).json();
      const entries = res.entries || [];
      if (JSON.stringify(entries) !== JSON.stringify(filesState.cache.get(dir))) { filesState.cache.set(dir, entries); changed = true; }
    }
    if (changed) renderFiles();
  } catch { /* editor stopped */ } finally { refreshingFiles = false; }
}
$("#files-refresh").onclick = () => { filesState.cache.clear(); renderFiles(); };
$("#files-toggle").onclick = () => { layout.filesCollapsed = !layout.filesCollapsed; applyLayout(); if (!layout.filesCollapsed) renderFiles(); };
let filesSearchTimer = null;
$("#files-search").addEventListener("input", (e) => {
  clearTimeout(filesSearchTimer);
  filesSearchTimer = setTimeout(() => { filesState.query = e.target.value.trim(); renderFiles(); }, 150);
});
$("#files-search").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") { e.target.value = ""; filesState.query = ""; renderFiles(); }
  if (e.key === "Enter") { const first = filesEl.querySelector(".file"); if (first) { first.click(); if (!first.querySelector(".caret").textContent) openInIde(first.dataset.path, 1, 1); } }
});
// Refresh when the window gets focus again (files may have changed in VS Code) and every few seconds.
window.addEventListener("focus", () => { if (state.project) refreshFiles(); });
setInterval(() => { if (state.project && !layout.filesCollapsed && !document.hidden) refreshFiles(); }, 5000);

/** Marks the file that creates the selected object. */
async function markLinkedFile(o) {
  const m = o && metaOf(o);
  let file = null;
  if (m && m.declId) {
    await loadInfo([m.declId]);
    file = state.info.get(m.declId)?.file || null;
  }
  if (state.selected !== o) return;
  filesState.linked = file ? file.split("\\").join("/") : null;
  for (const r of filesEl.querySelectorAll(".file")) r.classList.toggle("linked", r.dataset.path === filesState.linked);
}


// ---------------------------------------------------------------- mute the game
const MUTE_KEY = "pixi-editor:muted";
const muteBtn = $("#btn-mute");
let gameMuted = false;
try { gameMuted = localStorage.getItem(MUTE_KEY) === "1"; } catch { /* private mode */ }
function applyMute() {
  muteBtn.classList.toggle("muted", gameMuted);
  muteBtn.title = gameMuted ? "Unmute the game (M)" : "Mute the game (M) — the editor's own previews still play";
  try { localStorage.setItem(MUTE_KEY, gameMuted ? "1" : "0"); } catch { /* private mode */ }
  try {
    const pe = iframe.contentWindow && iframe.contentWindow.__PIXI_EDITOR__;
    if (pe && pe.setMuted) pe.setMuted(gameMuted);
  } catch { /* game not loaded */ }
}
muteBtn.onclick = () => { gameMuted = !gameMuted; applyMute(); };
// The runtime starts before the game: tell it as soon as the page exists, and again once connected.
iframe.addEventListener("load", applyMute);
applyMute();


// ---------------------------------------------------------------- file previews in the inspector
const TEXT_EXT = /\.(m?[jt]sx?|cjs|json|fnt|md|txt|css|scss|html?|atlas|xml|ya?ml|csv|glsl|frag|vert|wgsl|svg|env|gitignore|prettierrc|eslintrc|editorconfig|log)$/i;
const fileUrl = (p) => `/__pixi-editor/api/file?path=${encodeURIComponent(p)}`;

/** Shows a project file in the inspector (the scene selection is cleared). */
function openFileView(e) {
  state.fileView = e;
  if (state.selected) { state.selected = null; renderTree(); render(); }
  renderInspector();
}

function fileHeader(e, kind) {
  const head = document.createElement("div");
  head.className = "obj-head file-head";
  head.innerHTML = `<div class="obj-row"><div class="file-title"></div><button class="ghost" title="Open in VS Code">Open ↗</button></div><div class="obj-type"></div>`;
  head.querySelector(".file-title").textContent = e.name;
  head.querySelector(".obj-type").textContent = `${kind} · ${e.path} · ${formatSize(e.size)}`;
  head.querySelector("button").onclick = () => openInIde(e.path, 1, 1);
  return head;
}

async function renderFileView(e) {
  inspectorEl.innerHTML = "";
  const view = document.createElement("div");
  view.className = "file-view";
  inspectorEl.appendChild(view);
  const spine = await spineFilesFor(e);
  if (state.fileView !== e) return;
  if (spine) return renderSpineView(view, e, spine);
  if (IMG_EXT.test(e.name)) return renderImageView(view, e);
  if (AUDIO_EXT.test(e.name)) return renderAudioView(view, e);
  if (TEXT_EXT.test(e.name) || !/\.[a-z0-9]+$/i.test(e.name)) return renderCodeView(view, e);
  view.appendChild(fileHeader(e, "File"));
  view.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "No preview for this kind of file." }));
}

// ---- images
function renderImageView(view, e) {
  view.appendChild(fileHeader(e, "Image"));
  const bar = document.createElement("div");
  bar.className = "preview-bar";
  bar.innerHTML = `<div class="seg"><button data-bg="checker" class="on">Checker</button><button data-bg="dark">Dark</button><button data-bg="light">Light</button></div><button class="ghost" data-zoom>Fit</button>`;
  const stage = document.createElement("div");
  stage.className = "image-stage bg-checker fit";
  const img = document.createElement("img");
  img.src = fileUrl(e.path);
  img.onload = () => { info.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`; };
  img.onerror = () => { info.textContent = "Could not load the image."; };
  stage.appendChild(img);
  const info = document.createElement("p");
  info.className = "note";
  bar.querySelectorAll("[data-bg]").forEach((b) => {
    b.onclick = () => {
      bar.querySelectorAll("[data-bg]").forEach((x) => x.classList.toggle("on", x === b));
      stage.className = stage.className.replace(/bg-\w+/, `bg-${b.dataset.bg}`);
    };
  });
  const zoomBtn = bar.querySelector("[data-zoom]");
  zoomBtn.onclick = () => { stage.classList.toggle("fit"); zoomBtn.textContent = stage.classList.contains("fit") ? "Fit" : "100%"; };
  view.append(bar, stage, info);
}

// ---- audio
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
function renderAudioView(view, e) {
  view.appendChild(fileHeader(e, "Sound"));
  const box = document.createElement("div");
  box.className = "audio-player";
  box.innerHTML = `
    <canvas class="wave" height="96"></canvas>
    <div class="audio-controls">
      <button class="primary play" title="Play / pause (Space)">▶</button>
      <span class="time">0:00 / 0:00</span>
      <label class="loop"><input type="checkbox"> Loop</label>
      <input class="vol" type="range" min="0" max="1" step="0.01" value="0.8" title="Volume">
    </div>
    <p class="note"></p>`;
  view.appendChild(box);
  const audio = new Audio(fileUrl(e.path));
  audio.volume = 0.8;
  const canvas = box.querySelector("canvas");
  const playBtn = box.querySelector(".play");
  const time = box.querySelector(".time");
  const note = box.querySelector(".note");
  let peaks = null, raf = 0;
  const draw = () => {
    const w = canvas.clientWidth || 260, h = canvas.height;
    if (canvas.width !== w) canvas.width = w;
    const c = canvas.getContext("2d");
    c.clearRect(0, 0, w, h);
    const p = audio.duration ? audio.currentTime / audio.duration : 0;
    const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#ff4f8b";
    for (let x = 0; x < w; x++) {
      const v = peaks ? peaks[Math.floor((x / w) * peaks.length)] || 0 : 0.04;
      const bh = Math.max(1, v * (h - 8));
      c.fillStyle = x / w <= p ? accent : "#59606d";
      c.fillRect(x, (h - bh) / 2, 1, bh);
    }
    time.textContent = `${fmtTime(audio.currentTime || 0)} / ${fmtTime(audio.duration || 0)}`;
  };
  const loop = () => { draw(); if (!audio.paused) raf = requestAnimationFrame(loop); };
  audio.addEventListener("loadedmetadata", draw);
  audio.addEventListener("play", () => { playBtn.textContent = "❚❚"; loop(); });
  audio.addEventListener("pause", () => { playBtn.textContent = "▶"; draw(); });
  audio.addEventListener("ended", () => { playBtn.textContent = "▶"; draw(); });
  audio.addEventListener("error", () => { note.textContent = "This browser can't play this file."; });
  playBtn.onclick = () => (audio.paused ? audio.play() : audio.pause());
  box.querySelector(".loop input").onchange = (ev) => { audio.loop = ev.target.checked; };
  box.querySelector(".vol").oninput = (ev) => { audio.volume = Number(ev.target.value); };
  canvas.onclick = (ev) => {
    if (!audio.duration) return;
    const r = canvas.getBoundingClientRect();
    audio.currentTime = ((ev.clientX - r.left) / r.width) * audio.duration;
    draw();
  };
  const onKeyAudio = (ev) => {
    if (ev.key !== " " || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
    ev.preventDefault(); ev.stopPropagation();
    playBtn.click();
  };
  window.addEventListener("keydown", onKeyAudio, true);
  // Waveform: decode the file once.
  (async () => {
    try {
      const buf = await (await fetch(fileUrl(e.path))).arrayBuffer();
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 2, 44100);
      const data = await ctx.decodeAudioData(buf);
      const ch = data.getChannelData(0);
      const n = 600, step = Math.max(1, Math.floor(ch.length / n));
      peaks = new Float32Array(n);
      let max = 0;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += 4) m = Math.max(m, Math.abs(ch[j]));
        peaks[i] = m;
        max = Math.max(max, m);
      }
      if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max;
      note.textContent = `${data.numberOfChannels === 1 ? "Mono" : "Stereo"} · ${data.duration.toFixed(2)} s`;
      draw();
    } catch { /* no waveform */ }
  })();
  draw();
  state.previewCleanup = () => { audio.pause(); audio.src = ""; cancelAnimationFrame(raf); window.removeEventListener("keydown", onKeyAudio, true); };
}

// ---- code and text
const JS_KEYWORDS = new Set("abstract as async await break case catch class const continue default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while yield".split(" "));
/** Tiny highlighter for JS/TS/JSON: returns [{ cls, text }] tokens. */
function tokenize(code, lang) {
  const re = lang === "plain" ? /(\n)|([^\n]+)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*(?=\n|$))|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b(?:0x[\da-f]+|\d+\.?\d*(?:e[+-]?\d+)?)\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`/#]+|\/)|[\s\S]/gi;
  const out = [];
  let m;
  while ((m = re.exec(code))) {
    if (lang === "plain") { out.push({ cls: "", text: m[0] }); continue; }
    if (m[1]) out.push({ cls: lang === "json" || (m[1][0] === "#" && lang !== "atlas" && lang !== "yaml") ? "" : "c", text: m[1] });
    else if (m[2]) out.push({ cls: lang === "json" && /^\s*:/.test(code.slice(re.lastIndex)) ? "k" : "s", text: m[2] });
    else if (m[3]) out.push({ cls: "n", text: m[3] });
    else if (m[4]) out.push({ cls: lang === "json" ? (/^(true|false|null)$/.test(m[4]) ? "kw" : "") : JS_KEYWORDS.has(m[4]) ? "kw" : /^[A-Z]/.test(m[4]) ? "t" : "", text: m[4] });
    else out.push({ cls: "", text: m[0] });
  }
  return out;
}
async function renderCodeView(view, e) {
  view.appendChild(fileHeader(e, "Text"));
  if (e.size > 2e6) { view.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: "This file is too big to preview." })); return; }
  let text = await (await fetch(fileUrl(e.path))).text();
  if (state.fileView !== e) return;
  const ext = (/\.([a-z0-9]+)$/i.exec(e.name) || [, ""])[1].toLowerCase();
  const lang = ext === "json" ? "json" : /^(m?[jt]sx?|cjs)$/.test(ext) ? "js" : ext === "atlas" ? "atlas" : /^(css|scss|glsl|frag|vert|wgsl)$/.test(ext) ? "js" : "plain";
  const bar = document.createElement("div");
  bar.className = "preview-bar";
  const lines0 = text.split("\n");
  bar.innerHTML = `<span class="note">${lines0.length} lines</span>`;
  // Minified JSON: offer to format it.
  if (lang === "json" && lines0.some((l) => l.length > 300)) {
    const fmtBtn = document.createElement("button");
    fmtBtn.className = "ghost";
    fmtBtn.textContent = "Format";
    fmtBtn.onclick = () => { try { text = JSON.stringify(JSON.parse(text), null, 2); draw(); fmtBtn.remove(); } catch { fmtBtn.textContent = "Invalid JSON"; } };
    bar.appendChild(fmtBtn);
  }
  const pre = document.createElement("div");
  pre.className = "code-view";
  view.append(bar, pre);
  const MAX_LINES = 4000;
  const draw = () => {
    const toks = tokenize(text, lang);
    const lines = [[]];
    for (const t of toks) {
      const parts = t.text.split("\n");
      parts.forEach((p, i) => { if (i) lines.push([]); if (p) lines[lines.length - 1].push({ cls: t.cls, text: p }); });
    }
    const frag = document.createDocumentFragment();
    lines.slice(0, MAX_LINES).forEach((line, i) => {
      const row = document.createElement("div");
      row.className = "code-line";
      const ln = document.createElement("span");
      ln.className = "ln";
      ln.textContent = i + 1;
      const code = document.createElement("span");
      code.className = "code";
      for (const t of line) {
        if (!t.cls) { code.append(t.text); continue; }
        const sp = document.createElement("span");
        sp.className = `tk-${t.cls}`;
        sp.textContent = t.text;
        code.appendChild(sp);
      }
      row.append(ln, code);
      row.ondblclick = () => openInIde(e.path, i + 1, 1);
      frag.appendChild(row);
    });
    if (lines.length > MAX_LINES) frag.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: `… ${lines.length - MAX_LINES} more lines (open the file to see them).` }));
    pre.replaceChildren(frag);
  };
  draw();
}

// ---- spine skeletons (.atlas, or a skeleton .json/.skel next to its .atlas)
const stripExt = (p) => p.replace(/\.[^./]+$/, "");
async function dirEntries(dir) {
  try { return await loadDir(dir); } catch { return []; }
}
/** { atlas, skeleton } project paths when `e` is part of a Spine export, else null. */
async function spineFilesFor(e) {
  const isAtlas = /\.atlas(\.txt)?$/i.test(e.name);
  const isSkel = /\.(json|skel)$/i.test(e.name);
  if (!isAtlas && !isSkel) return null;
  const dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
  const files = (await dirEntries(dir)).filter((x) => x.type === "file");
  const base = stripExt(e.path.replace(/\.txt$/i, ""));
  if (isAtlas) {
    const skels = files.filter((x) => /\.(json|skel)$/i.test(x.name));
    const skel = skels.find((x) => stripExt(x.path) === base) || (skels.length === 1 ? skels[0] : null);
    return skel ? { atlas: e.path, skeleton: skel.path } : { atlas: e.path, skeleton: null };
  }
  const atlases = files.filter((x) => /\.atlas(\.txt)?$/i.test(x.name));
  const atlas = atlases.find((x) => stripExt(x.path.replace(/\.txt$/i, "")) === base);
  if (!atlas) return null;
  if (/\.json$/i.test(e.name)) {
    // Only Spine exports: { "skeleton": {…}, "bones": […] }
    try { const head = (await (await fetch(fileUrl(e.path))).text()).slice(0, 4000); if (!/"skeleton"\s*:/.test(head) || !/"bones"\s*:/.test(head)) return null; } catch { return null; }
  }
  return { atlas: atlas.path, skeleton: e.path };
}
/** URL the game serves a project file at (Vite serves public/ at the root). */
const servedUrl = (p) => "/" + p.replace(/^public\//, "");

async function spineRuntime() {
  if (state.spineMod !== undefined && state.spineModWin === state.win) return state.spineMod;
  state.spineModWin = state.win;
  try { const mod = await state.win.eval(`import("/@pixi-editor/spine.ts")`); state.spineMod = mod.available ? mod : null; }
  catch { state.spineMod = null; }
  return state.spineMod;
}

/** Back to the setup pose (Spine 4.2: setToSetupPose / 4.3: setupPose). */
function setupPose(sk, slotsOnly = false) {
  const fn = slotsOnly ? sk.setupPoseSlots || sk.setSlotsToSetupPose : sk.setupPose || sk.setToSetupPose;
  if (fn) fn.call(sk);
}

async function renderSpineView(view, e, files) {
  view.appendChild(fileHeader(e, "Spine"));
  const msg = (text) => { const p = document.createElement("p"); p.className = "note"; p.style.padding = "8px 12px"; p.textContent = text; view.appendChild(p); return p; };
  if (!files.skeleton) { msg("No skeleton (.json or .skel) with the same name was found next to this atlas."); return; }
  if (!state.app || !state.PIXI) { msg("Waiting for the game to load — the preview uses the game's own Pixi and Spine."); return; }
  const Spine = (await spineRuntime())?.Spine;
  if (!Spine) { msg("This project doesn't use the Spine runtime for Pixi (@esotericsoftware/spine-pixi-v8)."); return; }
  if (state.fileView !== e) return;
  const P = state.PIXI;
  const loading = msg("Loading skeleton…");

  // Reuse what the game already loaded; otherwise load it (same URLs the game would use).
  let keys = loadedSpines().find((sp) => sp.skeleton.some((k) => baseName(k) === baseName(files.skeleton)) && sp.atlas.some((k) => baseName(k) === baseName(files.atlas)));
  let skelKey, atlasKey;
  if (keys) { skelKey = keys.skeleton[0]; atlasKey = keys.atlas[0]; }
  else {
    skelKey = `pixi-editor:${files.skeleton}`;
    atlasKey = `pixi-editor:${files.atlas}`;
    try {
      if (!P.Cache.has(atlasKey)) await P.Assets.load({ alias: atlasKey, src: servedUrl(files.atlas) });
      if (!P.Cache.has(skelKey)) await P.Assets.load({ alias: skelKey, src: servedUrl(files.skeleton) });
    } catch (err) {
      loading.textContent = `Could not load the skeleton: ${err.message || err}`;
      return;
    }
  }
  if (state.fileView !== e) return;
  let sp;
  try { sp = Spine.from({ skeleton: skelKey, atlas: atlasKey }); } catch (err) { loading.textContent = `Could not create the spine: ${err.message || err}`; return; }
  sp.autoUpdate = false;
  loading.remove();

  const data = sp.skeleton.data;
  const anims = data.animations;
  const skins = data.skins.map((s) => s.name);
  const box = document.createElement("div");
  box.className = "spine-preview";
  box.innerHTML = `
    <div class="preview-bar"><div class="seg"><button data-bg="checker" class="on">Checker</button><button data-bg="dark">Dark</button><button data-bg="light">Light</button></div></div>
    <div class="spine-stage bg-checker"><canvas></canvas></div>
    <div class="audio-controls spine-controls">
      <button class="primary play" title="Play / pause (Space)">❚❚</button>
      <span class="time">0.00 s</span>
      <label class="loop"><input type="checkbox" checked> Loop</label>
      <select class="speed" title="Speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
    </div>
    <div class="row single skin-row"><label>Skin</label><div class="field"><select class="skin"></select></div></div>
    <div class="anim-list"></div>
    <p class="note spine-info"></p>`;
  view.appendChild(box);
  const canvas = box.querySelector("canvas");
  const stage = box.querySelector(".spine-stage");
  const playBtn = box.querySelector(".play");
  const timeEl = box.querySelector(".time");
  const loopBox = box.querySelector(".loop input");
  const speedSel = box.querySelector(".speed");
  const list = box.querySelector(".anim-list");
  box.querySelector(".spine-info").textContent = `${anims.length} animations · ${data.bones.length} bones · ${data.slots.length} slots · ${files.skeleton} + ${files.atlas}`;
  box.querySelectorAll("[data-bg]").forEach((b) => {
    b.onclick = () => {
      box.querySelectorAll("[data-bg]").forEach((x) => x.classList.toggle("on", x === b));
      stage.className = stage.className.replace(/bg-\w+/, `bg-${b.dataset.bg}`);
    };
  });
  const skinSel = box.querySelector(".skin");
  if (skins.length > 1) {
    for (const s of skins) skinSel.appendChild(Object.assign(document.createElement("option"), { value: s, textContent: s }));
    skinSel.onchange = () => { sp.skeleton.setSkinByName(skinSel.value); setupPose(sp.skeleton, true); fit(); };
  } else box.querySelector(".skin-row").remove();

  const container = new P.Container();
  container.addChild(sp);
  const W = 480, H = 360; // render size (scaled by CSS)
  canvas.width = W;
  canvas.height = H;
  const rt = P.RenderTexture.create({ width: W, height: H, resolution: 1 });
  let current = null, playing = true, raf = 0, last = performance.now(), elapsed = 0;

  /** Scales and centers the skeleton to show the whole animation. */
  function fit() {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const add = () => { const r = sp.getLocalBounds(); if (r.width > 0 && r.height > 0) { b.minX = Math.min(b.minX, r.minX ?? r.x); b.minY = Math.min(b.minY, r.minY ?? r.y); b.maxX = Math.max(b.maxX, r.maxX ?? r.x + r.width); b.maxY = Math.max(b.maxY, r.maxY ?? r.y + r.height); } };
    const dur = current ? current.duration : 0;
    if (current && dur > 0) {
      sp.state.setAnimation(0, current.name, false);
      for (let i = 0; i <= 8; i++) { sp.update(i ? dur / 8 : 0); add(); }
      sp.state.setAnimation(0, current.name, loopBox.checked);
      sp.update(0);
    } else { sp.update(0); add(); }
    if (!isFinite(b.minX)) { b.minX = -100; b.minY = -100; b.maxX = 100; b.maxY = 100; }
    const k = Math.min((W * 0.88) / (b.maxX - b.minX), (H * 0.88) / (b.maxY - b.minY), 4);
    sp.scale.set(k);
    sp.position.set(W / 2 - ((b.minX + b.maxX) / 2) * k, H / 2 - ((b.minY + b.maxY) / 2) * k);
    elapsed = 0;
  }
  function play(anim) {
    current = anim;
    list.querySelectorAll(".anim").forEach((x) => x.classList.toggle("on", x.dataset.name === anim.name));
    sp.state.clearTracks();
    setupPose(sp.skeleton);
    fit();
    playing = true;
    playBtn.textContent = "❚❚";
  }
  for (const a of anims) {
    const row = document.createElement("button");
    row.className = "anim";
    row.dataset.name = a.name;
    row.innerHTML = `<span></span><small></small>`;
    row.querySelector("span").textContent = a.name;
    row.querySelector("small").textContent = `${a.duration.toFixed(2)} s`;
    row.onclick = () => play(a);
    list.appendChild(row);
  }
  if (!anims.length) list.innerHTML = `<p class="note">This skeleton has no animations (setup pose shown).</p>`;

  const draw = () => {
    try {
      state.app.renderer.render({ container, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
      const src = state.app.renderer.extract.canvas(rt);
      const c = canvas.getContext("2d");
      c.clearRect(0, 0, W, H);
      c.drawImage(src, 0, 0, W, H);
    } catch { /* renderer busy or lost */ }
  };
  const tick = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      const speed = Number(speedSel.value);
      sp.update(dt * speed);
      elapsed += dt * speed;
      const entry = sp.state.tracks[0];
      if (entry && current) {
        const t = loopBox.checked && current.duration > 0 ? elapsed % current.duration : Math.min(elapsed, current.duration);
        timeEl.textContent = `${t.toFixed(2)} / ${current.duration.toFixed(2)} s`;
        if (!loopBox.checked && elapsed >= current.duration) { playing = false; playBtn.textContent = "▶"; }
      }
    }
    // ~30 fps is plenty for a preview (each frame is read back from the GPU).
    if (now - lastDraw > 30) { lastDraw = now; draw(); }
    raf = requestAnimationFrame(tick);
  };
  let lastDraw = 0;
  playBtn.onclick = () => {
    if (!playing && current && !loopBox.checked && elapsed >= current.duration) play(current);
    else { playing = !playing; playBtn.textContent = playing ? "❚❚" : "▶"; }
  };
  loopBox.onchange = () => { if (current) { const t = sp.state.tracks[0]; if (t) t.loop = loopBox.checked; } };
  const onKeySpine = (ev) => {
    if (ev.key !== " " || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) return;
    ev.preventDefault(); ev.stopPropagation();
    playBtn.click();
  };
  window.addEventListener("keydown", onKeySpine, true);
  if (anims.length) play(anims.find((a) => /idle|loop/i.test(a.name)) || anims[0]); else fit();
  raf = requestAnimationFrame(tick);
  state.previewCleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKeySpine, true);
    try { container.destroy({ children: true }); rt.destroy(true); } catch { /* already gone */ }
  };
}
