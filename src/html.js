// The project's index.html: finds its elements and the places that set their properties
// (style declarations, attributes, text), and rewrites them when the editor saves.
//
//   <div id="credits" style="left: 8px; color: #888">Made with Pixi</div>
//     element  -> one declaration (where new attributes go)
//     left/color in style="…"   -> css:left, css:color
//     id="credits"              -> attr:id
//     Made with Pixi            -> attr:textContent
//
// No HTML parser dependency: only start tags, their attributes and plain text are needed, and the
// game page maps each scanned tag to its element through a data attribute added when serving it.

// Elements whose content is not markup.
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "template", "xmp", "noscript"]);
// Not listed (document structure, head, scripts).
const SKIP = new Set(["html", "head", "body", "meta", "link", "script", "style", "title", "base", "noscript", "template"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// HTML attribute -> the element property the editor uses (attr:<property>)
export const ATTR_PROPS = {
  id: "id", class: "className", title: "title", placeholder: "placeholder", value: "value", type: "type",
  src: "src", href: "href", alt: "alt", maxlength: "maxLength", min: "min", max: "max", step: "step", for: "htmlFor",
};
const PROP_ATTRS = Object.fromEntries(Object.entries(ATTR_PROPS).map(([a, p]) => [p, a]));
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/**
 * The elements of an HTML file, in document order:
 * [{ tag, start, end, insertAt, attrs: [{ name, valueStart, valueEnd, quote, value }], text: { start, end } | null }]
 * `insertAt` is where a new attribute goes (before `>` or `/>`); `text` is set when the element
 * holds plain text only (no child elements).
 */
export function scanHtml(code) {
  const els = [];
  const lower = code.toLowerCase();
  const n = code.length;
  let i = 0;
  while (i < n) {
    const lt = code.indexOf("<", i);
    if (lt < 0) break;
    if (code.startsWith("<!--", lt)) { const e = code.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (code[lt + 1] === "!" || code[lt + 1] === "?" || code[lt + 1] === "/") { const e = code.indexOf(">", lt); i = e < 0 ? n : e + 1; continue; }
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(code.slice(lt, lt + 80));
    if (!m) { i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    const attrs = [];
    let j = lt + m[0].length;
    let end = -1, selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(code[j])) j++;
      if (code[j] === ">") { end = j + 1; break; }
      if (code[j] === "/" && code[j + 1] === ">") { end = j + 2; selfClosing = true; break; }
      ATTR_RE.lastIndex = j;
      const a = ATTR_RE.exec(code);
      if (!a) { j++; continue; }
      const attr = { name: a[1].toLowerCase(), valueStart: -1, valueEnd: -1, quote: null, value: null };
      if (a[2] != null || a[3] != null || a[4] != null) {
        attr.quote = a[2] != null ? '"' : a[3] != null ? "'" : "";
        attr.value = a[2] ?? a[3] ?? a[4];
        attr.valueEnd = j + a[0].length - attr.quote.length;
        attr.valueStart = attr.valueEnd - attr.value.length;
      }
      attrs.push(attr);
      j += a[0].length;
    }
    if (end < 0) break;
    let insertAt = selfClosing ? end - 2 : end - 1;
    while (insertAt > lt && /\s/.test(code[insertAt - 1])) insertAt--; // `<img a="b" />`: before the space
    const el = { tag, start: lt, end, insertAt, attrs, text: null };
    i = end;
    if (RAW_TEXT.has(tag)) {
      const close = lower.indexOf(`</${tag}`, end);
      i = close < 0 ? n : close;
    } else if (!VOID.has(tag) && !selfClosing) {
      // Plain text up to its own end tag: <button>Play</button>, <div></div>
      const next = code.indexOf("<", end);
      const closeTag = `</${tag}`;
      if (next >= 0 && lower.startsWith(closeTag, next) && /[\s>]/.test(code[next + closeTag.length] || "")) {
        const inner = code.slice(end, next);
        const lead = inner.length - inner.trimStart().length;
        const trail = inner.length - inner.trimEnd().length;
        el.text = inner.trim() ? { start: end + lead, end: next - trail } : { start: end, end: next };
      }
    }
    if (!SKIP.has(tag)) els.push(el);
  }
  return els;
}

/** The declarations of a style attribute: [{ prop, start, end }] (value ranges relative to `text`, without `!important`). */
export function parseStyle(text) {
  const out = [];
  let depth = 0, quote = null, from = 0;
  const flush = (to) => {
    const part = text.slice(from, to);
    const colon = part.indexOf(":");
    if (colon > 0) {
      const prop = part.slice(0, colon).trim().toLowerCase();
      let vs = from + colon + 1, ve = to;
      while (vs < ve && /\s/.test(text[vs])) vs++;
      while (ve > vs && /\s/.test(text[ve - 1])) ve--;
      const imp = /\s*!\s*important$/i.exec(text.slice(vs, ve));
      if (imp) ve -= imp[0].length;
      if (prop) out.push({ prop, start: vs, end: ve });
    }
    from = to + 1;
  };
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) flush(k);
  }
  flush(text.length);
  return out;
}

/**
 * Code sites and declarations for the elements of an HTML file, in the editor's registry format.
 * `idFor(key, prefix)` returns the id to use for a key (stable across rescans of the same file).
 * @returns {{ decls: object[], sites: object[], marks: { at: number, text: string }[] }}
 *   `marks` are the data attributes that tie each tag to its element in the game page.
 */
export function htmlRegistry(code, idFor) {
  const decls = [];
  const sites = [];
  const marks = [];
  scanHtml(code).forEach((el, k) => {
    const declId = idFor(`${k}`, "d");
    const name = el.attrs.find((a) => a.name === "id" && a.value) ? `#${el.attrs.find((a) => a.name === "id").value}` : el.tag;
    decls.push({ id: declId, name, html: true, tag: el.tag, access: null, insertAt: el.insertAt, start: el.start, end: el.end });
    const own = new Map(); // kind -> site (the last declaration of a property wins, as in the browser)
    const add = (kind, form, start, end, extra = {}) => {
      own.set(kind, { id: idFor(`${k}|${kind}`, "s"), kind, form, html: true, declId, args: [{ start, end, text: code.slice(start, end) }], ...extra });
    };
    for (const a of el.attrs) {
      if (a.valueStart < 0) continue;
      if (a.name === "style") {
        add("html:style", "html-style", a.valueStart, a.valueEnd, { quote: a.quote });
        for (const d of parseStyle(a.value)) add(`css:${d.prop}`, "html-css", a.valueStart + d.start, a.valueStart + d.end, { quote: a.quote });
      } else if (ATTR_PROPS[a.name]) {
        add(`attr:${ATTR_PROPS[a.name]}`, "html-attr", a.valueStart, a.valueEnd, { quote: a.quote });
      }
    }
    if (el.text) add("attr:textContent", "html-text", el.text.start, el.text.end);
    sites.push(...own.values());
    const tag = [declId, ...[...own.values()].filter((s) => s.kind !== "html:style").map((s) => `${s.kind}=${s.id}`)].join(" ");
    marks.push({ at: el.insertAt, text: ` data-pe="${tag}"` });
  });
  return { decls, sites, marks };
}

/** The HTML with the data attributes inserted (for the game page only, never written to disk). */
export function markHtml(code, marks) {
  let out = code;
  for (const mk of [...marks].sort((a, b) => b.at - a.at)) out = out.slice(0, mk.at) + mk.text + out.slice(mk.at);
  return out;
}

const escAttr = (v, quote) => String(v).replace(/&/g, "&amp;").replace(quote === "'" ? /'/g : /"/g, quote === "'" ? "&#39;" : "&quot;").replace(/</g, "&lt;");
const escText = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Text edits for an HTML file.
 * @param {object[]} siteEdits  [{ site, value }]
 * @param {object[]} inserts    [{ decl, kind, value }]
 * @param {(declId: string) => object|null} styleSiteOf  the element's style attribute site, if any
 */
export function planHtmlEdits(code, siteEdits, inserts, styleSiteOf = () => null, opts = {}) {
  // Inside a JS string (an innerHTML template): attributes use `attrQuote` and every text written
  // goes through `escape` (backslashes, the string's quote, `${`).
  const { attrQuote = '"', escape = (t) => t, where = "index.html" } = opts;
  const edits = [];
  const errors = [];
  for (const { site, value } of siteEdits) {
    const a = site.args[0];
    if (code.slice(a.start, a.end) !== a.text) {
      errors.push(`${where} changed since the game was loaded. Reload the game.`);
      return { edits: [], errors };
    }
    let text;
    if (site.form === "html-text") text = escText(value);
    else if (site.form === "html-attr" && !site.quote) text = `${attrQuote}${escAttr(value, attrQuote)}${attrQuote}`; // unquoted: add quotes
    else if (site.form === "html-attr" || site.form === "html-css") text = escAttr(value, site.quote);
    else { errors.push(`Can't save ${site.kind} in ${where}.`); continue; }
    edits.push({ start: a.start, end: a.end, text: escape(text), site, argIndex: 0 });
  }

  const byDecl = new Map();
  for (const ins of inserts) {
    if (!byDecl.has(ins.decl.id)) byDecl.set(ins.decl.id, []);
    byDecl.get(ins.decl.id).push(ins);
  }
  for (const [declId, list] of byDecl) {
    const decl = list[0].decl;
    const styleSite = styleSiteOf(declId);
    const css = list.filter((x) => x.kind.startsWith("css:"));
    let attrText = "";
    const computed = decl.computed || [];
    const isComputed = (name) => computed.includes(name) && (errors.push(`${name === "#text" ? "The text" : name} of ${decl.name} is written by code (\${…}) in ${where}, so it can't be overwritten.`), true);
    if (css.length && isComputed("style")) css.length = 0;
    for (const ins of list.filter((x) => x.kind.startsWith("attr:"))) {
      const prop = ins.kind.slice(5);
      if ((prop === "textContent" || prop === "innerText") && isComputed("#text")) continue;
      if (isComputed(PROP_ATTRS[prop] || prop.toLowerCase())) continue;
      if (prop === "textContent" || prop === "innerText") { errors.push(`Can't add text to ${decl.name} in ${where}: it holds other elements.`); continue; }
      if (prop === "disabled") { if (ins.value === true) attrText += " disabled"; continue; }
      attrText += ` ${PROP_ATTRS[prop] || prop.toLowerCase()}=${attrQuote}${escAttr(ins.value, attrQuote)}${attrQuote}`;
    }
    if (css.length && styleSite) {
      const a = styleSite.args[0];
      if (code.slice(a.start, a.end) !== a.text) { errors.push(`${where} changed since the game was loaded. Reload the game.`); return { edits: [], errors }; }
      const decls = css.map((x) => `${x.kind.slice(4)}: ${escAttr(x.value, styleSite.quote)}`).join("; ");
      const t = a.text;
      const text = !t.trim() ? decls : /;\s*$/.test(t) ? `${/\s$/.test(t) ? "" : " "}${decls};` : `; ${decls}`;
      edits.push({ start: a.end, end: a.end, text: escape(text), declId, kinds: css.map((x) => x.kind) });
    } else if (css.length) {
      attrText += ` style=${attrQuote}${css.map((x) => `${x.kind.slice(4)}: ${escAttr(x.value, attrQuote)}`).join("; ")}${attrQuote}`;
    }
    if (attrText) edits.push({ start: decl.insertAt, end: decl.insertAt, text: escape(attrText), declId });
  }
  return { edits, errors };
}

/** Applies text edits (any order). */
export function applyHtmlEdits(code, edits) {
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  return code;
}

// ---------------------------------------------------------------- HTML inside JS strings
// `mount.innerHTML = \`<section class="panel">…${label}…</section>\`` — the static parts of the
// template are HTML the editor can link and edit. `${…}` parts are computed: a value that contains
// one is shown but never overwritten.
export const PH = ""; // stands for a `${…}` in the scanned text

/**
 * Code sites for the elements written in one template.
 * @param {string} text   the template's text, `${…}` replaced by PH (same length as the source otherwise)
 * @param {(p: number) => number} toSource  position in `text` -> position in the file
 * @param {string} key    unique per template in the file (stable ids)
 * @param {object} js     { quote: "`" | "'" | '"' } the JS string's delimiter
 * @returns {{ decls, sites, marks }}  marks are in file positions
 */
export function templateRegistry(text, toSource, code, idFor, key, js) {
  const decls = [];
  const sites = [];
  const marks = [];
  scanHtml(text).forEach((el, j) => {
    const declId = idFor(`${key}|${j}`, "d");
    const idAttr = el.attrs.find((a) => a.name === "id" && a.value && !a.value.includes(PH));
    // attributes (and text) written with ${…}: shown, never written again
    const computed = el.attrs.filter((a) => (a.value || "").includes(PH) || a.name.includes(PH)).map((a) => a.name);
    if (el.text && text.slice(el.text.start, el.text.end).includes(PH)) computed.push("#text");
    decls.push({ id: declId, name: idAttr ? `#${idAttr.value}` : el.tag, html: true, tpl: true, jsQuote: js.quote, tag: el.tag, access: null, insertAt: toSource(el.insertAt), start: toSource(el.start), end: toSource(el.end), computed });
    const own = new Map();
    const add = (kind, form, start, end, extra = {}) => {
      const s = toSource(start), e = toSource(end);
      own.set(kind, { id: idFor(`${key}|${j}|${kind}`, "s"), kind, form, html: true, tpl: true, jsQuote: js.quote, declId, args: [{ start: s, end: e, text: code.slice(s, e) }], ...extra });
    };
    for (const a of el.attrs) {
      if (a.valueStart < 0 || a.value.includes(PH)) continue;
      if (a.name === "style") {
        add("html:style", "html-style", a.valueStart, a.valueEnd, { quote: a.quote });
        for (const d of parseStyle(a.value)) add(`css:${d.prop}`, "html-css", a.valueStart + d.start, a.valueStart + d.end, { quote: a.quote });
      } else if (ATTR_PROPS[a.name]) {
        add(`attr:${ATTR_PROPS[a.name]}`, "html-attr", a.valueStart, a.valueEnd, { quote: a.quote });
      }
    }
    if (el.text && !text.slice(el.text.start, el.text.end).includes(PH)) add("attr:textContent", "html-text", el.text.start, el.text.end);
    sites.push(...own.values());
    const tag = [declId, "tpl", ...[...own.values()].filter((x) => x.kind !== "html:style").map((x) => `${x.kind}=${x.id}`)].join(" ");
    // inside a "…" JS string the attribute is quoted with ' (and the other way round)
    const q = js.quote === '"' ? "'" : '"';
    marks.push({ at: toSource(el.insertAt), text: ` data-pe=${q}${tag}${q}` });
  });
  return { decls, sites, marks };
}

/** Escapes text written into a JS string with delimiter `quote`. */
export function jsEscaper(quote) {
  if (quote === "`") return (t) => t.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return (t) => t.replace(/\\/g, "\\\\").replace(quote === "'" ? /'/g : /"/g, "\\" + quote).replace(/\n/g, "\\n");
}
