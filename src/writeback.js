// Rewrites source code from the changes made in the editor.
//
// Main rule: keep the original expression and only adjust the number.
//   22                       + 18  -> 40
//   app.renderer.width - 10  - 14  -> app.renderer.width - 24
//   44 + i * 22              + 10  -> 54 + i * 22
//   someVar                  + 5   -> someVar + 5
import { parse, parseExpression } from "@babel/parser";

export function fmt(v, decimals = 2) {
  const n = Number(v.toFixed(decimals));
  return Object.is(n, -0) ? "0" : String(n);
}

const SAFE_LEFT = new Set([
  "Identifier", "MemberExpression", "CallExpression", "NumericLiteral", "ThisExpression",
  "ParenthesizedExpression", "NewExpression", "OptionalMemberExpression", "OptionalCallExpression",
]);

/** Adjusts the text of a numeric expression by adding `d`. */
export function applyDelta(text, d, decimals = 2) {
  if (Math.abs(d) < 1e-9) return text;
  let node;
  try {
    node = parseExpression(text, { plugins: ["typescript"] });
  } catch {
    node = null;
  }
  const lit = (n) => n && n.type === "NumericLiteral";
  const neg = (n) => n && n.type === "UnaryExpression" && n.operator === "-" && lit(n.argument);

  if (node) {
    if (lit(node)) return fmt(node.value + d, decimals);
    if (neg(node)) return fmt(-node.argument.value + d, decimals);
    if (node.type === "BinaryExpression" && (node.operator === "+" || node.operator === "-") && lit(node.right)) {
      const leftText = text.slice(0, node.left.end).trimEnd();
      const signed = (node.operator === "+" ? node.right.value : -node.right.value) + d;
      if (Math.abs(signed) < 1e-9) return leftText;
      return `${leftText} ${signed >= 0 ? "+" : "-"} ${fmt(Math.abs(signed), decimals)}`;
    }
    if (node.type === "BinaryExpression" && node.operator === "+" && lit(node.left)) {
      const rest = text.slice(node.left.end);
      return `${fmt(node.left.value + d, decimals)}${rest}`;
    }
  }
  const safe = node && (SAFE_LEFT.has(node.type) || (node.type === "BinaryExpression" && ["+", "-", "*", "/", "%", "**"].includes(node.operator)));
  const base = safe ? text : `(${text})`;
  return `${base} ${d >= 0 ? "+" : "-"} ${fmt(Math.abs(d), decimals)}`;
}

const DECIMALS = {
  position: 2, x: 2, y: 2, pivot: 2, "pivot.x": 2, "pivot.y": 2,
  scale: 3, "scale.x": 3, "scale.y": 3, anchor: 3, "anchor.x": 3, "anchor.y": 3,
  rotation: 4, angle: 2, alpha: 3,
};
const VEC_KINDS = new Set(["position", "scale", "pivot", "anchor", "skew"]);
const STRING_KINDS = new Set(["text", "label"]);
const COLOR_KINDS = new Set(["tint", "style.fill"]);
// Values that need the whole project to be written (asset constants, variables in scope).
const RESOLVED_TYPES = new Set(["texture", "spine", "parent"]);

/** Most common quote character in a file's imports (keeps inserted strings in the project's style). */
export function detectQuote(code) {
  const single = (code.match(/from '/g) || []).length;
  const double = (code.match(/from "/g) || []).length;
  return single > double ? "'" : '"';
}

export function quoteString(value, quote) {
  const v = String(value);
  if (quote === "`") return "`" + v.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
  const body = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(quote === "'" ? /'/g : /"/g, "\\" + quote);
  return quote + body + quote;
}
const hex6 = (n) => (Number(n) >>> 0 & 0xffffff).toString(16).padStart(6, "0");

/**
 * Formats a new value in the style of the literal it replaces. Returns null when the original is
 * an expression (a variable, a template with ${…}, a call…): that value comes from code and is not
 * overwritten.
 */
export function literalValue(orig, value, type, quote = '"') {
  let node;
  try { node = parseExpression(orig, { plugins: ["typescript"] }); } catch { return null; }
  if (type === "string") {
    if (node.type === "StringLiteral") return quoteString(value, orig[0]);
    if (node.type === "TemplateLiteral" && !node.expressions.length) return quoteString(value, "`");
    if (node.type === "NumericLiteral") return quoteString(value, quote);
    return null;
  }
  if (type === "color") {
    if (node.type === "NumericLiteral") return `0x${hex6(value)}`;
    if (node.type === "StringLiteral") {
      const alpha = /^#[0-9a-f]{8}$/i.test(node.value) ? node.value.slice(7) : "";
      return `${orig[0]}#${hex6(value)}${alpha}${orig[0]}`;
    }
    return null;
  }
  return null;
}

/** Source text for a value being inserted as a new property or statement. */
export function valueText(kind, values, quote) {
  if (STRING_KINDS.has(kind)) return quoteString(values[0], quote);
  if (COLOR_KINDS.has(kind)) return `0x${hex6(values[0])}`;
  const dec = DECIMALS[kind] ?? 3;
  return fmt(values[0], dec);
}

/**
 * Computes the text edits for one file.
 * @param {string} code      current file contents
 * @param {object[]} siteEdits  [{ site, deltas: number[] }]
 * @param {object[]} inserts    [{ decl, kind, values: number[] }]
 * @returns {{ edits: object[], errors: string[] }}
 */
export function planEdits(code, siteEdits, inserts, ctx = {}) {
  const edits = [];
  const errors = [];
  const quote = ctx.quote || detectQuote(code);

  for (const { site, deltas, params, remove, value, valueType } of siteEdits) {
    const dec = DECIMALS[site.kind] ?? 3;
    for (const a of site.args) {
      if (code.slice(a.start, a.end) !== a.text) {
        errors.push(`The file changed since the game was loaded (${site.kind}). Reload the game.`);
        return { edits: [], errors };
      }
    }
    if (remove) {
      // Delete the whole `addComponent(...)` statement line.
      if (!site.stmt || code.slice(site.stmt.start, site.stmt.end) !== site.stmt.text) {
        errors.push(`Cannot remove ${site.kind.replace("component:", "")}: its line was not found.`);
        continue;
      }
      let start = site.stmt.start;
      let end = site.stmt.end;
      const lineStart = code.lastIndexOf("\n", start - 1) + 1;
      if (/^[ \t]*$/.test(code.slice(lineStart, start))) start = lineStart;
      const rest = /^[ \t]*\r?\n/.exec(code.slice(end));
      if (rest) end += rest[0].length;
      edits.push({ start, end, text: "", site, remove: true });
      continue;
    }
    if (valueType && ctx.resolve && RESOLVED_TYPES.has(valueType)) {
      // Assets and parents: the plugin knows the project (constants, variables in scope).
      const r = ctx.resolve(site, value, valueType, code);
      if (r.error) {
        errors.push(r.error);
        if (r.failed !== false) (ctx.failed || []).push(site.id);
        continue;
      }
      for (const ed of r.edits) edits.push(ed.site === null ? { ...ed, site: undefined } : { ...ed, site });
      continue;
    }
    if (valueType) {
      const a = site.args[0];
      const text = literalValue(a.text, value, valueType, quote);
      if (text == null) {
        errors.push(`${site.kind} is computed by code (${a.text.length > 40 ? a.text.slice(0, 39) + "…" : a.text}), so it can't be overwritten.`);
        (ctx.failed || []).push(site.id);
        continue;
      }
      edits.push({ start: a.start, end: a.end, text, site, argIndex: 0 });
      continue;
    }
    if (params) {
      const a = site.args[0];
      const lit = serializeParams(params);
      edits.push({ start: a.start, end: a.end, text: (a.text === "" ? a.prefix || ", " : "") + lit, site, argIndex: 0, literal: lit });
      continue;
    }
    if (site.args.length === 2) {
      site.args.forEach((a, i) => {
        const d = deltas[i] ?? 0;
        if (Math.abs(d) < 1e-9) return;
        edits.push({ start: a.start, end: a.end, text: applyDelta(a.text, d, dec), site, argIndex: i });
      });
    } else {
      const a = site.args[0];
      const d0 = deltas[0] ?? 0;
      const d1 = deltas.length > 1 ? deltas[1] : d0;
      if (Math.abs(d0 - d1) < 1e-9) {
        if (Math.abs(d0) > 1e-9) edits.push({ start: a.start, end: a.end, text: applyDelta(a.text, d0, dec), site, argIndex: 0 });
      } else if (site.form === "call" || site.form === "option") {
        // position.set(5) with x ≠ y  ->  position.set(5 + dx, 5 + dy);  anchor: 0.5  ->  anchor: [0.6, 0.5]
        const A = applyDelta(a.text, d0, dec);
        const B = applyDelta(a.text, d1, dec);
        let text = `${A}, ${B}`;
        let offsets = [0, A.length + 2];
        if (site.form === "option" && site.vecStyle === "object") {
          text = `{ x: ${A}, y: ${B} }`;
          offsets = [5, 5 + A.length + 5];
        } else if (site.form === "option") {
          text = `[${A}, ${B}]`;
          offsets = [1, 1 + A.length + 2];
        }
        edits.push({ start: a.start, end: a.end, text, site, expand: [A, B], offsets });
      } else {
        errors.push(`Cannot save different X and Y values on "${a.text}" (single-value assignment).`);
      }
    }
  }

  // Inserts into an object literal (factory options or an Object.assign wrapper).
  const literalInserts = new Map();
  for (const ins of inserts.filter((i) => i.mode === "literal" || i.mode === "wrap")) {
    const key = `${ins.decl.id}:${ins.mode}`;
    if (!literalInserts.has(key)) literalInserts.set(key, []);
    literalInserts.get(key).push(ins);
  }
  for (const list of literalInserts.values()) {
    const { decl, mode, literal } = list[0];
    const props = list.map((ins) => propEntry(ins, quote));
    if (mode === "wrap") {
      // createSprite({...})  ->  Object.assign(createSprite({...}), { label: "Logo" })
      const head = ", { ";
      let text = head;
      const newSites = [];
      props.forEach((p, i) => {
        if (i) text += ", ";
        newSites.push(...p.sites.map((ns) => ({ ...ns, args: ns.args.map((a) => ({ ...a, relStart: a.relStart + text.length })), declId: decl.id })));
        text += p.text;
      });
      text += " })";
      edits.push({ start: decl.end, end: decl.end, text, insert: newSites, declRange: "close", rangeDecl: decl });
      edits.push({ start: decl.start, end: decl.start, text: "Object.assign(", declRange: "open", rangeDecl: decl });
      continue;
    }
    const e = literalInsertEdit(code, literal, props);
    e.insert = e.insert.map((ns) => ({ ...ns, declId: decl.id }));
    edits.push(e);
  }

  // Inserts grouped by declaration (one new line per object and property).
  const byDecl = new Map();
  for (const ins of inserts.filter((i) => !i.mode || i.mode === "stmt")) {
    if (ins.decl.insertAt == null) {
      errors.push(`No safe place in the code to save ${ins.kind} of "${ins.decl.name}".`);
      continue;
    }
    if (!byDecl.has(ins.decl.id)) byDecl.set(ins.decl.id, []);
    byDecl.get(ins.decl.id).push(ins);
  }
  for (const list of byDecl.values()) {
    const decl = list[0].decl;
    let text = "";
    const newSites = [];
    for (const ins of list) {
      const prefix0 = `\n${decl.indent}`;
      if (ins.kind === "useApp") {
        text += `${prefix0}useApp(${decl.access});`;
        continue;
      }
      if (STRING_KINDS.has(ins.kind) || COLOR_KINDS.has(ins.kind)) {
        const head = `${decl.access}.${ins.kind} = `;
        const v = valueText(ins.kind, [ins.value], quote);
        const rel = text.length + prefix0.length + head.length;
        newSites.push({ kind: ins.kind, form: "assign", declId: decl.id, args: [{ relStart: rel, text: v }] });
        text += `${prefix0}${head}${v};`;
        continue;
      }
      if (ins.kind.startsWith("component:")) {
        const type = ins.kind.slice("component:".length);
        const head = `addComponent(${decl.access}, ${type}, `;
        const lit = serializeParams(ins.params || {});
        const line = `${head}${lit});`;
        const relStmt = text.length + prefix0.length;
        newSites.push({
          kind: ins.kind, form: "component", declId: decl.id,
          args: [{ relStart: relStmt + head.length, text: lit }],
          stmt: { relStart: relStmt, text: line },
        });
        text += prefix0 + line;
        continue;
      }
      const dec = DECIMALS[ins.kind] ?? 3;
      const vals = ins.values.map((v) => fmt(v, dec));
      let line, argTexts;
      if (VEC_KINDS.has(ins.kind)) {
        argTexts = vals[0] === vals[1] && ins.kind !== "position" ? [vals[0]] : vals;
        line = `${decl.access}.${ins.kind}.set(`;
      } else {
        argTexts = [vals[0]];
        line = `${decl.access}.${ins.kind} = `;
      }
      const prefix = `\n${decl.indent}`;
      let offset = text.length + prefix.length + line.length;
      const args = [];
      argTexts.forEach((t, i) => {
        if (i > 0) offset += 2;
        args.push({ relStart: offset, text: t });
        offset += t.length;
      });
      line += argTexts.join(", ") + (VEC_KINDS.has(ins.kind) ? ");" : ";");
      text += prefix + line;
      newSites.push({ kind: ins.kind, form: VEC_KINDS.has(ins.kind) ? "call" : "assign", args, declId: decl.id });
    }
    edits.push({ start: decl.insertAt, end: decl.insertAt, text, insert: newSites, decl });
  }

  return { edits, errors };
}

/** Serializes component params as a readable object literal: { h: "right", x: -10 } */
export function serializeParams(params) {
  const parts = Object.entries(params).map(([k, v]) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
    const val = typeof v === "number" ? fmt(v, 3) : JSON.stringify(v);
    return `${key}: ${val}`;
  });
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

export const COMPONENT_EXPORTS = ["addComponent", "useApp", "Anchor", "Button", "Tween"];

/**
 * Computes the edit that makes `code` import exactly the component names it uses
 * from `spec` (adds, updates or removes the import). Returns null when nothing changes.
 */
export function planImport(code, spec, candidates, { addOnly = false } = {}) {
  let ast;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["typescript", "decorators-legacy", "jsx"] });
  } catch {
    return null;
  }
  const imports = ast.program.body.filter((n) => n.type === "ImportDeclaration");
  const strip = (v) => v.replace(/\.(ts|js)$/, "");
  const decl = imports.find((n) => strip(n.source.value) === strip(spec) && n.importKind !== "type");
  const existing = decl ? decl.specifiers.filter((sp) => sp.type === "ImportSpecifier").map((sp) => sp.imported.name || sp.imported.value) : [];
  const body = decl ? code.slice(0, decl.start) + code.slice(decl.end) : code;
  const names = [...new Set([...candidates, ...existing])].filter((n) => (addOnly && existing.includes(n)) || new RegExp(`\\b${n}\\b`).test(body));
  if (addOnly && candidates.every((n) => existing.includes(n) || !names.includes(n))) return null;
  const order = (n) => { const i = COMPONENT_EXPORTS.indexOf(n); return i < 0 ? 99 : i; };
  if (addOnly) names.splice(0, names.length, ...existing, ...candidates.filter((c) => !existing.includes(c)));
  else names.sort((x, y) => order(x) - order(y) || x.localeCompare(y));
  const quote = decl ? code[decl.source.start] : '"';
  const line = `import { ${names.join(", ")} } from ${quote}${decl ? decl.source.value : spec}${quote};`;

  if (decl) {
    if (!names.length) {
      let end = decl.end;
      const rest = /^[ \t]*\r?\n/.exec(code.slice(end));
      if (rest) end += rest[0].length;
      return { start: decl.start, end, text: "" };
    }
    if (code.slice(decl.start, decl.end) === line) return null;
    return { start: decl.start, end: decl.end, text: line };
  }
  if (!names.length) return null;
  if (imports.length) {
    const last = imports[imports.length - 1];
    return { start: last.end, end: last.end, text: `\n${line}` };
  }
  return { start: 0, end: 0, text: `${line}\n` };
}

/** `key: value` text for a property insert, with the ranges of its value(s) for new code sites. */
function propEntry(ins, quote) {
  const key = ins.kind;
  const head = `${key}: `;
  if (VEC_KINDS.has(key)) {
    const dec = DECIMALS[key] ?? 3;
    const vals = ins.values.map((v) => fmt(v, dec));
    if (vals.length === 1 || (vals[0] === vals[1] && key !== "position")) {
      return { text: head + vals[0], sites: [{ kind: key, form: "option", vecStyle: ins.vecStyle || "object", args: [{ relStart: head.length, text: vals[0] }] }] };
    }
    if (ins.vecStyle === "array") {
      const a = head.length + 1;
      const b = a + vals[0].length + 2;
      return { text: `${head}[${vals[0]}, ${vals[1]}]`, sites: [{ kind: key, form: "option", vecStyle: "array", args: [{ relStart: a, text: vals[0] }, { relStart: b, text: vals[1] }] }] };
    }
    // { x: 1, y: 2 }
    const a = head.length + 5;
    const b = a + vals[0].length + 5;
    return { text: `${head}{ x: ${vals[0]}, y: ${vals[1]} }`, sites: [{ kind: key, form: "option", vecStyle: "object", args: [{ relStart: a, text: vals[0] }, { relStart: b, text: vals[1] }] }] };
  }
  const v = valueText(key, ins.value !== undefined ? [ins.value] : ins.values, quote);
  return { text: head + v, sites: [{ kind: key, form: "option", args: [{ relStart: head.length, text: v }] }] };
}

/** Finds the object literal that holds an object's options: Object.assign(x, {…}) or factory/constructor options. */
export function findLiteral(code, decl) {
  if (decl.start == null || decl.end == null) return null;
  let node;
  try { node = parseExpression(code.slice(decl.start, decl.end), { plugins: ["typescript"] }); } catch { return null; }
  const abs = (n) => ({ ...n, start: n.start + decl.start, end: n.end + decl.start });
  while (node && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(node.type)) node = node.expression;
  if (
    node.type === "CallExpression" && node.callee.type === "MemberExpression" &&
    node.callee.object.type === "Identifier" && node.callee.object.name === "Object" &&
    node.callee.property.name === "assign" && node.arguments[1] && node.arguments[1].type === "ObjectExpression"
  ) {
    return { kind: "assign", lit: abs(node.arguments[1]), props: node.arguments[1].properties.map(abs) };
  }
  // Root of a chain: new X({...}) / createX({...})
  let n = node;
  while (n && n.type === "CallExpression" && n.callee.type === "MemberExpression" && !/^(create|make|build)[A-Z]/.test(n.callee.property?.name || "")) n = n.callee.object;
  const a0 = n && n.arguments && n.arguments[0];
  if (a0 && a0.type === "ObjectExpression") return { kind: "options", lit: abs(a0), props: a0.properties.map(abs), isNew: n.type === "NewExpression" };
  return { kind: "none", isNew: n && n.type === "NewExpression" };
}

/** Inserts `key: value` properties into an existing object literal, following its formatting. */
export function literalInsertEdit(code, literal, props) {
  const { lit } = literal;
  const items = literal.props;
  const newSites = [];
  const push = (p, offset) => newSites.push(...p.sites.map((ns) => ({ ...ns, args: ns.args.map((a) => ({ ...a, relStart: a.relStart + offset })) })));
  if (!items.length) {
    let text = " ";
    props.forEach((p, i) => { if (i) text += ", "; push(p, text.length); text += p.text; });
    text += " ";
    return { start: lit.start + 1, end: lit.end - 1, text, insert: newSites };
  }
  const last = items[items.length - 1];
  const between = code.slice(last.end, lit.end);
  const trailingComma = /^\s*,/.test(between);
  const multiline = code.slice(lit.start, lit.end).includes("\n");
  if (multiline) {
    const lineStart = code.lastIndexOf("\n", last.start - 1) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))[0];
    const at = trailingComma ? last.end + between.indexOf(",") + 1 : last.end;
    let text = trailingComma ? "" : ",";
    props.forEach((p, i) => {
      text += `\n${indent}`;
      push(p, text.length);
      text += p.text + (trailingComma || i < props.length - 1 ? "," : "");
    });
    return { start: at, end: at, text, insert: newSites };
  }
  let text = "";
  props.forEach((p) => { text += ", "; push(p, text.length); text += p.text; });
  return { start: last.end, end: last.end, text, insert: newSites };
}
