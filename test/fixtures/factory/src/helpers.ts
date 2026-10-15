import { Container, Sprite, Texture } from 'pixi.js';

// Factory style, like many team projects: createX({ ...options }).
interface DisplayOptions {
  parent?: Container;
  position?: [number, number];
  anchor?: number;
  children?: Container[];
}

function apply<T extends Container>(obj: T, options: DisplayOptions): T {
  if (options.position) obj.position.set(options.position[0], options.position[1]);
  if (options.children) options.children.forEach((child) => obj.addChild(child));
  if (options.parent) options.parent.addChild(obj);
  return obj;
}

export function createSprite(options: DisplayOptions & { texture: string }): Sprite {
  const sprite = new Sprite(Texture.from(options.texture));
  if (options.anchor !== undefined) sprite.anchor.set(options.anchor);
  return apply(sprite, options);
}

export function createContainer(options: DisplayOptions): Container {
  return apply(new Container(), options);
}
