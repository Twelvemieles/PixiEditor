#!/usr/bin/env node
// Renders scripts/app-icon.svg into the macOS app icon (PixiEditor.app/Contents/Resources/AppIcon.icns)
// and the editor's favicon (editor/favicon.svg). Run after changing the SVG:
//   npm run build:icon
// Needs the Playwright Chromium used by the e2e suite (npx playwright install chromium).
// The .icns is assembled here (PNG-encoded entries), so it also works off macOS (no iconutil).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG = fs.readFileSync(path.join(ROOT, "scripts/app-icon.svg"), "utf8");
const ICNS = path.join(ROOT, "PixiEditor.app/Contents/Resources/AppIcon.icns");

// ICNS entry types that hold PNG data, by pixel size (the @2x types reuse the bigger renders).
const ENTRIES = [
  ["icp4", 16], ["ic11", 32], ["icp5", 32], ["ic12", 64], ["icp6", 64],
  ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024],
];

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    for (const p of ["/opt/pw-browsers/chromium", process.env.CHROMIUM_PATH].filter(Boolean)) {
      if (fs.existsSync(p)) return chromium.launch({ executablePath: p });
    }
    throw new Error(`${err.message}\n\nInstall the browser once with: npx playwright install chromium`);
  }
}

const browser = await launchBrowser();
const pngs = new Map();
try {
  for (const size of new Set(ENTRIES.map(([, s]) => s))) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const svg = SVG.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    pngs.set(size, await page.screenshot({ omitBackground: true }));
    await page.close();
  }
} finally {
  await browser.close();
}

const chunks = ENTRIES.map(([type, size]) => {
  const data = pngs.get(size);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(body.length + 8, 4);
fs.mkdirSync(path.dirname(ICNS), { recursive: true });
fs.writeFileSync(ICNS, Buffer.concat([header, body]));
fs.writeFileSync(path.join(ROOT, "editor/favicon.svg"), SVG);
console.log(`Wrote ${path.relative(ROOT, ICNS)} (${Math.round((body.length + 8) / 1024)} KB) and editor/favicon.svg`);
