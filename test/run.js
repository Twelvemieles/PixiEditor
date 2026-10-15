// Quick tests for the instrumenter and the source rewriter: `npm test`
import assert from "node:assert/strict";
import { instrument } from "../src/instrument.js";
import { analyzeObject, deleteEdits, duplicateEdits, pruneImports, namesIn, moveEdits } from "../src/refactor.js";
import { applyDelta, planEdits, planImport, serializeParams, literalValue, lineDiff } from "../src/writeback.js";

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

console.log("OK — all tests pass");
