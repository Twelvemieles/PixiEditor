import "./style.css";
import { Application } from "pixi.js";
import { createUi } from "./ui";
import { injectInlineTheme } from "./inject";

injectInlineTheme();

const app = new Application();
await app.init({ width: 800, height: 600, background: "#203040" });
document.body.appendChild(app.canvas);

createUi(document.getElementById("app")!);
