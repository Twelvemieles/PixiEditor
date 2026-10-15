import { Application, Assets } from 'pixi.js';
import { TEX } from './assets';
import { createContainer, createSprite } from './helpers';

const app = new Application();
await app.init({ width: 800, height: 600, background: '#302040' });
document.body.appendChild(app.canvas);
await Assets.load([
  { alias: TEX.COIN, src: '/coin.png' },
  { alias: TEX.GEM, src: '/gem.png' },
]);

const board = createContainer({ position: [100, 100] });
createSprite({ texture: TEX.COIN, parent: board, position: [50, 50], anchor: 0.5 });
const gem = createSprite({ texture: TEX.GEM, position: [300, 150], anchor: 0.5 });
const tray = createContainer({ position: [400, 300] });
createContainer({ children: [board, tray, gem], parent: app.stage });
