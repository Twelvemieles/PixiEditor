// Code changes that touch whole objects: deleting an object's code and duplicating it.
//
// An object's code is its declaration plus the statements that use it as their subject:
//   const coin = Sprite.from("coin");      <- declaration
//   coin.anchor.set(0.5);                  <- subject statements
//   coin.on("pointertap", () => …);
//   hud.addChild(coin);
//   addComponent(coin, Button, {});
//   createContainer({ children: [coin] })  <- list entry
// Anything else that uses the object (`return { coin }`, `if (coin.visible)`, `foo(coin)`) blocks the
// operation: the editor can't know what that code expects.
import { parse } from "@babel/parser";

const SKIP = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "range"]);
const BLOCK_TYPES = new Set(["Program", "BlockStatement", "StaticBlock"]);
const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression", "AwaitExpression"]);
const unwrap = (n) => { while (n && TS_WRAPPERS.has(n.type)) n = n.expression || n.argument; return n; };
const ADD_REMOVE = /^(addChild|addChildAt|removeChild|removeChildren|swapChildren|setChildIndex|addChildren)$/;
const COMPONENT_CALLS = /^(addComponent|removeComponent|getComponent)$/;

function parseCode(code) {
  return parse(code, { sourceType: "module", plugins: ["typescript", "decorators-legacy", "jsx"], errorRecovery: true });
}

/** Calls `visit(node, parents)` for every node. */
function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parents);
  parents.push(node);
  for (const k of Object.keys(node)) {
    if (SKIP.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") walk(c, visit, parents); }
    else if (v && typeof v.type === "string") walk(v, visit, parents);
  }
  parents.pop();
}

const lineOfPos = (code, pos) => code.slice(0, pos).split("\n").length;
const rootObject = (n) => { n = unwrap(n); while (n && (n.type === "MemberExpression" || n.type === "OptionalMemberExpression" || n.type === "CallExpression" || n.type === "OptionalCallExpression")) n = unwrap(n.type.endsWith("CallExpression") ? n.callee : n.object); return n; };
const propName = (m) => (m && !m.computed && m.property && m.property.type === "Identifier" ? m.property.name : null);

/** Range of a whole statement including its indentation and line break, for deleting it. */
export function statementRange(code, start, end) {
  const lineStart = code.lastIndexOf("\n", start - 1) + 1;
  if (/^[ \t]*$/.test(code.slice(lineStart, start))) start = lineStart;
  const rest = /^[ \t]*(\/\/[^\n]*)?\r?\n/.exec(code.slice(end));
  if (rest && !rest[1]) end += rest[0].length;
  else if (/^[ \t]*;/.test(code.slice(end))) end += /^[ \t]*;/.exec(code.slice(end))[0].length;
  return { start, end };
}

/** Range that removes one element of a list (array element or call argument) with its comma. */
function elementRange(code, list, i) {
  const el = list[i];
  if (list.length === 1) return { start: el.start, end: el.end };
  if (i < list.length - 1) return { start: el.start, end: list[i + 1].start };
  return { start: list[i - 1].end, end: el.end };
}

/**
 * Finds everything in `code` that belongs to the object created at [decl.start, decl.end) and
 * stored in `decl.access` (or no variable).
 * @returns {{ ok: boolean, blockers: {line, text}[], declStmt, block, parts: {kind, start, end, node?}[], refs: number[] }}
 */
export function analyzeObject(code, decl) {
  const ast = parseCode(code);
  const out = { blockers: [], parts: [], refs: [], declStmt: null, block: null, ast };
  const block = (why, node) => out.blockers.push({ line: lineOfPos(code, node.start), text: why || code.slice(node.start, node.end).split("\n")[0].trim().slice(0, 80) });

  // 1. The creation itself.
  let creation = null, parentsOf = null;
  walk(ast.program, (n, parents) => {
    if (!creation && n.start === decl.start && n.end === decl.end && typeof n.type === "string" && /Expression|Literal/.test(n.type)) {
      creation = n; parentsOf = [...parents];
    }
  });
  if (!creation) { out.blockers.push({ line: 0, text: "the object's code was not found (reload the game)" }); return finish(out); }

  // Climb out of TS casts / parentheses.
  let i = parentsOf.length - 1;
  while (i >= 0 && TS_WRAPPERS.has(parentsOf[i].type)) i--;
  const p = parentsOf[i], gp = parentsOf[i - 1], ggp = parentsOf[i - 2];
  const access = decl.access;

  if (!access) {
    // createSprite({ … });  /  hud.addChild(new Sprite(…));  /  children: [createSprite(…)]
    usePart(code, creation, parentsOf.slice(0, i + 1), out, block, true);
    return finish(out);
  }
  if (access.startsWith("this.")) {
    out.blockers.push({ line: lineOfPos(code, creation.start), text: `${access} is a class field — edit it in the code` });
    return finish(out);
  }
  if (!(p && p.type === "VariableDeclarator" && p.init === creation || (p && p.type === "VariableDeclarator" && unwrap(p.init) === creation)) || !gp || gp.type !== "VariableDeclaration" || gp.declarations.length !== 1 || !ggp || !BLOCK_TYPES.has(ggp.type)) {
    block(`${access} is not declared on its own line (const ${access} = …)`, creation);
    return finish(out);
  }
  out.declStmt = gp;
  out.block = ggp;
  out.parts.push({ kind: "stmt", start: gp.start, end: gp.end, node: gp });

  // 2. Every other use of the variable inside its block.
  const scope = ggp;
  walk(scope, (n, parents) => {
    if (n.type !== "Identifier" || n.name !== access || n === p.id) return;
    if (n.start < gp.start) return;
    const par = parents[parents.length - 1];
    // Not a reference: `obj.coin`, `{ coin: 1 }` keys, other declarations of the same name.
    if (par && (par.type === "MemberExpression" || par.type === "OptionalMemberExpression") && par.property === n && !par.computed) return;
    if (par && (par.type === "ObjectProperty" || par.type === "ObjectMethod" || par.type === "ClassProperty" || par.type === "ClassMethod") && par.key === n && !par.computed && !(par.type === "ObjectProperty" && par.shorthand)) return;
    if (n.start >= gp.start && n.end <= gp.end) return; // inside its own declaration
    if (par && par.type === "VariableDeclarator" && par.id === n) { block(`another variable named ${access}`, n); return; }
    out.refs.push(n.start);
    usePart(code, n, parents, out, block, false);
  });
  return finish(out);
}

/** Classifies one use of the object (node = the reference or the creation expression). */
function usePart(code, node, parents, out, block, isCreation) {
  let i = parents.length - 1;
  let child = node;
  while (i >= 0 && TS_WRAPPERS.has(parents[i].type)) { child = parents[i]; i--; }
  const par = parents[i];
  // children: [a, coin]
  if (par && par.type === "ArrayExpression") {
    const prop = parents[i - 1];
    if (prop && prop.type === "ObjectProperty" && !prop.computed && (prop.key.name === "children" || prop.key.value === "children")) {
      const k = par.elements.indexOf(child);
      out.parts.push({ kind: "element", ...elementRange(code, par.elements, k), item: par.elements[k] });
      return;
    }
  }
  // hud.addChild(a, coin): drop just that argument
  if (par && par.type === "CallExpression" && par.arguments.includes(child) && ADD_REMOVE.test(propName(par.callee) || "") && par.arguments.length > 1) {
    const stmtIdx = parents.findLastIndex((x, k) => x.type === "ExpressionStatement" && BLOCK_TYPES.has((parents[k - 1] || {}).type));
    const stmt = parents[stmtIdx];
    if (stmt && unwrap(stmt.expression) === par) {
      const k = par.arguments.indexOf(child);
      out.parts.push({ kind: "argument", ...elementRange(code, par.arguments, k), item: par.arguments[k] });
      return;
    }
  }
  // The statement directly inside a block that contains this use.
  let k = parents.length - 1;
  while (k >= 0 && !(BLOCK_TYPES.has(parents[k].type) && parents[k + 1])) k--;
  const stmt = parents[k + 1] || (BLOCK_TYPES.has(parents[parents.length - 1]?.type) ? node : null);
  if (!stmt || stmt.type !== "ExpressionStatement") { block(null, stmt || node); return; }
  const e = unwrap(stmt.expression);
  const isSubject =
    // coin.x = 1;  coin.scale.x = 2;  coin.texture = …
    (e.type === "AssignmentExpression" && e.left.type === "MemberExpression" && isRef(rootObject(e.left), node, isCreation)) ||
    // coin.anchor.set(0.5);  coin.on("tap", …);
    ((e.type === "CallExpression" || e.type === "OptionalCallExpression") && (e.callee.type === "MemberExpression" || e.callee.type === "OptionalMemberExpression") && isRef(rootObject(e.callee), node, isCreation)) ||
    // hud.addChild(coin);
    (e.type === "CallExpression" && ADD_REMOVE.test(propName(e.callee) || "") && e.arguments.length === 1 && isRef(unwrap(e.arguments[0]), node, isCreation)) ||
    // addComponent(coin, Button, {});
    (e.type === "CallExpression" && e.callee.type === "Identifier" && COMPONENT_CALLS.test(e.callee.name) && isRef(unwrap(e.arguments[0]), node, isCreation)) ||
    // createSprite({ … });  (the creation is the whole statement)
    (isCreation && rootIsCreation(e, node));
  if (!isSubject) { block(null, stmt); return; }
  if (!out.parts.some((x) => x.start === stmt.start && x.end === stmt.end)) out.parts.push({ kind: "stmt", start: stmt.start, end: stmt.end, node: stmt });
}
const isRef = (n, node, isCreation) => !!n && (isCreation ? n.start === node.start && n.end === node.end : n.type === "Identifier" && n.name === node.name);
function rootIsCreation(e, node) {
  // The statement is the creation, possibly with chained calls: createX({…}).fill(…)
  let n = e;
  while (n) {
    if (n.start === node.start && n.end === node.end) return true;
    if ((n.type === "CallExpression" || n.type === "OptionalCallExpression") && n.callee.type.endsWith("MemberExpression")) { n = unwrap(n.callee.object); continue; }
    n = unwrap(n);
    if (n && n.start === node.start && n.end === node.end) return true;
    return false;
  }
  return false;
}

function finish(out) {
  const seen = new Set();
  out.blockers = out.blockers.filter((b) => { const k = `${b.line}:${b.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  out.parts.sort((a, b) => a.start - b.start);
  // A part inside another (a statement that contains the list entry…) is covered by the outer one.
  out.parts = out.parts.filter((x, i) => !out.parts.some((y, j) => j !== i && y.start <= x.start && y.end >= x.end && (y.start !== x.start || y.end !== x.end)));
  out.ok = out.blockers.length === 0 && out.parts.length > 0;
  return out;
}

/** Edits that delete the object's code. */
export function deleteEdits(code, analysis) {
  return analysis.parts.map((part) => {
    if (part.kind === "stmt") return { ...statementRange(code, part.start, part.end), text: "" };
    return { start: part.start, end: part.end, text: "" };
  });
}

/**
 * Edits that duplicate the object's code with the variable renamed to `newName`: its declaration and
 * the statements next to it (same block) are copied right after the last of them; a list entry
 * (`children: [coin]`) gets the copy too (`children: [coin, coin2]`).
 */
export function duplicateEdits(code, analysis, access, newName) {
  const errors = [];
  if (!analysis.declStmt) {
    // No variable: copy the statement that creates it.
    const stmt = analysis.parts.find((x) => x.kind === "stmt");
    if (!stmt || analysis.parts.length !== 1) return { errors: ["This object can only be duplicated when it is created by its own statement."] };
    const r = statementRange(code, stmt.start, stmt.end);
    const indent = /^[ \t]*/.exec(code.slice(r.start))[0];
    return { edits: [{ start: stmt.end, end: stmt.end, text: `\n${indent}${code.slice(stmt.start, stmt.end).trim()}` }], errors };
  }
  const list = analysis.block.body;
  const declIndex = list.indexOf(analysis.declStmt);
  // Stop before the first use that the copy can't follow (a list entry or a statement elsewhere).
  const element = analysis.parts.find((x) => x.kind === "element" || x.kind === "argument");
  const limit = element ? element.start : Infinity;
  const stmts = analysis.parts.filter((x) => x.kind === "stmt" && list.includes(x.node) && list.indexOf(x.node) >= declIndex && x.start < limit);
  for (const st of stmts) {
    const e = st.node.type === "ExpressionStatement" ? unwrap(st.node.expression) : null;
    if (e && e.type === "CallExpression" && ADD_REMOVE.test(propName(e.callee) || "") && rootObject(e.callee)?.name === access) {
      errors.push(`${access} gets children added in the code (line ${lineOfPos(code, st.start)}); duplicate them separately.`);
    }
  }
  const declText = code.slice(analysis.declStmt.start, analysis.declStmt.end);
  if (/\bchildren\s*:\s*\[\s*[^\]\s]/.test(declText)) errors.push(`${access} is created with children; duplicate them separately.`);
  if (errors.length) return { errors };
  const rename = (st) => {
    let text = code.slice(st.start, st.end);
    const refs = [];
    walk(st.node, (n, parents) => {
      if (n.type !== "Identifier" || n.name !== access) return;
      const par = parents[parents.length - 1];
      if (par && (par.type === "MemberExpression" || par.type === "OptionalMemberExpression") && par.property === n && !par.computed) return;
      if (par && par.type === "ObjectProperty" && par.key === n && !par.shorthand) return;
      refs.push(n);
    });
    const seen = new Set();
    for (const n of refs.sort((a, b) => b.start - a.start)) {
      if (seen.has(n.start)) continue; // shorthand { coin }: key and value are the same text
      seen.add(n.start);
      text = text.slice(0, n.start - st.start) + newName + text.slice(n.end - st.start);
    }
    return text;
  };
  const last = stmts[stmts.length - 1];
  // Only the declaration (e.g. createSprite({ parent: hud, … })): copy the creation without a
  // variable, so strict TypeScript doesn't complain about an unused one.
  const listed = analysis.parts.some((x) => x.kind === "element" || x.kind === "argument");
  if (stmts.length === 1 && !listed) {
    const d = analysis.declStmt.declarations[0];
    const indent0 = /^[ \t]*/.exec(code.slice(code.lastIndexOf("\n", analysis.declStmt.start - 1) + 1))[0];
    let init = d.init;
    while (init && TS_WRAPPERS.has(init.type) && init.type !== "AwaitExpression") init = init.expression;
    return { edits: [{ start: last.end, end: last.end, text: `\n${indent0}${code.slice(init.start, init.end)};` }], errors, standalone: true };
  }
  const indent = /^[ \t]*/.exec(code.slice(code.lastIndexOf("\n", analysis.declStmt.start - 1) + 1))[0];
  const text = stmts.map((st) => `\n${indent}${rename(st)}`).join("");
  const edits = [{ start: last.end, end: last.end, text }];
  // Lists that hold the object hold the copy too: children: [coin, coin2] / hud.addChild(a, coin, coin2)
  for (const part of analysis.parts) {
    if (part.kind === "element" || part.kind === "argument") edits.push({ start: part.item.end, end: part.item.end, text: `, ${newName}` });
  }
  return { edits, errors };
}

/**
 * After deleting code, removes imports that nothing uses any more (only names that appeared in the
 * deleted code). Returns edits.
 */
export function pruneImports(code, candidates) {
  const ast = parseCode(code);
  const edits = [];
  const body = ast.program.body;
  const imports = body.filter((n) => n.type === "ImportDeclaration");
  const rest = code.slice(imports.length ? imports[imports.length - 1].end : 0);
  const used = (name) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}\\b`).test(rest);
  for (const imp of imports) {
    const specs = imp.specifiers;
    const drop = specs.filter((sp) => candidates.has(sp.local.name) && !used(sp.local.name));
    if (!drop.length) continue;
    if (drop.length === specs.length) {
      edits.push({ ...statementRange(code, imp.start, imp.end), text: "" });
      continue;
    }
    for (const sp of drop) {
      const named = specs.filter((x) => x.type === "ImportSpecifier");
      const k = named.indexOf(sp);
      if (k < 0) continue;
      const r = elementRange(code, named, k);
      // keep one of two overlapping comma ranges valid: removing from the end first is fine
      edits.push({ ...r, text: "" });
    }
  }
  return mergeEdits(edits);
}
function mergeEdits(edits) {
  edits.sort((a, b) => a.start - b.start);
  const out = [];
  for (const e of edits) {
    const last = out[out.length - 1];
    if (last && e.start < last.end) { last.end = Math.max(last.end, e.end); continue; }
    out.push({ ...e });
  }
  return out;
}

/** Identifier names used in a piece of code (to know which imports may have become unused). */
export function namesIn(text) {
  return new Set(text.match(/[A-Za-z_$][\w$]*/g) || []);
}

// ---------------------------------------------------------------- draw order (moving statements)
/** The list (block body / array) holding the statement or element that contains `pos`. */
export function containerOf(ast, pos, kind = "stmt") {
  let found = null;
  walk(ast.program, (n) => {
    if (pos < n.start || pos > n.end) return;
    if (kind === "stmt") {
      if (BLOCK_TYPES.has(n.type)) {
        const i = n.body.findIndex((st) => st.start <= pos && pos < st.end);
        if (i >= 0) found = { list: n.body, index: i, node: n.body[i] };
      }
    } else if (n.type === "ArrayExpression") {
      const i = n.elements.findIndex((el) => el && el.start <= pos && pos < el.end);
      if (i >= 0) found = { list: n.elements, index: i, node: n.elements[i] };
    }
  });
  return found;
}

function declaredNames(st) {
  const out = new Set();
  if (st.type === "VariableDeclaration") for (const d of st.declarations) walk(d.id, (n) => { if (n.type === "Identifier") out.add(n.name); });
  if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) out.add(st.id.name);
  return out;
}
function usedNames(st) {
  const out = new Set();
  walk(st, (n, parents) => {
    if (n.type !== "Identifier") return;
    const par = parents[parents.length - 1];
    if (par && par.type === "MemberExpression" && par.property === n && !par.computed) return;
    out.add(n.name);
  });
  return out;
}

/**
 * Edits that move the statement (or array element) at `fromPos` before/after the one at `toPos`,
 * so the object is added to its parent in another order. Refuses moves that would use a variable
 * before it is declared.
 * @returns {{ error } | { edits, moved: { start, end }, insertAt, prefix }}
 */
export function moveEdits(code, fromPos, toPos, place, kind = "stmt") {
  const ast = parseCode(code);
  const A = containerOf(ast, fromPos, kind), B = containerOf(ast, toPos, kind);
  if (!A || !B) return { error: "the code that adds it was not found" };
  if (A.list !== B.list) return { error: "the two objects are added in different places in the code" };
  if (A.index === B.index) return { error: "both objects are added by the same line" };
  const a = A.node, b = B.node;
  const earlier = b.start < a.start;
  if (kind === "stmt") {
    const lo = earlier ? (place === "before" ? B.index : B.index + 1) : A.index + 1;
    const hi = earlier ? A.index : (place === "before" ? B.index : B.index + 1);
    const between = A.list.slice(lo, hi);
    const usesA = usedNames(a), declA = declaredNames(a);
    for (const st of between) {
      if (earlier) {
        const clash = [...declaredNames(st)].find((n) => usesA.has(n));
        if (clash) return { error: `it needs ${clash}, which is declared later (line ${lineOfPos(code, st.start)})` };
      } else {
        const used = usedNames(st);
        const clash = [...declA].find((n) => used.has(n));
        if (clash) return { error: `${clash} is used at line ${lineOfPos(code, st.start)} before the new place` };
      }
    }
    const text = code.slice(a.start, a.end);
    const rm = statementRange(code, a.start, a.end);
    const lineStart = code.lastIndexOf("\n", b.start - 1) + 1;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))[0];
    const ins = place === "before"
      ? { start: b.start, end: b.start, text: `${text}\n${indent}`, prefix: 0 }
      : { start: b.end, end: b.end, text: `\n${indent}${text}`, prefix: 1 + indent.length };
    return { edits: [{ ...rm, text: "" }, ins], moved: { start: a.start, end: a.end }, anchor: { start: b.start, end: b.end }, removed: rm, insert: ins };
  }
  // Array element: children: [a, b] -> [b, a]
  const text = code.slice(a.start, a.end);
  const rm = elementRange(code, A.list, A.index);
  const ins = place === "before"
    ? { start: b.start, end: b.start, text: `${text}, `, prefix: 0 }
    : { start: b.end, end: b.end, text: `, ${text}`, prefix: 2 };
  return { edits: [{ ...rm, text: "" }, ins], moved: { start: a.start, end: a.end }, anchor: { start: b.start, end: b.end }, removed: rm, insert: ins };
}
