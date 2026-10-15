// Instruments the game's source so the editor knows, at runtime, which line of
// code set each property of each Pixi object.
//
//   scoreText.position.set(22, 18)
//     -> __pe.s(scoreText, "position", "s12").position.set(22, 18)
//   const hudBg = new Graphics()...
//     -> const hudBg = __pe.d(new Graphics()..., "d3", "hudBg")
//
// Instrumented code behaves exactly the same: __pe.s and __pe.d return the
// object they receive.
import { parse } from "@babel/parser";
import MagicString from "magic-string";

export const PE = "__pixiEditor$";

// Vector properties set via .set(a, b) or assignment.
const VEC = new Set(["position", "scale", "anchor", "pivot", "skew"]);
// Scalar properties set via assignment.
const SCALAR = new Set(["x", "y", "rotation", "angle", "alpha", "text", "label", "tint", "texture"]);

const SKIP_KEYS = new Set(["loc", "start", "end", "extra", "leadingComments", "trailingComments", "innerComments", "range"]);

function walk(node, parents, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parents);
  parents.push(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") walk(c, parents, visit);
    } else if (v && typeof v.type === "string") {
      walk(v, parents, visit);
    }
  }
  parents.pop();
}

function propName(member) {
  if (!member || member.computed) return null;
  if (member.type !== "MemberExpression") return null;
  return member.property.type === "Identifier" ? member.property.name : null;
}

// Strips TypeScript-only wrappers: `x as T`, `x satisfies T`, `x!`, `<T>x`, `(x)`.
const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion", "ParenthesizedExpression"]);
export function unwrapTS(node) {
  let n = node;
  while (n && TS_WRAPPERS.has(n.type)) n = n.expression;
  return n;
}

// Factory helpers that build display objects: createSprite({...}), makeButton({...}), buildPanel({...})
export const FACTORY_RE = /^(create|make|build)[A-Z]\w*$/;
const isFactoryCall = (n) => n && n.type === "CallExpression" && FACTORY_RE.test(calleeName(n) || "");

/** The `new X(...)` or factory call at the root of a creation chain, plus the chained calls after it (innermost first). */
export function creationParts(node) {
  const calls = [];
  let n = unwrapTS(node);
  while (n) {
    if (n.type === "NewExpression" || isFactoryCall(n)) return { root: n, calls: calls.reverse() };
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      calls.push(n);
      n = unwrapTS(n.callee.object);
      continue;
    }
    return null;
  }
  return null;
}
function calleeName(n) {
  if (n.callee.type === "Identifier") return n.callee.name;
  if (n.callee.type === "MemberExpression") return propName(n.callee);
  return null;
}

/** Object.assign(<creation>, { … }) — how the editor saves properties of objects without a variable. */
export function assignWrapper(node) {
  const n = unwrapTS(node);
  if (
    n && n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed &&
    n.callee.object.type === "Identifier" && n.callee.object.name === "Object" && n.callee.property.name === "assign" &&
    n.arguments.length === 2 && n.arguments[1].type === "ObjectExpression" && isCreation(n.arguments[0])
  ) return { call: n, inner: n.arguments[0], lit: n.arguments[1] };
  return null;
}

// new X(...), new X().a().b(), X.from(...), and the same inside `as T` casts
function isCreation(node) {
  if (assignWrapper(node)) return true;
  let n = unwrapTS(node);
  while (n) {
    if (n.type === "NewExpression" || isFactoryCall(n)) return true;
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const callee = n.callee;
      if (callee.object.type === "Identifier" && propName(callee) === "from" && /^[A-Z]/.test(callee.object.name)) return true;
      n = unwrapTS(callee.object);
      continue;
    }
    return false;
  }
  return false;
}

// Pointer events: { events: { pointerover: (sp) => … } }, onPointerDown: …, obj.on("pointerout", …)
const POINTER_EVENT_RE = /^(on)?(pointer|mouse|touch|click|tap|hover|press|release|rightclick|rightdown|rightup)/i;
const LISTEN_RE = /^(on|once|addListener|addEventListener)$/;
const FUNCTION_TYPES = new Set(["ArrowFunctionExpression", "FunctionExpression", "ObjectMethod", "ClassMethod"]);
/** True when the innermost-to-outermost function chain contains a pointer event handler. */
function inPointerHandler(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const fn = parents[i];
    if (!FUNCTION_TYPES.has(fn.type)) continue;
    const keyName = (k) => (k && (k.type === "Identifier" ? k.name : k.type === "StringLiteral" ? k.value : null)) || "";
    if (fn.type === "ObjectMethod" && POINTER_EVENT_RE.test(keyName(fn.key))) return true;
    const p = parents[i - 1];
    if (!p) continue;
    if (p.type === "ObjectProperty" && p.value === fn && POINTER_EVENT_RE.test(keyName(p.key))) return true;
    if (p.type === "AssignmentExpression" && p.right === fn && p.left.type === "MemberExpression" && POINTER_EVENT_RE.test(keyName(p.left.property))) return true;
    if (p.type === "CallExpression" && p.arguments.includes(fn) && p.callee.type === "MemberExpression" && LISTEN_RE.test(keyName(p.callee.property))) {
      const ev = p.arguments[0];
      if (ev && ev.type === "StringLiteral" && POINTER_EVENT_RE.test(ev.value)) return true;
    }
  }
  return false;
}

function lineIndent(code, pos) {
  const lineStart = code.lastIndexOf("\n", pos - 1) + 1;
  const m = /^[ \t]*/.exec(code.slice(lineStart));
  return m ? m[0] : "";
}

/**
 * Parses and transforms one file.
 * @returns {{ code: string, map: object, sites: object[], decls: object[] } | null}
 */
export function instrument(code, file, nextId) {
  let ast;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "decorators-legacy", ...(/\.[jt]sx$/.test(file) ? ["jsx"] : [])],
    });
  } catch {
    return null;
  }

  const s = new MagicString(code);
  const sites = [];
  const decls = [];

  let currentParents = [];
  const wrapObj = (objNode, kind, id) => {
    const site = sites.find((x) => x.id === id);
    if (site) site.obj = code.slice(objNode.start, objNode.end); // e.g. "scoreText", "this.title"
    // Lines inside pointer handlers (hover/press states) never replace the object's setup line.
    const transient = inPointerHandler(currentParents);
    if (site && transient) site.transient = true;
    s.appendLeft(objNode.start, `${PE}.s(`);
    s.prependRight(objNode.end, `, ${JSON.stringify(kind)}, ${JSON.stringify(id)}${transient ? ", 1" : ""})`);
  };
  const arg = (n) => ({ start: n.start, end: n.end, text: code.slice(n.start, n.end) });
  const objProp = (obj, key) =>
    obj && obj.type === "ObjectExpression"
      ? obj.properties.find((p) => p.type === "ObjectProperty" && !p.computed && ((p.key.type === "Identifier" && p.key.name === key) || (p.key.type === "StringLiteral" && p.key.value === key)))
      : null;
  const wrappedRoots = new Set();

  /** Sites inside the creation expression itself: constructor/factory options and chained `.fill()` calls. */
  function creationSites(init) {
    const wrapper = assignWrapper(init);
    if (wrapper) {
      wrappedRoots.add(wrapper.call);
      const opts = creationSites(wrapper.inner);
      // Properties in the Object.assign literal are applied after creation, so they win.
      Object.assign(opts, literalSites(wrapper.lit, true, "object"));
      return opts;
    }
    const parts = creationParts(init);
    const opts = {};
    if (!parts) {
      // Sprite.from("coin") / Spine.from({ skeleton, atlas })
      const n = unwrapTS(init);
      if (n && n.type === "CallExpression" && n.callee.type === "MemberExpression" && propName(n.callee) === "from" && n.callee.object.type === "Identifier") {
        const a = n.arguments[0];
        const cls = n.callee.object.name;
        if (a && a.type === "ObjectExpression") {
          const sp = literalSites(a, false, "object", true);
          if (sp.spine) opts.spine = sp.spine;
        } else if (a && a.type !== "SpreadElement" && /Sprite$/.test(cls)) {
          const id = nextId("s");
          sites.push({ id, kind: "texture", form: "option", args: [arg(a)] });
          opts.texture = id;
        }
      }
      return opts;
    }
    const { root, calls } = parts;
    wrappedRoots.add(root);
    const isNew = root.type === "NewExpression";
    const add = (kind, valueNodes) => {
      const nodes = (Array.isArray(valueNodes) ? valueNodes : [valueNodes]).filter(Boolean);
      if (!nodes.length || nodes.some((n) => n.type === "SpreadElement")) return;
      const id = nextId("s");
      sites.push({ id, kind, form: "option", args: nodes.map(arg) });
      opts[kind] = id;
    };
    const a0 = root.arguments[0];
    const a1 = root.arguments[1];
    const isTextClass = /Text$/.test(calleeName(root) || "");
    if (a0 && a0.type === "ObjectExpression") {
      // Factories may give `tint` another meaning; Pixi constructors take points as { x, y }.
      Object.assign(opts, literalSites(a0, isNew, isNew ? "object" : "array"));
    } else if (isNew && isTextClass && a0 && (a0.type === "StringLiteral" || a0.type === "TemplateLiteral")) {
      add("text", a0); // new Text("Hello", style)
      add("style.fill", objProp(a1, "fill")?.value);
    } else if (isNew && /Sprite$/.test(calleeName(root) || "") && a0) {
      add("texture", a0); // new Sprite(texture)
    }
    // new Graphics().rect(...).fill(0xff0000).circle(...).fill({ color: "#fff" })
    let fillIndex = 0;
    for (const call of calls) {
      if (propName(call.callee) !== "fill") continue;
      const f = call.arguments[0];
      const colorNode = f && f.type === "ObjectExpression" ? objProp(f, "color")?.value : f;
      if (colorNode) add(`gfill:${fillIndex}`, colorNode);
      fillIndex++;
    }
    return opts;
  }

  function firstString(node, depth = 0) {
    if (!node || depth > 4 || typeof node !== "object") return null;
    if (node.type === "StringLiteral") return node.value;
    for (const k of ["callee", "object", "arguments", "expression"]) {
      const v = node[k];
      for (const c of Array.isArray(v) ? v : [v]) {
        const r = c && typeof c.type === "string" ? firstString(c, depth + 1) : null;
        if (r) return r;
      }
    }
    return null;
  }

  // position: [x, y] | { x, y } | n
  function vecArgs(v) {
    if (!v) return null;
    if (v.type === "ArrayExpression" && v.elements.length >= 1 && v.elements.length <= 2 && v.elements.every((e) => e && e.type !== "SpreadElement")) return v.elements;
    if (v.type === "ObjectExpression") {
      const x = objProp(v, "x")?.value, y = objProp(v, "y")?.value;
      return x && y ? [x, y] : null;
    }
    return [v];
  }

  /** Code sites for the display properties written in an options object literal. */
  function literalSites(lit, withTint, vecStyle, spineOnly = false) {
    const opts = {};
    const add = (kind, valueNodes) => {
      const nodes = (Array.isArray(valueNodes) ? valueNodes : [valueNodes]).filter(Boolean);
      if (!nodes.length || nodes.some((n) => n.type === "SpreadElement")) return;
      const id = nextId("s");
      sites.push({ id, kind, form: "option", vecStyle, args: nodes.map(arg) });
      opts[kind] = id;
    };
    // Spine: { skeleton, atlas } (Spine.from) or { skeletonKey, atlasKey } (helpers)
    const skel = objProp(lit, "skeleton") || objProp(lit, "skeletonKey");
    const atlas = objProp(lit, "atlas") || objProp(lit, "atlasKey");
    if (skel && atlas) add("spine", [skel.value, atlas.value]);
    if (spineOnly) return opts;
    for (const key of ["position", "scale", "anchor", "pivot", "skew"]) {
      const v = vecArgs(objProp(lit, key)?.value);
      if (v) add(key, v);
    }
    add("texture", objProp(lit, "texture")?.value);
    add("parent", objProp(lit, "parent")?.value);
    // children: [a, b] — each child records where it is added
    const kids = objProp(lit, "children")?.value;
    if (kids && kids.type === "ArrayExpression") {
      for (const el of kids.elements) {
        if (!el || (el.type !== "Identifier" && el.type !== "MemberExpression")) continue;
        const id = nextId("s");
        sites.push({ id, kind: "parent", form: "children", args: [arg(el)] });
        wrapObj(el, "parent:children", id);
      }
    }
    for (const key of ["x", "y", "rotation", "angle", "alpha", "label", "text"]) add(key, objProp(lit, key)?.value);
    if (withTint) add("tint", objProp(lit, "tint")?.value);
    add("style.fill", objProp(objProp(lit, "style")?.value, "fill")?.value);
    return opts;
  }

  /** A readable name for an object created without a variable. */
  function guessName(init) {
    const w = assignWrapper(init);
    if (w) {
      const label = objProp(w.lit, "label")?.value;
      if (label && label.type === "StringLiteral") return label.value;
      return guessName(w.inner);
    }
    const parts = creationParts(init);
    if (!parts) return "object";
    const a0 = parts.root.arguments[0];
    const str = (n) => (n && n.type === "StringLiteral" ? n.value : n && n.type === "TemplateLiteral" && !n.expressions.length ? n.quasis[0].value.cooked : null);
    if (a0 && a0.type === "ObjectExpression") {
      const label = str(objProp(a0, "label")?.value);
      if (label) return label;
      const textNode = objProp(a0, "text")?.value;
      const text = str(textNode) || firstString(textNode); // i18n.t("common.balance") -> common.balance
      if (text) return `"${text.length > 22 ? text.slice(0, 21) + "…" : text}"`;
      const tex = objProp(a0, "texture")?.value;
      if (tex && tex.type === "MemberExpression" && !tex.computed) return tex.property.name;
      const texStr = str(tex);
      if (texStr) return texStr.split("/").pop();
    }
    const n = calleeName(parts.root) || "object";
    return parts.root.type === "NewExpression" ? n : n.replace(/^(create|make|build)/, "").replace(/^./, (c) => c.toLowerCase()) || n;
  }

  /**
   * The code range where `target` can be used: the block of a `const`/`let`, the class body for
   * `this.x`, the whole file otherwise.
   */
  function scopeOf(parents, target, node) {
    const BLOCKS = new Set(["BlockStatement", "Program", "StaticBlock", "SwitchCase"]);
    for (let i = parents.length - 1; i >= 0; i--) {
      const p = parents[i];
      if (target.startsWith("this.") ? p.type === "ClassBody" : node.type === "VariableDeclarator" && BLOCKS.has(p.type)) {
        return { start: p.start, end: p.end };
      }
    }
    return { start: 0, end: code.length };
  }

  walk(ast.program, [], (node, parents) => {
    currentParents = parents;
    // --- addComponent(E, Type, { ...params })
    if (
      node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "addComponent" &&
      node.arguments.length >= 2 && node.arguments[1].type === "Identifier" && node.arguments[0].type !== "SpreadElement"
    ) {
      const parent = parents[parents.length - 1];
      const p = node.arguments[2];
      const id = nextId("s");
      sites.push({
        id,
        kind: `component:${node.arguments[1].name}`,
        form: "component",
        // Missing params literal: an empty range right after the type, filled in on save.
        args: p ? [arg(p)] : [{ start: node.arguments[1].end, end: node.arguments[1].end, text: "", prefix: ", " }],
        stmt: parent && parent.type === "ExpressionStatement" ? { start: parent.start, end: parent.end, text: code.slice(parent.start, parent.end) } : null,
      });
      wrapObj(node.arguments[0], `component:${node.arguments[1].name}`, id);
      return;
    }

    // --- P.addChild(E) / P.addChildAt(E, i): where E is added (the parent can be changed in the editor)
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && /^addChild(At)?$/.test(propName(node.callee) || "")) {
      const P = node.callee.object;
      const kids = propName(node.callee) === "addChildAt" ? node.arguments.slice(0, 1) : node.arguments;
      for (const E of kids) {
        if (!E || E.type === "SpreadElement") continue;
        const id = nextId("s");
        sites.push({ id, kind: "parent", form: "call", args: [arg(P)] });
        wrapObj(E, "parent", id);
      }
      // keep going: the children may be creations
    }

    // --- E.position.set(a, b)  /  E.scale.set(a) ...
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && propName(node.callee) === "set") {
      const vecMember = node.callee.object;
      const vec = propName(vecMember);
      if (vec && VEC.has(vec) && vecMember.object.type !== "Super") {
        if (node.arguments.length >= 1 && node.arguments.length <= 2 && node.arguments.every((a) => a.type !== "SpreadElement")) {
          const id = nextId("s");
          sites.push({ id, kind: vec, form: "call", args: node.arguments.map(arg) });
          wrapObj(vecMember.object, vec, id);
        }
      }
      return;
    }

    if (node.type === "AssignmentExpression" && node.operator === "=" && node.left.type === "MemberExpression") {
      const left = node.left;
      const prop = propName(left);
      if (!prop) return;
      // E.position.x = v   /  E.scale.y = v
      const inner = propName(left.object);
      if ((prop === "x" || prop === "y") && inner && VEC.has(inner) && left.object.object.type !== "Super") {
        const kind = inner === "position" ? prop : `${inner}.${prop}`;
        const id = nextId("s");
        sites.push({ id, kind, form: "assign", args: [arg(node.right)] });
        wrapObj(left.object.object, kind, id);
        return;
      }
      // E.style.fill = v
      if (prop === "fill" && inner === "style" && left.object.object.type !== "Super") {
        const id = nextId("s");
        sites.push({ id, kind: "style.fill", form: "assign", args: [arg(node.right)] });
        wrapObj(left.object.object, "style.fill", id);
        return;
      }
      // E.x = v  /  E.rotation = v  /  E.scale = v  /  E.text = v
      if ((SCALAR.has(prop) || VEC.has(prop)) && left.object.type !== "Super") {
        const id = nextId("s");
        sites.push({ id, kind: prop, form: "assign", args: [arg(node.right)] });
        wrapObj(left.object, prop, id);
      }
      // (keep going: it may also be a creation, below)
    }

    // --- Object creations: const a = new X(), a = new X(), this.a = new X(), field = new X()
    let target = null, init = null, stmt = null;
    const parent = parents[parents.length - 1];
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init && isCreation(node.init)) {
      target = node.id.name;
      init = node.init;
      if (parent && parent.type === "VariableDeclaration" && parent.declarations.length === 1) {
        const gp = parents[parents.length - 2];
        if (gp && (gp.type === "BlockStatement" || gp.type === "Program" || gp.type === "SwitchCase")) stmt = parent;
      }
    } else if (node.type === "AssignmentExpression" && node.operator === "=" && isCreation(node.right)) {
      const l = node.left;
      if (l.type === "Identifier") target = l.name;
      else if (l.type === "MemberExpression" && l.object.type === "ThisExpression" && propName(l)) target = `this.${propName(l)}`;
      if (target) {
        init = node.right;
        if (parent && parent.type === "ExpressionStatement") stmt = parent;
      }
    } else if ((node.type === "ClassProperty" || node.type === "PropertyDefinition") && node.value && isCreation(node.value) && node.key.type === "Identifier" && !node.static) {
      target = `this.${node.key.name}`;
      init = node.value;
    }
    if (target && init) {
      const id = nextId("d");
      const name = target.replace(/^this\./, "");
      const opts = creationSites(init);
      const root = creationParts(assignWrapper(init)?.inner || init)?.root;
      const factory = root && root.type === "CallExpression" ? calleeName(root) : null;
      decls.push({
        id,
        name,
        access: target,
        scope: scopeOf(parents, target, node),
        insertAt: stmt ? stmt.end : null,
        indent: stmt ? lineIndent(code, stmt.start) : "",
        start: init.start,
        end: init.end,
        factory,
        opts,
      });
      s.appendLeft(init.start, `${PE}.d(`);
      s.prependRight(init.end, `, ${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(opts)}${factory ? ", 1" : ""})`);
      return;
    }

    // --- Object.assign(createSprite({...}), { label: "Logo" }) without a variable
    const wrapper = assignWrapper(node);
    if (wrapper && !wrappedRoots.has(node)) {
      const root = creationParts(wrapper.inner)?.root;
      const id = nextId("d");
      const name = guessName(node);
      const opts = creationSites(node);
      const factory = root && root.type === "CallExpression" ? calleeName(root) : null;
      decls.push({ id, name, access: null, insertAt: null, indent: "", start: node.start, end: node.end, factory });
      s.appendLeft(node.start, `${PE}.d(`);
      s.prependRight(node.end, `, ${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(opts)}, 1)`);
      return;
    }

    // --- Factory calls without a variable: createSprite({ parent, position: [10, 20] })
    if (isFactoryCall(node) && !wrappedRoots.has(node)) {
      const parent = parents[parents.length - 1];
      // Skip the callee of a chain (`createX().fill()`): the outer expression is what gets used.
      if (!(parent && parent.type === "MemberExpression" && parent.object === node)) {
        const id = nextId("d");
        const name = guessName(node);
        const opts = creationSites(node);
        decls.push({ id, name, access: null, insertAt: null, indent: "", start: node.start, end: node.end, factory: calleeName(node) });
        s.appendLeft(node.start, `${PE}.d(`);
        s.prependRight(node.end, `, ${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(opts)}, 1)`);
        return;
      }
    }

    // --- Any other `new Application()` (returned, passed as an argument, …): still let the editor find the app.
    if (node.type === "NewExpression" && calleeName(node) === "Application" && !wrappedRoots.has(node)) {
      const id = nextId("d");
      decls.push({ id, name: "app", access: null, insertAt: null, indent: "", start: node.start, end: node.end, factory: null });
      s.appendLeft(node.start, `${PE}.d(`);
      s.prependRight(node.end, `, ${JSON.stringify(id)}, "app")`);
    }
  });

  if (!sites.length && !decls.length) return null;

  s.prepend(`const ${PE} = globalThis.__PIXI_EDITOR__ || { s: (o) => o, d: (o) => o };\n`);
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true, source: file, includeContent: true }),
    sites,
    decls,
  };
}
