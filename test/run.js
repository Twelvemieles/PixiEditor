// Quick tests for the instrumenter and the source rewriter: `npm test`
import assert from "node:assert/strict";
import { instrument } from "../src/instrument.js";
import { analyzeObject, deleteEdits, duplicateEdits, pruneImports, namesIn, moveEdits } from "../src/refactor.js";
import { applyDelta, planEdits, planImport, serializeParams, literalValue, lineDiff } from "../src/writeback.js";
import { scanHtml, htmlRegistry, markHtml, planHtmlEdits, applyHtmlEdits, parseStyle, jsEscaper } from "../src/html.js";
import { scanCss, ruleKeys, cssRegistry, planCssEdits, normSelector, normCondition } from "../src/css.js";

const cases = [
  ["22", 18, "40"],
  ["app.renderer.width - 10", -14, "app.renderer.width - 24"],
  ["44 + i * 22", 10, "54 + i * 22"],
  ["x + 3", -5, "x - 2"],
  ["foo", 5, "foo + 5"],
  ["a ? 1 : 2", 3, "(a ? 1 : 2) + 3"],
  ["-5", 2, "-3"],
  ["0.5", 0.25, "0.75"],
];
for (const [t, d, want] of cases) assert.equal(applyDelta(t, d), want, `${t} + ${d}`);

const src = `const hud = new Graphics().rect(0, 0, 10, 10);
hud.alpha = 0.5;
label.position.set(10, 20);
this.icon.scale.set(2);
`;
let n = 0;
const out = instrument(src, "/x.ts", (p) => p + ++n);
assert.equal(out.sites.length, 3);
assert.equal(out.decls.length, 1);
assert.match(out.code, /__pixiEditor\$\.s\(label, "position", "s\d+"\)\.position\.set\(10, 20\)/);

const pos = out.sites.find((s) => s.kind === "position");
const scale = out.sites.find((s) => s.kind === "scale");
const { edits } = planEdits(src, [{ site: pos, deltas: [5, -5] }, { site: scale, deltas: [0.5, 0] }], [
  { decl: out.decls[0], kind: "position", values: [3, 4] },
]);
let code = src;
for (const e of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
assert.match(code, /label\.position\.set\(15, 15\)/);
assert.match(code, /this\.icon\.scale\.set\(2\.5, 2\)/);
assert.match(code, /rect\(0, 0, 10, 10\);\nhud\.position\.set\(3, 4\);/);

// --- components
const csrc = `import { addComponent, Anchor, Tween } from "./pixi-components";
const t = new Text();
addComponent(t, Anchor, { h: "right", v: "top", x: -10, y: 10 });
addComponent(t, Tween);
`;
n = 0;
const cout = instrument(csrc, "/c.ts", (p) => p + ++n);
const anchorSite = cout.sites.find((s) => s.kind === "component:Anchor");
const tweenSite = cout.sites.find((s) => s.kind === "component:Tween");
assert.ok(anchorSite && tweenSite && anchorSite.stmt);
assert.match(cout.code, /addComponent\(__pixiEditor\$\.s\(t, "component:Anchor", "s\d+"\), Anchor/);
let r = planEdits(csrc, [
  { site: anchorSite, params: { h: "right", v: "top", x: -24, y: 10 } },
  { site: tweenSite, remove: true },
], [{ decl: cout.decls[0], kind: "component:Button", params: { hoverScale: 1.1 } }]);
assert.deepEqual(r.errors, []);
let ccode = csrc;
for (const e of r.edits.sort((a, b) => b.start - a.start)) ccode = ccode.slice(0, e.start) + e.text + ccode.slice(e.end);
assert.match(ccode, /addComponent\(t, Anchor, \{ h: "right", v: "top", x: -24, y: 10 \}\);/);
assert.doesNotMatch(ccode, /Tween\)/);
assert.match(ccode, /const t = new Text\(\);\naddComponent\(t, Button, \{ hoverScale: 1.1 \}\);/);
const imp = planImport(ccode, "./pixi-components", ["addComponent", "Button"]);
const fixed = ccode.slice(0, imp.start) + imp.text + ccode.slice(imp.end);
assert.match(fixed, /^import \{ addComponent, Anchor, Button \} from "\.\/pixi-components";/);
assert.equal(serializeParams({ kind: "float", amount: 6 }), '{ kind: "float", amount: 6 }');
// A missing params literal is filled in.
r = planEdits(csrc, [{ site: tweenSite, params: { kind: "spin", amount: 1, speed: 0.5 } }], []);
const e0 = r.edits[0];
assert.equal(csrc.slice(0, e0.start) + e0.text + csrc.slice(e0.end), csrc.replace("addComponent(t, Tween);", 'addComponent(t, Tween, { kind: "spin", amount: 1, speed: 0.5 });'));


// --- text / color literals
assert.equal(literalValue("'Hello'", "It's", "string"), "'It\\'s'");
assert.equal(literalValue("0xffee44", 0x00ff00, "color"), "0x00ff00");
assert.equal(literalValue('"#4d0824ff"', 0x112233, "color"), '"#112233ff"');
assert.equal(literalValue("i18n.t('x')", "a", "string"), null);

// --- factory helpers, TS casts, Object.assign wrappers
n = 0;
const fsrc = `const app = new Application() as GameApp;
createSprite({ texture: TEX.UI.LOGO, parent: root, position: [X + 10, -25], anchor: 0.5 });
`;
const fout = instrument(fsrc, "/f.ts", (p) => p + ++n);
assert.ok(fout.decls.some((d) => d.name === "app"));
const logo = fout.decls.find((d) => d.name === "LOGO");
assert.equal(logo.factory, "createSprite");
const fpos = fout.sites.find((s) => s.kind === "position");
assert.deepEqual(fpos.args.map((a) => a.text), ["X + 10", "-25"]);
r = planEdits(fsrc, [{ site: fpos, deltas: [5, 0] }], [
  { decl: logo, kind: "label", value: "Logo", mode: "wrap" },
]);
let fcode = fsrc;
for (const e of r.edits.sort((a, b) => b.start - a.start || b.end - a.end)) fcode = fcode.slice(0, e.start) + e.text + fcode.slice(e.end);
assert.match(fcode, /Object\.assign\(createSprite\(\{ texture: TEX\.UI\.LOGO, parent: root, position: \[X \+ 15, -25\], anchor: 0\.5 \}\), \{ label: "Logo" \}\);/);
n = 0;
const again = instrument(fcode, "/f.ts", (p) => p + ++n);
assert.ok(again.sites.some((s) => s.kind === "label"), "label inside Object.assign is recognized");
assert.equal(again.decls.filter((d) => d.factory === "createSprite").length, 1, "no double wrapping");

// --- textures, spines and parents
{
  let k = 0;
  const src = `const coin = Sprite.from("coin");
const hero = Spine.from({ skeleton: "hero.json", atlas: "hero.atlas" });
const bg = createSprite({ texture: TEX.BG, parent: hud, children: [coin], position: [1, 2] });
hud.addChild(hero, coin);
coin.texture = Texture.from("gem");
`;
  const out = instrument(src, "/a.ts", (p) => p + ++k);
  const kinds = out.sites.map((s) => `${s.kind}:${s.form}`).sort();
  assert.deepEqual(kinds, ["parent:call", "parent:call", "parent:children", "parent:option", "position:option", "spine:option", "texture:assign", "texture:option", "texture:option"].sort());
  assert.equal(out.sites.find((s) => s.kind === "spine").args.map((a) => a.text).join(), '"hero.json","hero.atlas"');
  assert.match(out.code, /hud\.addChild\(__pixiEditor\$\.s\(hero, "parent", "s\d+"\), __pixiEditor\$\.s\(coin, "parent", "s\d+"\)\)/);
  assert.match(out.code, /children: \[__pixiEditor\$\.s\(coin, "parent:children", "s\d+"\)\]/);
  const block = instrument("function f() {\n  const a = new Container();\n}\n", "/b.ts", (p) => p + ++k);
  assert.deepEqual(block.decls[0].scope, { start: 13, end: 45 });
}

// --- lines inside pointer handlers are marked transient
{
  let k = 0;
  const src = `const b = createSprite({ texture: "a", events: { pointerover: (sp) => { sp.texture = Texture.from("b"); } } });
b.on("pointerdown", () => b.scale.set(0.9));
b.on("added", () => b.scale.set(2));
items.forEach((it) => it.position.set(1, 2));
`;
  const out = instrument(src, "/h.ts", (p) => p + ++k);
  const t = (kind, form) => out.sites.filter((s) => s.kind === kind && (!form || s.form === form)).map((s) => !!s.transient);
  assert.deepEqual(t("texture", "assign"), [true]);
  assert.deepEqual(t("scale"), [true, false]);
  assert.deepEqual(t("position"), [false]);
  assert.match(out.code, /__pixiEditor\$\.s\(sp, "texture", "s\d+", 1\)/);
}

// --- line diff for the save preview
{
  const a = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk";
  const b = "a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk\nl";
  const h = lineDiff(a, b);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0].lines.map((l) => l.t + l.s).join(","), " a, b,-c,+C, d, e");
  assert.equal(h[1].oldStart, 10);
  assert.equal(h[1].lines.map((l) => l.t + l.s).join(","), " j, k,+l");
  assert.deepEqual(lineDiff("x", "x"), []);
}

// --- delete, duplicate and move objects' code
{
  const apply = (code, edits) => [...edits].sort((a, b) => b.start - a.start).reduce((c, e) => c.slice(0, e.start) + e.text + c.slice(e.end), code);
  const code = `import { Container, Sprite, Text } from "pixi.js";
export function f(hud: Container) {
  const coin = Sprite.from("coin");
  coin.anchor.set(0.5);
  hud.addChild(coin);
  const label = new Text({ text: "x" });
  const group = createContainer({ children: [label, coin] });
  return group;
}
`;
  const at = (t) => ({ start: code.indexOf(t), end: code.indexOf(t) + t.length });
  const a = analyzeObject(code, { ...at('Sprite.from("coin")'), access: "coin" });
  assert.ok(a.ok);
  const edits = deleteEdits(code, a);
  let del = apply(code, edits);
  del = apply(del, pruneImports(del, namesIn(edits.map((e) => code.slice(e.start, e.end)).join("\n"))));
  assert.ok(!/coin/.test(del) && /import \{ Container, Text \} from "pixi.js";/.test(del) && /children: \[label\]/.test(del), del);
  const dup = apply(code, duplicateEdits(code, a, "coin", "coin2").edits);
  assert.match(dup, /hud\.addChild\(coin\);\n  const coin2 = Sprite\.from\("coin"\);\n  coin2\.anchor\.set\(0\.5\);\n  hud\.addChild\(coin2\);/);
  assert.match(dup, /children: \[label, coin, coin2\]/);
  // used by other code: delete is refused, with the line
  const b = analyzeObject(code, { ...at('new Text({ text: "x" })'), access: "label" });
  assert.ok(b.ok); // only a list entry
  const g = analyzeObject(code, { ...at("createContainer({ children: [label, coin] })"), access: "group" });
  assert.ok(!g.ok && g.blockers[0].line === 8);
  // draw order: move a line, refuse to use a variable before it exists
  const mv = moveEdits(code, code.indexOf("hud.addChild(coin)"), code.indexOf("const label"), "after");
  assert.match(apply(code, mv.edits), /const label = new Text\(\{ text: "x" \}\);\n  hud\.addChild\(coin\);/);
  assert.match(moveEdits(code, code.indexOf("hud.addChild(coin)"), code.indexOf("const coin"), "before").error, /declared later/);
  const el = moveEdits(code, code.indexOf("coin]"), code.indexOf("label, coin"), "before", "element");
  assert.match(apply(code, el.edits), /children: \[coin, label\]/);
}

// --- spine animation and text style sites
{
  let k = 0;
  const src = `const t = new Text({ text: "a", style: { fontSize: 24, fontWeight: "700", fill: 0xffffff } });
t.style.align = "center";
const s = createSpineAnimation({ skeletonKey: SPINES.A.SKEL, atlasKey: SPINES.A.ATLAS, animationName: "idle" });
s.state.setAnimation(0, "win", true);
const b = createText({ text: "x", fontSize: 22 });
`;
  const out = instrument(src, "/s.ts", (p) => p + ++k);
  const kinds = out.sites.map((x) => `${x.kind}=${x.args.map((a) => a.text).join("|")}`);
  for (const want of ["style.fontSize=24", 'style.fontWeight="700"', 'style.align="center"', 'animation="idle"', 'animation="win"', "style.fontSize=22"]) {
    assert.ok(kinds.includes(want), `${want} in ${kinds.join(", ")}`);
  }
  assert.match(out.code, /__pixiEditor\$\.s\(s, "animation", "s\d+"\)\.state\.setAnimation\(0, "win", true\)/);
  const fs = out.sites.find((x) => x.kind === "style.fontSize" && x.args[0].text === "24");
  const { edits } = planEdits(src, [{ site: fs, deltas: [4] }], []);
  assert.equal(edits[0].text, "28");
}

// --- HTML elements: document.createElement(...) with a variable is a creation (read-only for now)
{
  let k = 0;
  const dsrc = `const panel = document.createElement("div") as HTMLDivElement;
let input: HTMLInputElement;
input = window.document.createElement("input");
panel.appendChild(input);
const other = doc.createElement("p");
`;
  const out = instrument(dsrc, "/dom.ts", (p) => p + ++k);
  // (any other createX() call is still a factory creation; the runtime tells elements apart)
  assert.deepEqual(out.decls.map((d) => [d.name, !!d.dom]), [["panel", true], ["input", true], ["other", false]]);
  assert.match(out.code, /const panel = __pixiEditor\$\.d\(document\.createElement\("div"\) as HTMLDivElement, "d\d+", "panel", \{\}, 1\)/);
}

// --- HTML properties: inline style, element properties, setAttribute, setProperty, Object.assign
{
  let k = 0;
  const hsrc = `const btn = document.createElement("button");
btn.textContent = "Play";
btn.style.fontSize = "1.2em";
btn.style.backgroundColor = "#ff3388";
btn.style.setProperty("border-radius", "8px");
btn.setAttribute("maxlength", "20");
Object.assign(btn.style, { padding: "4px", "margin-top": "2px" });
btn.onmouseover = () => { btn.style.color = "red"; };
`;
  const out = instrument(hsrc, "/html.ts", (p) => p + ++k);
  const kinds = out.sites.map((s) => s.kind);
  assert.deepEqual(kinds, ["attr:textContent", "style.fontSize", "css:background-color", "css:border-radius", "attr:maxLength", "css:padding", "css:margin-top", "css:color"]);
  assert.equal(out.sites.find((s) => s.kind === "css:color").transient, true);
  assert.equal(out.sites.find((s) => s.kind === "css:border-radius").args[0].text, '"8px"');
  assert.match(out.code, /__pixiEditor\$\.s\(btn, "css:background-color", "s\d+"\)\.style\.backgroundColor = "#ff3388"/);
  // Object.assign wraps the element once per property (nested), and stays valid code
  assert.match(out.code, /Object\.assign\(__pixiEditor\$\.s\(__pixiEditor\$\.s\(btn, "css:margin-top", "s\d+"\), "css:padding", "s\d+"\)\.style, \{/);

  // Saving: literals keep their kind; missing properties get a line after the creation
  const site = (kind) => out.sites.find((s) => s.kind === kind);
  const r = planEdits(hsrc, [
    { site: site("attr:textContent"), value: "Go!", valueType: "dom" },
    { site: site("style.fontSize"), value: "2em", valueType: "dom" },
    { site: site("attr:maxLength"), value: 30, valueType: "dom" },
  ], [
    { decl: out.decls[0], kind: "css:text-align", value: "center" },
    { decl: out.decls[0], kind: "attr:title", value: "Start" },
    { decl: out.decls[0], kind: "css:--glow", value: "1" },
  ]);
  assert.deepEqual(r.errors, []);
  let hcode = hsrc;
  for (const e of r.edits.sort((a, b) => b.start - a.start)) hcode = hcode.slice(0, e.start) + e.text + hcode.slice(e.end);
  assert.match(hcode, /btn\.textContent = "Go!";/);
  assert.match(hcode, /btn\.style\.fontSize = "2em";/);
  assert.match(hcode, /setAttribute\("maxlength", "30"\)/); // a string literal stays a string
  assert.match(hcode, /createElement\("button"\);\nbtn\.style\.textAlign = "center";\nbtn\.title = "Start";\nbtn\.style\.setProperty\("--glow", "1"\);\n/);
  assert.equal(literalValue("20", 30, "dom"), "30");
  assert.equal(literalValue("`a`", "b", "dom"), "`b`");
  assert.equal(literalValue("size + 'px'", "3px", "dom"), null);
}

// --- DOMContainer: `X.element.style.*` lines belong to the element; missing ones go after X
{
  let k = 0;
  const src = `const panel = new DOMContainer({ element: document.createElement("div"), anchor: 0.5 });
panel.element.style.padding = "8px";
panel.element.textContent = "Hi";
`;
  const out = instrument(src, "/dc.ts", (p) => p + ++k);
  assert.deepEqual(out.sites.filter((x) => x.obj === "panel.element").map((x) => x.kind), ["css:padding", "attr:textContent"]);
  const decl = out.decls.find((d) => d.access === "panel");
  const r = planEdits(src, [], [{ decl, kind: "css:color", value: "#fff", via: "element" }]);
  assert.deepEqual(r.errors, []);
  assert.match(applyHtmlEdits(src, r.edits), /anchor: 0\.5 \}\);\npanel\.element\.style\.color = "#fff";\npanel\.element\.style\.padding/);
}

// --- index.html: elements, their attributes/style/text, and rewriting them
{
  const html = `<!doctype html>
<html><head><title>T</title><style>p { color: red; }</style></head>
<body>
  <!-- <div>commented</div> -->
  <div id="credits" style="position: fixed; left: 8px; color: #888 !important">Made with Pixi</div>
  <input placeholder='Name' maxlength=20 />
  <section class="menu"><button>Play</button></section>
  <p></p>
  <script type="module" src="/src/main.ts"></script>
</body></html>`;
  const els = scanHtml(html);
  assert.deepEqual(els.map((e) => e.tag), ["div", "input", "section", "button", "p"]);
  let k = 0;
  const ids = new Map();
  const idFor = (key, p) => { if (!ids.has(key)) ids.set(key, p + ++k); return ids.get(key); };
  const reg = htmlRegistry(html, idFor);
  const site = (decl, kind) => reg.sites.find((x) => x.declId === reg.decls[decl].id && x.kind === kind);
  assert.equal(site(0, "css:left").args[0].text, "8px");
  assert.equal(site(0, "css:color").args[0].text, "#888"); // without !important
  assert.equal(site(0, "attr:textContent").args[0].text, "Made with Pixi");
  assert.equal(site(1, "attr:maxLength").args[0].text, "20");
  assert.equal(site(2, "attr:textContent"), undefined); // holds an element
  assert.equal(site(4, "attr:textContent").args[0].text, ""); // empty <p></p>
  assert.equal(reg.decls[0].name, "#credits");
  const marked = markHtml(html, reg.marks);
  assert.match(marked, /<input placeholder='Name' maxlength=20 data-pe="d\d+ attr:placeholder=s\d+ attr:maxLength=s\d+" \/>/);
  assert.match(marked, /<div id="credits" style="[^"]*" data-pe="d\d+ attr:id=s\d+ css:position=/);
  // Rescanning keeps the ids
  assert.deepEqual(htmlRegistry(html, idFor).sites.map((x) => x.id), reg.sites.map((x) => x.id));

  const styleOf = (declId) => reg.sites.find((x) => x.declId === declId && x.kind === "html:style") || null;
  const r = planHtmlEdits(html, [
    { site: site(0, "css:left"), value: "12px" },
    { site: site(0, "attr:textContent"), value: "Pixi & <friends>" },
    { site: site(1, "attr:maxLength"), value: 30 },
    { site: site(1, "attr:placeholder"), value: "Your 'name'" },
  ], [
    { decl: reg.decls[0], kind: "css:font-size", value: "14px" },
    { decl: reg.decls[3], kind: "css:color", value: 'say "hi"' },
    { decl: reg.decls[3], kind: "attr:title", value: "Start" },
  ], styleOf);
  assert.deepEqual(r.errors, []);
  const out = applyHtmlEdits(html, r.edits);
  assert.match(out, /style="position: fixed; left: 12px; color: #888 !important; font-size: 14px">Pixi &amp; &lt;friends&gt;<\/div>/);
  assert.match(out, /<input placeholder='Your &#39;name&#39;' maxlength="30" \/>/);
  assert.match(out, /<button title="Start" style="color: say &quot;hi&quot;">Play<\/button>/);
  assert.deepEqual(parseStyle('background: url("a;b.png"); color: red;').map((d) => d.prop), ["background", "color"]);
}

// --- CSS files: rules, keys that match the browser's CSSOM, and rewriting declarations
{
  const css = `/* top */
@import url("x.css");
.game-shell {
  height: 100%;
  background: #060b13;
}
.a, .b > .c{color:red !important}
.empty {}
@media (max-width: 900px) {
  .game-shell {
    height: auto;
    min-height: 100dvh
  }
}
@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }
input[type=range]::before { content: "a;b{" }
.game-shell { overflow: clip; }
`;
  const rules = scanCss(css);
  assert.deepEqual(rules.map((r) => r.selector), [".game-shell", ".a, .b > .c", ".empty", ".game-shell", "input[type=range]::before", ".game-shell"]);
  assert.deepEqual(ruleKeys(rules), ["|.game-shell|0", "|.a,.b>.c|0", "|.empty|0", "@media(max-width:900px)|.game-shell|0", '|input[type="range"]::before|0', "|.game-shell|1"]);
  // the CSSOM's texts normalize to the same keys
  assert.equal(normSelector(".a, .b > .c"), normSelector(".a,.b>.c"));
  assert.equal(normSelector('input[type="range"]::before'), normSelector("input[type=range]:before"));
  assert.equal(normCondition("@media (max-width: 900px)"), normCondition("@media (max-width:900px)"));
  let k = 0;
  const ids = new Map();
  const idFor = (key, p) => { if (!ids.has(key)) ids.set(key, p + ++k); return ids.get(key); };
  const reg = cssRegistry(css, idFor);
  const decl = (sel, n = 0) => reg.decls.filter((d) => d.name === sel)[n];
  const site = (d, prop) => reg.sites.find((x) => x.declId === d.id && x.kind === "css:" + prop);
  assert.equal(site(decl(".a, .b > .c"), "color").args[0].text, "red"); // without !important
  assert.deepEqual(cssRegistry(css, idFor).sites.map((x) => x.id), reg.sites.map((x) => x.id)); // stable ids
  const r = planCssEdits(css, [
    { site: site(decl(".game-shell"), "height"), value: "90%" },
    { site: site(decl(".a, .b > .c"), "color"), value: "#00f" },
  ], [
    { decl: decl(".game-shell"), kind: "css:padding", value: "4px 8px" },
    { decl: decl(".game-shell", 1), kind: "css:color", value: "red" },
    { decl: decl(".a, .b > .c"), kind: "css:top", value: "0" },
    { decl: decl(".empty"), kind: "css:left", value: "1px" },
    { decl: decl(".game-shell", 2), kind: "css:top", value: "2px" },
  ]);
  assert.deepEqual(r.errors, []);
  const out = applyHtmlEdits(css, r.edits);
  assert.match(out, /\.game-shell \{\n  height: 90%;\n  background: #060b13;\n  padding: 4px 8px;\n\}/);
  assert.match(out, /\.a, \.b > \.c\{color:#00f !important; top: 0; \}/);
  assert.match(out, /\.empty \{ left: 1px; \}/);
  assert.match(out, /    min-height: 100dvh;\n    color: red;\n  \}/);
  assert.match(out, /\.game-shell \{ overflow: clip; top: 2px; \}/);
  assert.match(out, /@keyframes spin \{ from \{ transform: rotate\(0\) \}/); // untouched
  assert.deepEqual(planCssEdits(css, [{ site: site(decl(".empty"), "x") || site(decl(".game-shell"), "height"), value: "1px; color: red" }], []).errors.length, 1);
}

// --- HTML in innerHTML templates: static parts linked, ${…} parts computed, markers in the code
{
  let k = 0;
  const src = "el.innerHTML = `<div class=\"a\" title=\"${t}\">Hi <b>${n}</b></div>` + '<p class=\"x\">Ok</p>';\nlist.insertAdjacentHTML(\"beforeend\", \"<li class='i'>One</li>\");\n";
  const ids = new Map();
  const idFor = (key, p) => { if (!ids.has(key)) ids.set(key, p + ++k); return ids.get(key); };
  const out = instrument(src, "/t.ts", (p) => p + ++k, { htmlIdFor: idFor });
  const kinds = out.sites.filter((x) => x.tpl).map((x) => `${x.kind}=${x.args[0].text}`);
  assert.deepEqual(kinds, ["attr:className=a", "attr:className=x", "attr:textContent=Ok", "attr:className=i", "attr:textContent=One"]); // title=${t} and "Hi <b>…" are computed
  assert.match(out.code, /<div class="a" title="\$\{t\}" data-pe="d\d+ tpl attr:className=s\d+">/);
  assert.match(out.code, /<li class='i' data-pe='d\d+ tpl attr:className=s\d+ attr:textContent=s\d+'>/); // inside "…": ' quotes
  // same ids when transformed again
  const again = instrument(src, "/t.ts", (p) => p + ++k, { htmlIdFor: idFor });
  assert.deepEqual(again.sites.filter((x) => x.tpl).map((x) => x.id), out.sites.filter((x) => x.tpl).map((x) => x.id));
  // saving into the JS strings
  const site = (kind, n = 0) => out.sites.filter((x) => x.tpl && x.kind === kind)[n];
  const tick = planHtmlEdits(src, [{ site: site("attr:className"), value: "b `c` ${d}" }], [{ decl: out.decls.find((d) => d.tpl && d.name === "div"), kind: "attr:title", value: "x" }], () => null, { escape: jsEscaper("`") });
  assert.equal(tick.errors.length, 1); // title="${t}" is computed: not added a second time
  const dq = planHtmlEdits(src, [{ site: site("attr:textContent", 1), value: 'Say "hi"' }], [{ decl: out.decls.find((d) => d.tpl && d.name === "li"), kind: "attr:title", value: "T" }], () => null, { attrQuote: "'", escape: jsEscaper('"') });
  const res = applyHtmlEdits(src, [...tick.edits, ...dq.edits]);
  assert.match(res, /<div class="b \\`c\\` \\\$\{d\}" title="\$\{t\}">/);
  assert.match(res, /"<li class='i' title='T'>Say \\"hi\\"<\/li>"/);
}

console.log("OK — all tests pass");
