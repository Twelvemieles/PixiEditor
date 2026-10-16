import { Application, Assets } from "pixi.js";
import { createScene } from "./scene";

const app = new Application();
await app.init({ background: "#101418", resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

await Assets.load({ alias: "star", src: "/assets/star.png" });

createScene(app);
