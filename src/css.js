// The project's CSS files: finds style rules and their declarations, so the editor can show the
// rules that apply to an HTML element and save changes back into the file.
//
//   @media (max-width: 900px) {
//     .bet-action { min-height: 54px; color: #fff }
//   }
//     rule  -> key "@media(max-width:900px)|.bet-action|0" (at-rule path, selector, occurrence)
//     min-height / color values -> code sites `css:min-height`, `css:color`
//
// The browser's CSSOM gives the same keys for the same rules (selector and condition texts are
// normalized on both sides), which is how a live CSSStyleRule is tied to its place in the file.

// At-rules whose blocks hold style rules (the others — @keyframes, @font-face, @page… — are skipped).
const GROUPING = /^@(media|supports|layer|container|document|scope)\b/i;

/** Selector text as the browser writes it, with spacing normalized for comparison. */
export function normSelector(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~,()=\[\]])\s*/g, "$1")
    .replace(/'/g, '"')
    .replace(/=([^\]"]+)\]/g, '="$1"]') // [type=range] -> [type="range"]
    .replace(/::?(before|after|first-line|first-letter)\b/g, "::$1")
    .trim()
    .toLowerCase();
}
/** At-rule condition, normalized: "@media (max-width: 900px)" -> "@media(max-width:900px)". */
export function normCondition(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "").replace(/'/g, '"').toLowerCase();
}

/**
 * Style rules of a CSS file, in source order:
 * [{ selector, path: [conditions], open, close, decls: [{ prop, start, end, important }] }]
 * `open`/`close` are the positions of `{` and `}`; decl start/end are the value's range
 * (without `!important`).
 */
export function scanCss(code) {
  const rules = [];
  const n = code.length;
  let i = 0;
  const skipSpaceAndComments = () => {
    for (;;) {
      while (i < n && /\s/.test(code[i])) i++;
      if (code.startsWith("/*", i)) { const e = code.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      return;
    }
  };
  /** Position of the `}` that closes the block opened at `from` (skips strings, comments, nested blocks). */
  const blockEnd = (from) => {
    let depth = 0;
    for (let k = from; k < n; k++) {
      const c = code[k];
      if (c === '"' || c === "'") { const q = c; k++; while (k < n && code[k] !== q) { if (code[k] === "\\") k++; k++; } continue; }
      if (c === "/" && code[k + 1] === "*") { const e = code.indexOf("*/", k + 2); k = e < 0 ? n : e + 1; continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return k;
    }
    return n;
  };
  /** Prelude up to `{` or `;` at depth 0 (strings and parentheses respected). */
  const prelude = () => {
    const start = i;
    let paren = 0;
    while (i < n) {
      const c = code[i];
      if (c === '"' || c === "'") { const q = c; i++; while (i < n && code[i] !== q) { if (code[i] === "\\") i++; i++; } i++; continue; }
      if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (paren <= 0 && (c === "{" || c === ";" || c === "}")) break;
      i++;
    }
    return { start, end: i };
  };
  const parseDecls = (from, to) => {
    const decls = [];
    let k = from;
    while (k < to) {
      // one declaration: up to `;` at depth 0, or a nested block (CSS nesting: skipped)
      let s = k, paren = 0, colon = -1, end = to, nested = false;
      for (; k < to; k++) {
        const c = code[k];
        if (c === '"' || c === "'") { const q = c; k++; while (k < to && code[k] !== q) { if (code[k] === "\\") k++; k++; } continue; }
        if (c === "/" && code[k + 1] === "*") { const e = code.indexOf("*/", k + 2); k = e < 0 ? to : e + 1; continue; }
        if (c === "(") paren++;
        else if (c === ")") paren--;
        else if (c === ":" && colon < 0 && paren === 0) colon = k;
        else if (c === "{" && paren === 0) { nested = true; k = blockEnd(k) + 1; end = k; break; }
        else if (c === ";" && paren === 0) { end = k; k++; break; }
      }
      if (k >= to && end === to) k = to;
      if (nested || colon < 0) continue;
      const prop = code.slice(s, colon).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!/^(--)?[a-zA-Z-][\w-]*$/.test(prop)) continue;
      let vs = colon + 1, ve = end;
      while (vs < ve && /\s/.test(code[vs])) vs++;
      while (ve > vs && /\s/.test(code[ve - 1])) ve--;
      const full = ve; // end including `!important`: where a `;` goes
      const imp = /\s*!\s*important$/i.exec(code.slice(vs, ve));
      if (imp) ve -= imp[0].length;
      decls.push({ prop: prop.startsWith("--") ? prop : prop.toLowerCase(), start: vs, end: ve, full, important: !!imp });
    }
    return decls;
  };
  const walk = (to, path) => {
    while (i < to) {
      skipSpaceAndComments();
      if (i >= to) break;
      if (code[i] === "}") { i++; continue; }
      const at = code[i] === "@";
      const p = prelude();
      const head = code.slice(p.start, p.end).trim();
      if (i >= n || code[i] === ";") { i++; continue; } // @import …;  or a stray declaration
      if (code[i] === "}") { i++; continue; }
      const open = i, close = blockEnd(open);
      if (at) {
        if (GROUPING.test(head)) { i = open + 1; walk(close, [...path, head]); }
        i = close + 1;
        continue;
      }
      rules.push({ selector: head, path, open, close, decls: parseDecls(open + 1, close) });
      i = close + 1;
    }
  };
  walk(n, []);
  return rules;
}

/** The key of each rule: condition path, normalized selector and its occurrence among equal ones. */
export function ruleKeys(rules) {
  const seen = new Map();
  return rules.map((r) => {
    const base = `${r.path.map(normCondition).join(" ")}|${normSelector(r.selector)}`;
    const k = seen.get(base) || 0;
    seen.set(base, k + 1);
    return `${base}|${k}`;
  });
}

/**
 * Code sites and declarations for a CSS file, in the editor's registry format.
 * `idFor(key, prefix)` returns stable ids across rescans.
 */
export function cssRegistry(code, idFor) {
  const rules = scanCss(code);
  const keys = ruleKeys(rules);
  const decls = [];
  const sites = [];
  rules.forEach((r, k) => {
    const declId = idFor(keys[k], "d");
    // where a new declaration goes: after the last one (or right after `{`), on its own line
    const last = r.decls[r.decls.length - 1];
    const inner = code.slice(r.open + 1, r.close);
    const multiline = inner.includes("\n");
    const firstLine = /\n([ \t]*)\S/.exec(inner);
    const closeIndent = /([ \t]*)$/.exec(code.slice(code.lastIndexOf("\n", r.close - 1) + 1, r.close))[1];
    decls.push({
      id: declId, name: r.selector.replace(/\s+/g, " ").trim(), css: true, key: keys[k], start: r.open, end: r.close + 1,
      insertAt: r.close, access: null,
      lastEnd: last ? last.full : null,
      hasSemi: last ? /^\s*;/.test(code.slice(last.full, r.close)) : true,
      multiline, indent: firstLine ? firstLine[1] : closeIndent + "  ", closeIndent,
      props: r.decls.map((d) => d.prop),
    });
    const own = new Map(); // the last declaration of a property wins, as in the browser
    for (const d of r.decls) own.set(d.prop, d);
    for (const [prop, d] of own) {
      sites.push({ id: idFor(`${keys[k]}|${prop}`, "s"), kind: `css:${prop}`, form: "css-decl", css: true, declId, args: [{ start: d.start, end: d.end, text: code.slice(d.start, d.end) }] });
    }
  });
  return { decls, sites };
}

/**
 * Text edits for a CSS file: values replaced in place, new declarations added at the end of
 * their rule (following its layout).
 * @param {object[]} siteEdits  [{ site, value }]
 * @param {object[]} inserts    [{ decl, kind, value }]
 */
export function planCssEdits(code, siteEdits, inserts) {
  const edits = [];
  const errors = [];
  const bad = (v) => /[;{}]/.test(String(v));
  for (const { site, value } of siteEdits) {
    const a = site.args[0];
    if (code.slice(a.start, a.end) !== a.text) {
      errors.push("The CSS file changed since the game was loaded. Reload the game.");
      return { edits: [], errors };
    }
    if (bad(value)) { errors.push(`"${value}" can't be written in CSS (it contains ; { or }).`); continue; }
    edits.push({ start: a.start, end: a.end, text: String(value), site });
  }
  const byDecl = new Map();
  for (const ins of inserts) {
    if (!byDecl.has(ins.decl.id)) byDecl.set(ins.decl.id, []);
    byDecl.get(ins.decl.id).push(ins);
  }
  for (const list of byDecl.values()) {
    const d = list[0].decl;
    const props = list.filter((x) => x.kind.startsWith("css:") && !bad(x.value));
    for (const x of list) if (!x.kind.startsWith("css:")) errors.push(`Can't add ${x.kind} to a CSS rule.`);
    for (const x of list) if (bad(x.value)) errors.push(`"${x.value}" can't be written in CSS (it contains ; { or }).`);
    if (!props.length) continue;
    const text = props.map((x) => `${x.kind.slice(4)}: ${x.value};`);
    // after the last declaration (adding its missing `;`), or inside an empty rule
    let at = d.insertAt, out;
    if (d.multiline) {
      while (at > d.start && /[ \t]/.test(code[at - 1])) at--; // before the closing line's indent
      const before = code.slice(0, at);
      const needSemi = !d.hasSemi && d.lastEnd != null;
      if (needSemi) edits.push({ start: d.lastEnd, end: d.lastEnd, text: ";" });
      out = (before.endsWith("\n") ? "" : "\n") + text.map((t) => `${d.indent}${t}\n`).join("");
    } else {
      // one line: `.a { color: red; top: 0; }` (keeps the space before `}`)
      const needSemi = !d.hasSemi && d.lastEnd != null;
      while (at > d.start && /\s/.test(code[at - 1])) at--;
      const tailSpace = /\s*$/.exec(code.slice(d.start + 1, d.insertAt))[0];
      edits.push({ start: at, end: d.insertAt, text: (needSemi ? ";" : "") + " " + text.join(" ") + (tailSpace || " ") });
      continue;
    }
    edits.push({ start: at, end: at, text: out });
  }
  return { edits, errors };
}
