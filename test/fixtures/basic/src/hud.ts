import { Container, Graphics, Text } from "pixi.js";

// Plain style: `new X()`, variables, addChild().
export function createHud(): Container {
  const hud = new Container();

  const side = new Container();
  side.position.set(500, 40);

  const panel = new Graphics().roundRect(0, 0, 200, 80, 8).fill(0x000000);
  panel.alpha = 0.5;
  hud.addChild(panel);

  const title = new Text({ text: "Score: 0", style: { fill: 0xffffff, fontSize: 24 } });
  title.position.set(20, 20);
  hud.addChild(title);

  const hint = new Text({ text: "Press start", style: { fill: 0xdddddd, fontSize: 14 } });
  hint.position.set(20, 52);
  hud.addChild(hint);

  hud.addChild(side);
  return hud;
}
