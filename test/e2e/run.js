// Browser tests: `npm run e2e`
//
// Copies the fixture projects (test/fixtures) to test/.tmp, starts Pixi Editor on each one, drives
// the editor in Chromium (Playwright) and checks the code it writes. The fixtures use the editor's
// own node_modules (pixi.js, vite, prettier), so `npm install` once is enough.
//
// First time on a machine: `npx playwright install chromium`.
// Options: `npm run e2e -- basic` runs only the scenarios whose name contains "basic";
//          `HEADED=1 npm run e2e` shows the browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { lineDiff } from "../../src/writeback.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const TMP = path.join(REPO, "test/.tmp");
const filter = process.argv[2] || "";

// ---------------------------------------------------------------- tiny test framework
const results = [];
let current = null;
function check(ok, what, detail = "") {
  current.checks.push({ ok: !!ok, what, detail });
  console.log(`    ${ok ? "✓" : "✗"} ${what}${!ok && detail ? `\n        ${String(detail).split("\n").join("\n        ")}` : ""}`);
}
const has = (text, needle) => (needle instanceof RegExp ? needle.test(text) : text.includes(needle));

// ---------------------------------------------------------------- editor process + browser
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Copies a fixture to test/.tmp/<name> (fresh) and returns its path. */
function freshCopy(name) {
  const dest = path.join(TMP, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, "test/fixtures", name), dest, { recursive: true });
  return dest;
}

async function startEditor(project) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pixi-editor-e2e-")); // keeps recent.json out of your home
  const child = spawn(process.execPath, [path.join(REPO, "bin/pixi-editor.js"), project, "--port", String(port), "--no-open"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const url = `http://localhost:${port}/__pixi-editor/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}api/ping`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    log: () => log,
    stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); setTimeout(resolve, 4000); }),
  };
}

async function launchBrowser() {
  const opts = { headless: !process.env.HEADED };
  try {
    return await chromium.launch(opts);
  } catch (err) {
    // Containers with a preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH) but another build number.
    for (const p of ["/opt/pw-browsers/chromium", process.env.CHROMIUM_PATH].filter(Boolean)) {
      if (fs.existsSync(p)) return chromium.launch({ ...opts, executablePath: p });
    }
    throw new Error(`${err.message}\n\nInstall the browser once with: npx playwright install chromium`);
  }
}

/** Helpers bound to one editor page. */
function editorPage(page) {
  const ed = {
    page,
    status: () => page.textContent("#status"),
    async open(url) {
      page.on("pageerror", (e) => console.log(`      [page error] ${e.message}`));
      page.on("dialog", (d) => d.accept());
      await page.goto(url);
      await page.waitForFunction(() => /^Connected to/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
      await page.waitForTimeout(800);
      await page.keyboard.press("Control+e");
      await page.waitForTimeout(200);
    },
    /** Selects the object whose code name (or label) is `name`. */
    select: (name) => page.evaluate((name) => {
      const pe = document.querySelector("#game").contentWindow.__PIXI_EDITOR__;
      let found = null;
      const walk = (o) => { for (const c of o.children) { const m = pe.meta(c); if (!found && ((m && m.name === name) || c.label === name)) found = c; walk(c); } };
      walk(pe.apps[0].stage);
      if (found) window.pixiEditor.select(found);
      if (document.activeElement) document.activeElement.blur();
      return !!found;
    }, name),
    /** Info about the selected object in the game. */
    selected: () => page.evaluate(() => {
      const row = document.querySelector("#tree .node.selected");
      const o = row && row._obj;
      if (!o) return null;
      const pe = document.querySelector("#game").contentWindow.__PIXI_EDITOR__;
      return { name: (pe.meta(o) || {}).name, parent: (pe.meta(o.parent) || {}).name || o.parent.label, index: o.parent.getChildIndex(o), x: o.x, y: o.y };
    }),
    async key(k, times = 1) { for (let i = 0; i < times; i++) await page.keyboard.press(k); },
    /** Cmd/Ctrl+S, then returns the review dialog's diff lines and confirms (or cancels). */
    async save({ confirm = true } = {}) {
      await page.keyboard.press("Control+s");
      await page.waitForSelector("#review-modal:not(.hidden)", { timeout: 10000 });
      await page.waitForFunction(() => !document.querySelector("#review-diff").textContent.includes("Computing"), null, { timeout: 20000 });
      const review = await page.evaluate(() => ({
        changes: [...document.querySelectorAll("#review-changes .change .obj")].map((x) => x.textContent),
        messages: [...document.querySelectorAll("#review-changes .review-msg")].map((x) => x.textContent),
        added: [...document.querySelectorAll("#review-diff .diff-line.add .code")].map((x) => x.textContent.trim()),
        removed: [...document.querySelectorAll("#review-diff .diff-line.del .code")].map((x) => x.textContent.trim()),
      }));
      await page.keyboard.press(confirm ? "Enter" : "Escape");
      if (confirm) await ed.settle();
      return review;
    },
    /** Waits until the status bar stops saying "…ing". */
    async settle() {
      await page.waitForTimeout(300);
      await page.waitForFunction(() => !/(Saving|Checking|Duplicating|Creating|Deleting)/.test(document.querySelector("#status").textContent), null, { timeout: 30000 });
      await page.waitForTimeout(300);
    },
    /** Drags the hierarchy row of `from` onto `to` ("into", "before" or "after"). */
    async dragRow(from, to, where = "into") {
      const box = await page.evaluate(([from, to]) => {
        const pe = document.querySelector("#game").contentWindow.__PIXI_EDITOR__;
        const rows = [...document.querySelectorAll("#tree .node")];
        const find = (name) => rows.find((r) => r._obj && (pe.meta(r._obj) || {}).name === name);
        const a = find(from), b = find(to);
        if (!a || !b) return null;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return { ax: ra.left + 40, ay: ra.top + ra.height / 2, bx: rb.left + 40, by: rb.top, bh: rb.height };
      }, [from, to]);
      if (!box) return false;
      const y = where === "before" ? box.by + 2 : where === "after" ? box.by + box.bh - 2 : box.by + box.bh / 2;
      await page.mouse.move(box.ax, box.ay);
      await page.mouse.down();
      await page.mouse.move(box.ax, box.ay - 6, { steps: 3 });
      await page.mouse.move(box.bx, y, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      return true;
    },
    /** Expands the hierarchy so both rows exist (selecting reveals an object). */
    async reveal(...names) { for (const n of names) await ed.select(n); await page.waitForTimeout(200); },
  };
  return ed;
}

// ---------------------------------------------------------------- scenarios
const read = (project, file) => fs.readFileSync(path.join(project, file), "utf8");
function changed(before, after) {
  return lineDiff(before, after).flatMap((h) => h.lines.filter((l) => l.t !== " ").map((l) => `${l.t} ${l.s.trim()}`)).join("\n");
}

const scenarios = [
  {
    name: "basic: search, move, text style, create",
    fixture: "basic",
    async run(ed, project) {
      const before = read(project, "src/hud.ts");
      await ed.page.keyboard.press("Control+f");
      await ed.page.keyboard.type("hint");
      await ed.page.waitForTimeout(300);
      check((await ed.page.textContent("#tree-count")) === "1", "search finds 1 object");
      await ed.page.keyboard.press("Enter");
      check((await ed.selected())?.name === "hint", "Enter selects the match");
      await ed.key("Escape", 2);

      check(await ed.select("title"), "select title");
      await ed.key("Shift+ArrowRight");
      const size = ed.page.locator("#inspector .row", { has: ed.page.locator("label", { hasText: /^Size$/ }) }).locator("input");
      await size.fill("30");
      await size.press("Enter");
      const review = await ed.save();
      check(review.changes.length === 2, "review lists 2 changes", review.changes.join(", "));
      const after = read(project, "src/hud.ts");
      check(has(after, "title.position.set(30, 20);"), "position written", changed(before, after));
      check(has(after, "fontSize: 30 }"), "font size written", changed(before, after));

      check(await ed.select("side"), "select side");
      await ed.page.click("#btn-create");
      await ed.page.click('#create-menu button[data-kind="text"]');
      await ed.settle();
      const created = read(project, "src/hud.ts");
      check(has(created, /const label = new Text\(\{[^\n]*\n {2}label\.anchor\.set\(0\.5\);\n {2}label\.position\.set\(-?\d+, -?\d+\);\n {2}side\.addChild\(label\);/), "Text created inside side", changed(after, created));
      check((await ed.selected())?.parent === "side", "new text is selected, in side");
    },
  },
  {
    name: "basic: discard in review, duplicate, delete",
    fixture: "basic",
    async run(ed, project) {
      const before = read(project, "src/hud.ts");
      await ed.select("hint");
      await ed.key("ArrowDown", 3);
      await ed.page.keyboard.press("Control+s");
      await ed.page.waitForSelector("#review-modal:not(.hidden)");
      await ed.page.click("#review-changes .change button");
      await ed.page.waitForTimeout(300);
      check(await ed.page.$eval("#review-modal", (m) => m.classList.contains("hidden")), "discarding the only change closes the review");
      check(read(project, "src/hud.ts") === before && (await ed.selected()).y === 52, "nothing written, object back in place");

      await ed.page.keyboard.press("Control+d");
      await ed.settle();
      const dup = read(project, "src/hud.ts");
      check(has(dup, /hud\.addChild\(hint\);\n {2}const hint2 = new Text\(/) && has(dup, "hud.addChild(hint2);"), "duplicate copies the code as hint2", changed(before, dup));
      check((await ed.selected())?.name === "hint2", "the copy is selected");

      await ed.page.keyboard.press("Delete");
      await ed.page.waitForSelector("#review-modal:not(.hidden)");
      const removed = await ed.page.$$eval("#review-diff .diff-line.del", (l) => l.length);
      check(removed === 3, "delete preview shows the 3 lines of the copy", String(removed));
      await ed.page.keyboard.press("Enter");
      await ed.settle();
      check(read(project, "src/hud.ts") === before, "delete restores the original file", changed(before, read(project, "src/hud.ts")));
    },
  },
  {
    name: "basic: parent and draw order",
    fixture: "basic",
    async run(ed, project) {
      const before = read(project, "src/hud.ts");
      await ed.reveal("hint", "side");
      check(await ed.dragRow("hint", "side", "into"), "drag hint into side");
      check((await ed.selected())?.parent === "side" || (await ed.select("hint") && (await ed.selected()).parent === "side"), "hint is now in side");
      await ed.reveal("panel", "title");
      check(await ed.dragRow("panel", "title", "after"), "drag panel after title");
      const review = await ed.save();
      check(review.messages.length === 0, "no warnings in review", review.messages.join(" | "));
      const after = read(project, "src/hud.ts");
      check(has(after, "side.addChild(hint);") && !has(after, "hud.addChild(hint);"), "hint is added to side", changed(before, after));
      check(after.indexOf("hud.addChild(panel);") > after.indexOf("hud.addChild(title);"), "panel is added after title", changed(before, after));
      check(has(after, /hint\.position\.set\(-480, 12\)/), "hint keeps its place on screen", changed(before, after));
    },
  },
  {
    name: "factory: texture constant, children list, prettier",
    fixture: "factory",
    async run(ed, project) {
      const before = read(project, "src/main.ts");
      check(await ed.select("COIN"), "select the coin sprite (no variable)");
      await ed.page.click(".asset-row button");
      await ed.page.waitForSelector("#texture-modal:not(.hidden)");
      await ed.page.fill("#texture-search", "gem");
      await ed.page.click("#texture-grid .texture >> nth=0");
      await ed.page.waitForTimeout(200);
      await ed.reveal("gem", "tray");
      check(await ed.dragRow("gem", "tray", "into"), "drag gem into tray");
      const review = await ed.save();
      check(review.messages.length === 0, "no warnings in review", review.messages.join(" | "));
      const after = read(project, "src/main.ts");
      check(has(after, "createSprite({ texture: TEX.GEM, parent: board"), "texture saved as TEX.GEM", changed(before, after));
      check(has(after, "children: [board, tray]") && has(after, "tray.addChild(gem);"), "gem moved out of the children list into tray", changed(before, after));
      const prettier = await import("prettier");
      const file = path.join(project, "src/main.ts");
      const cfg = (await prettier.resolveConfig(file)) || {};
      check(await prettier.check(after, { ...cfg, filepath: file }), "file is still Prettier-clean");
    },
  },
  {
    name: "basic: project explorer and resizable panels",
    fixture: "basic",
    async run(ed) {
      const page = ed.page;
      const names = () => page.$$eval("#files .file .fname", (r) => r.map((x) => x.textContent));
      await page.waitForFunction(() => document.querySelectorAll("#files .file").length > 0, null, { timeout: 10000 });
      const root = await names();
      check(["src", "index.html", "package.json"].every((n) => root.includes(n)), "explorer lists the project root", root.join(", "));
      await page.click('#files .file[data-path="src"]');
      await page.waitForSelector('#files .file[data-path="src/hud.ts"]');
      check(true, "opening src shows its files");
      await ed.select("title");
      await page.waitForSelector('#files .file.linked[data-path="src/hud.ts"]', { timeout: 5000 }).catch(() => {});
      check(await page.$('#files .file.linked[data-path="src/hud.ts"]'), "the selected object's file is marked");
      await page.click('#files .file[data-path="src/hud.ts"]');
      await page.waitForSelector(".file-view .code-line", { timeout: 5000 }).catch(() => {});
      check(await page.$(".file-view .code-line"), "clicking a file shows it in the inspector");
      await page.fill("#files-search", "main");
      await page.waitForTimeout(500);
      check((await names()).join() === "main.ts", "file search", (await names()).join());
      await page.fill("#files-search", "");
      await page.dispatchEvent("#files-search", "input");

      // Resize the left column and the files panel, then reload: sizes are kept.
      const width = () => page.$eval("#left-side", (e) => Math.round(e.getBoundingClientRect().width));
      const w0 = await width();
      const sp = await page.$eval('.splitter[data-split="left"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 2, y: r.top + 200 }; });
      await page.mouse.move(sp.x, sp.y);
      await page.mouse.down();
      await page.mouse.move(sp.x + 80, sp.y, { steps: 5 });
      await page.mouse.up();
      check((await width()) === w0 + 80, "dragging the splitter widens the left column", `${w0} -> ${await width()}`);
      const ip = await page.$eval('.splitter[data-split="right"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + 2, y: r.top + 200 }; });
      const iw = () => page.$eval("#inspector-panel", (e) => Math.round(e.getBoundingClientRect().width));
      const i0 = await iw();
      await page.mouse.move(ip.x, ip.y);
      await page.mouse.down();
      await page.mouse.move(ip.x - 60, ip.y, { steps: 5 });
      await page.mouse.up();
      check((await iw()) === i0 + 60, "dragging the other splitter widens the inspector", `${i0} -> ${await iw()}`);
      await page.click("#files-toggle");
      check(await page.$eval("#files-panel", (e) => e.classList.contains("collapsed")), "the files panel collapses");
      await page.reload();
      await page.waitForFunction(() => /^Connected to/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
      check((await width()) === w0 + 80 && (await iw()) === i0 + 60, "sizes are kept after reloading");
      check(await page.$eval("#files-panel", (e) => e.classList.contains("collapsed")), "collapsed state is kept");
      await page.click("#files-toggle");
    },
  },
  {
    name: "factory: file previews and mute",
    fixture: "factory",
    async run(ed) {
      const page = ed.page;
      const open = async (p) => {
        await page.evaluate(async (p) => {
          const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
          const list = (await (await fetch(`/__pixi-editor/api/files?dir=${encodeURIComponent(dir)}`)).json()).entries;
          const e = list.find((x) => x.path === p);
          window.pixiEditor.openFile(p, e ? e.size : 0);
        }, p);
        await page.waitForTimeout(800);
      };
      await open("src/main.ts");
      check((await page.$$eval(".code-line", (l) => l.length)) >= 15, "code preview shows the lines");
      check((await page.$$eval(".tk-kw", (l) => l.map((x) => x.textContent))).includes("const"), "code preview highlights keywords");
      await open("public/coin.png");
      await page.waitForFunction(() => /×/.test(document.querySelector(".file-view").textContent), null, { timeout: 5000 }).catch(() => {});
      check(/48 × 48 px/.test(await page.textContent(".file-view")), "image preview shows the size");
      await open("public/coin.wav");
      await page.waitForFunction(() => / s$/.test(document.querySelector(".audio-player .note")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
      check(/Mono · 0.40 s/.test(await page.textContent(".audio-player .note")), "audio preview decodes the sound", await page.textContent(".audio-player .note"));
      await ed.select("gem");
      check(await page.$("input.obj-name"), "selecting an object brings the inspector back");

      const muted = () => page.evaluate(() => document.querySelector("#game").contentWindow.__PIXI_EDITOR__.isMuted());
      check(!(await muted()), "game starts with sound");
      await page.click("#btn-mute");
      check(await muted(), "mute button mutes the game");
      await page.reload();
      await page.waitForFunction(() => /^Connected to/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
      check(await muted(), "the game stays muted after reloading");
      await page.click("#btn-mute");
      check(!(await muted()), "and can be unmuted");
    },
  },
];

// ---------------------------------------------------------------- main
const browser = await launchBrowser();
fs.mkdirSync(TMP, { recursive: true });
for (const sc of scenarios) {
  if (filter && !sc.name.includes(filter)) continue;
  console.log(`\n  ${sc.name}`);
  current = { name: sc.name, checks: [] };
  results.push(current);
  const project = freshCopy(sc.fixture);
  const editor = await startEditor(project);
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  try {
    const ed = editorPage(page);
    await ed.open(editor.url);
    await sc.run(ed, project);
  } catch (err) {
    check(false, "scenario finished", err.stack || err);
    console.log(editor.log().split("\n").slice(-15).join("\n"));
  } finally {
    await page.close();
    await editor.stop();
  }
}
await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.name}: ${c.what}`));
const total = results.reduce((n, r) => n + r.checks.length, 0);
console.log(failed.length ? `\n  ${failed.length} of ${total} checks failed:\n    ${failed.join("\n    ")}\n` : `\n  OK — ${total} checks passed\n`);
process.exit(failed.length ? 1 : 0);
