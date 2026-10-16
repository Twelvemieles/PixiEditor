import { Application, Container, Graphics, Sprite, Text } from "pixi.js";

/** The first screen of the game. Open the project in Pixi Editor to lay it out visually. */
export function createScene(app: Application): Container {
  const scene = new Container();
  scene.position.set(app.screen.width / 2, app.screen.height / 2);
  app.stage.addChild(scene);

  const card = new Graphics().roundRect(-200, -130, 400, 260, 18).fill(0x1d2733);
  scene.addChild(card);

  const star = Sprite.from("star");
  star.anchor.set(0.5);
  star.position.set(0, -40);
  scene.addChild(star);

  const title = new Text({
    text: "Hello Pixi!",
    style: { fill: 0xffffff, fontFamily: "Arial", fontSize: 36, fontWeight: "bold" },
  });
  title.anchor.set(0.5);
  title.position.set(0, 50);
  scene.addChild(title);

  const hint = new Text({
    text: "Edit src/scene.ts or open this project in Pixi Editor",
    style: { fill: 0x8a99ab, fontFamily: "Arial", fontSize: 14 },
  });
  hint.anchor.set(0.5);
  hint.position.set(0, 95);
  scene.addChild(hint);

  app.ticker.add((ticker) => {
    star.rotation += 0.01 * ticker.deltaTime;
  });

  return scene;
}
