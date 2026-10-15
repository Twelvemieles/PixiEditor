#!/usr/bin/env node
// Usage: pixi-editor [project-folder] [--port 5180] [--no-open]
// The project folder is optional: you can pick or switch projects inside the editor.
import { startEditor } from "../src/server.js";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 5180;
const open = !args.includes("--no-open");
const project = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") || null;

startEditor({ port, project, open }).catch((err) => {
  console.error(err.code === "EADDRINUSE" ? `Port ${port} is already in use. Try --port ${port + 1}.` : err);
  process.exit(1);
});
