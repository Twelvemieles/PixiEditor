import { Application } from "pixi.js";
import { createHud } from "./hud";
import { createMenu } from "./menu";

const app = new Application();
await app.init({ width: 800, height: 600, background: "#203040" });
document.body.appendChild(app.canvas);

app.stage.addChild(createHud());
document.body.appendChild(createMenu());
