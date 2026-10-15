# Pixi Editor

A visual editor for **existing PixiJS v8 projects** written code-only.
Open your team's project, move objects in the scene like in Unity or Cocos, and on save
**the editor rewrites the numbers in the source code**. The team keeps working in code only and
sees the changes as a regular git diff.

```ts
// Before
scoreText.position.set(22, 18);
netText.position.set(app.renderer.width - 10, 10);

// After dragging in the editor and saving
scoreText.position.set(40, 26);
netText.position.set(app.renderer.width - 24, 10);   // still anchored to the right edge
```

## Usage

```bash
cd ~/ClaudeProjects/PixiEditor
npm install                     # first time only
node bin/pixi-editor.js         # opens http://localhost:5180/__pixi-editor/
```

Pick a project inside the editor:

- **Search bar** (top bar, `Cmd/Ctrl+P`): filters recent projects as you type; paste or type a folder
  path and press Enter to open it.
- **Browse…** (`Cmd/Ctrl+O`): opens the system folder picker (Finder on macOS, the folder dialog on
  Windows, zenity/kdialog on Linux).

You can also pass a project directly: `node bin/pixi-editor.js ~/pixi/firstProject`.
Options: `--port 5200`, `--no-open`. Recent projects are stored in `~/.pixi-editor/recent.json`.

The project's own configuration is never modified: the editor runs the project's own Vite with the
editor plugin added. If the game needs a backend (e.g. the WebSocket server in `server/`), start it
as usual.

## Working in the editor

| | |
|---|---|
| **Play / Edit** | The game starts in **Play** so it can boot normally (loading screens, tweens…). Switch to **Edit** (`Cmd/Ctrl+E`) when you reach the screen you want: the game pauses and you can select objects. |
| **Select** | Click selects the top-most object. **Alt+click** cycles through the objects stacked under the pointer. Pressing inside the current selection drags it even if something is on top. |
| **Move tool (V)** | Drag to move (Shift = one axis), corner handles scale (Shift = free X/Y), the round handle above rotates (Shift = 15° steps). Arrow keys = 1 px (Shift = 10 px). |
| **Pivot tool (P)** | Drag inside the object to place its origin — `anchor` for sprites/texts, `pivot` for everything else. The object stays in place (its position is compensated). Shift snaps to corners/edges/center. |
| **Hierarchy** | The scene tree. A pink dot means the object is linked to a line of code. **Find** (`Cmd/Ctrl+F`) filters it by name or type; Enter jumps through the matches. Double-click to rename. **Drag a row onto a container** to move the object into it (it stays in the same place on screen), or onto the **top/bottom edge** of a row to draw it before/after that object. The eye hides an object while editing (e.g. a popup covering the screen) — this is never saved. |
| **Inspector** | Name (saved as the object's `label`), position, scale, rotation, alpha, pivot/anchor with a 3×3 origin grid, and **Appearance**: texture of a sprite, skeleton and animation of a spine, tint, text, text color, font, size, weight, style, alignment, letter spacing and shape fill colors. Drag a field's label to scrub the value, like in Unity. Below, the lines of code that control the object. |
| **Zoom / pan** | Mouse wheel or pinch zooms around the pointer; Space+drag or middle-drag pans. `F` fits the game, `0` resets to 100%. |
| **Screen size** | The menu next to the zoom (bottom right) gives the game a phone, tablet, laptop or custom size, to test the layout (and the Anchor component) at other resolutions. Games with a fixed canvas size keep their size. |
| **Duplicate / Delete** | `Cmd/Ctrl+D` or ⧉ copies the object's code; `Delete` or 🗑 removes it (with a preview of the lines). See [Duplicating and deleting](#duplicating-and-deleting). |
| **Create** | **+ Create** in the hierarchy: Container, Sprite (pick one of the textures the game has loaded), Text, Rectangle or Circle. See [Creating objects](#creating-objects). |
| **Components** | "Add component…" in the inspector: **Anchor**, **Button**, **Tween**, or your own **behaviors** (see below). |
| **Code** | Every line that controls the selected object is listed in the inspector; **Open ↗** (or double-click) opens it in VS Code at that line. |
| **Save** | `Cmd/Ctrl+S` opens **Review changes**: every change (with **Discard**) and the exact lines that will change in each file. Enter saves. Untick "Review before saving" to save directly. Undo `Cmd/Ctrl+Z`, redo `Cmd/Ctrl+Shift+Z`. |
| **Quit** | The **Quit** button stops the editor process cleanly (closes the project's Vite and frees the ports). Ctrl+C in the terminal does the same. If an old editor is still running on the port, a new launch closes it first. |

## Creating objects

Select a container (or any object inside it) and use **+ Create** in the hierarchy. The new object
appears in the middle of the view, selected, and its code is written right away, in the same function
that builds the container, after the last line that sets it up (never inside event handlers or
update functions, and before any `return`):

```ts
import { Container, Graphics, Text, Sprite } from "pixi.js"; // import extended when needed
// …
leaderboard.position.set(0, 100);
const coin = Sprite.from("coin");
coin.anchor.set(0.5);
coin.position.set(480, 172);
leaderboard.addChild(coin);
```

From then on it is a normal object: move, rename, recolor or add components to it and save as usual.
The container must be stored in a variable in the code. Variable names never clash with existing
ones (`label`, `label2`…), and the project's quote style and Prettier formatting are respected.

## Text style and spine animation

Texts show **Font, Size, Weight, Style, Align and Spacing**. They are saved where the code defines
them — `style: { fontSize: 24 }` → `30`, `createText({ fontSize: 40 })` → `46` — or, for an object
with a variable and no such line, as `scoreText.style.align = "center";` after its creation. A style
shared through a variable (`style: titleStyle`) is not changed from one object.

Spines show an **Animation** menu with the skeleton's animations; the chosen one plays in a loop while
you edit. On save, the animation name is written where the code chooses it:
`spine.state.setAnimation(0, "idle", true)` or `createSpineAnimation({ animationName: "idle" })`.

## Duplicating and deleting

**Duplicate** (`Cmd/Ctrl+D`) copies the object's code right after the original — its declaration and
the lines next to it that set it up — with a new variable name, and adds the copy wherever the
original is listed:

```ts
const coin = Sprite.from("coin");        const coin2 = Sprite.from("coin");
coin.anchor.set(0.5);              ->     coin2.anchor.set(0.5);
hud.addChild(coin);                       hud.addChild(coin2);
createContainer({ children: [coin] })     createContainer({ children: [coin, coin2] })
```

The copy appears on top of the original, selected, ready to be dragged. Save the original's changes
first. Containers whose children are added in the code are not duplicated (duplicate the children).

**Delete** (`Delete` key) shows the lines that will be removed and asks first. It removes the
declaration, every line that uses the object as its subject (`coin.x = …`, `coin.on(…)`,
`hud.addChild(coin)`, `addComponent(coin, …)`), its entry in `children: [...]` lists, and imports that
become unused. If other code still needs the object (`return { coin }`, `if (coin.visible)`,
`foo(coin)`), nothing is deleted and the editor shows those lines.

## Draw order

Drag an object onto the top or bottom edge of another one in the hierarchy. On save, the line that
adds it moves (`hud.addChild(a)` after `hud.addChild(b)`, or `children: [b, a]`). When that line
can't move because it would use a variable before it's declared, the neighbour's line moves
instead; if neither works, the editor says why and puts the order back.

## Lines inside pointer handlers

Lines inside hover/press handlers (`events: { pointerover: … }`, `obj.on("pointerdown", …)`) are
marked **on pointer** in the inspector. They never replace the object's setup line: dragging a button
after hovering it in Play mode still changes its normal position and texture, not the hover state.

## Changing the parent, the texture or the spine

**Parent.** Drag an object in the hierarchy onto another container. On save, the line that adds it is
changed, and its position is adjusted so it stays where it was:

```ts
ui.addChild(hintText);                          ->  leaderboard.addChild(hintText);
createSprite({ parent: balanceGroup, … })       ->  createSprite({ parent: hudGroup, … })
createContainer({ children: [a, b] })           ->  createContainer({ children: [a] });
                                                    group.addChild(b);
```

The new parent must be stored in a variable that exists where the object is added (same function,
declared before). Otherwise the editor says so and moves the object back.

**Texture.** Select a sprite → Appearance → Texture → **Change…** and pick one of the textures the
game has loaded. The code keeps its style: `"coin.png"` → `"gem.png"`, `Texture.from("coin")` →
`Texture.from("gem")`, and when the project uses constants, `TEX.HUD.COIN` → `TEX.HUD.GEM` (the
editor finds the constant whose value is that texture's key).

**Spine.** Select a spine → Appearance → Spine → **Change…** and pick a loaded skeleton (paired with
the atlas of the same name). The preview plays the same animation if the new skeleton has it, and
warns you if it doesn't (the code that plays it will need another name). On save,
`SPINES.JP_BAR.SKEL` / `SPINES.JP_BAR.ATLAS` become `SPINES.DRACULA.SKEL` / `SPINES.DRACULA.ATLAS`,
and the game reloads by itself to run with it. A spine chosen by an expression
(`SPINES[options.key].SKEL`) can't be changed from the editor — the inspector says so.

## Components

Components add reusable behaviour to any object, from the inspector:

| Component | What it does | Params |
|---|---|---|
| **Anchor** | Keeps the object at a fixed offset from a screen edge or corner (follows screen resizes). Dragging an anchored object edits its offset. | `h` left/center/right, `v` top/middle/bottom, `x`, `y` |
| **Button** | Pointer cursor plus hover/press scale feedback. Handle clicks in code: `obj.on("pointertap", …)`. | `hoverScale`, `pressScale`, `cursor` |
| **Tween** | Looping idle animation on top of the object's values (paused in Edit mode). | `kind` pulse/float/spin/fade, `amount`, `speed` |

On save, components are written as plain code right after the object is created, and the import is
kept in sync:

```ts
import { addComponent, Anchor } from "../pixi-components";
// …
addComponent(netText, Anchor, { h: "right", v: "top", x: -30, y: 10 });
```

The first time a component is saved, the editor adds `src/pixi-components.ts` to the project (strict
TypeScript, readable, safe to edit and commit) and, for Anchor, a `useApp(app);` line after the
Application is created. Removing a component deletes its line (and the import name when unused).

## Behaviors (your own code per object)

"Add component… → New behavior…" creates a class for the selected object and opens it in VS Code:

```ts
// src/behaviors/CoinSpinner.ts
export class CoinSpinner extends Component {
  static readonly componentName = "CoinSpinner";
  static readonly defaults = {};

  attach(): void {
    this.target.eventMode = "static";
    this.target.on("pointertap", () => this.target.scale.set(1.2));
  }

  update(): void {
    if (isEditorPaused()) return; // stay still while the editor is in Edit mode
    this.target.rotation += 0.02;
  }
}
```

It is attached in the code right away (`addComponent(coin, CoinSpinner, {});` plus imports), so
it keeps working when the game reloads after you save the behavior in VS Code. Existing behaviors
appear in the same menu and can be attached to other objects. `this.target` is the object.
Behaviors need the object to be stored in a variable in the code.

To use another editor instead of VS Code, start Pixi Editor with `PIXI_EDITOR_IDE=cursor`.

## Projects that build objects with helper functions

Many projects create objects through helpers instead of `new Sprite()`:

```ts
createSprite({ texture: TEX.BACKGROUND, parent: balanceGroup, anchor: 0.5, position: [178, -25] });
```

Calls to functions named `create…`, `make…` or `build…` are treated as the object's creation: the
editor names the object after its `label`, text or texture (`BACKGROUND`), and edits the values in
the call's options object (`position: [178 + 20, -25]`). A property the call doesn't have yet is
added to its options when that helper is used with that key elsewhere in the project; otherwise the
call is wrapped so the value still lives next to the object:

```ts
Object.assign(createText({ text: i18n.t('common.balance'), … }), { label: 'Balance title' });
```

## How saving works

1. While the game runs inside the editor, its code is instrumented in memory (never on disk) to record
   which line set each property of each object: `x.position.set(...)`, `x.x = ...`, `x.scale.set(...)`,
   `x.rotation = ...`, `x.alpha = ...`, and the `const x = new Graphics()` line that created it.
2. On save, only the number on that line is adjusted, keeping the expression:
   `22` → `40`, `app.renderer.width - 10` → `app.renderer.width - 24`, `44 + i * 22` → `54 + i * 22`,
   `someVar` → `someVar + 5`.
3. If the property had no line (e.g. a `Graphics` that was never positioned), one is inserted right
   after its creation: `hudBg.position.set(11, 6);`.
4. Text, names and colors replace the literal in the code (`text: "Score: 0"` → `text: "Points: 0"`,
   `.fill(0x000000)` → `.fill(0x223344)`, `fill: '#fff'` keeps its string style). If the value is
   computed by code (`i18n.t(...)`, `` `Score: ${n}` ``), it is not overwritten: the editor says so
   and reverts the preview.
5. If a file was already formatted with the project's Prettier, it is formatted again after saving,
   so `npm run lint` keeps passing. Files that weren't formatted are left alone.

### Current limitations

- A line inside a loop or a function called several times affects **every** object it creates.
  The inspector warns about it ("This line affects N objects").
- Objects without their own variable (e.g. `world.addChild(new Sprite())`) or created inside libraries
  can be moved to try things out, but cannot be saved.
- If the code sets a position every frame or on every network message, the object may snap back while
  you edit. Saved changes still apply.
- The project must use **Vite** and create the app with `new Application()` (anywhere — also
  `new Application() as GameApp` or returned from a function).
- Shape fill colors can be edited when the shape is drawn in the same expression that creates it
  (`new Graphics().rect(…).fill(0xff0000)`).
- Different X/Y scale cannot be saved onto `obj.scale = 2` (it can onto `obj.scale.set(2)`).

## Layout

```
bin/pixi-editor.js   CLI
src/server.js        Editor server: UI, project picker, hosts the project's Vite (same origin)
src/plugin.js        Vite plugin: instruments code, injects the runtime, saves changes
src/instrument.js    Parses code (Babel) and marks the code site of each property
src/writeback.js     Computes text edits ("adjust only the number")
src/runtime.js       Injected into the game: links objects to lines of code
src/refactor.js      Deleting, duplicating and reordering an object's code
templates/           pixi-components.ts (copied into projects that use components) and behavior.ts
editor/              UI (dependency-free HTML/CSS/JS)
test/run.js          npm test (unit tests: instrumenting and rewriting code)
test/e2e/run.js      npm run e2e (browser tests on the projects in test/fixtures)
```

## Development

```bash
npm install                      # also installs vite, pixi.js, prettier and playwright for the tests
npx playwright install chromium  # once per machine, for the browser tests
npm test                         # unit tests (a second)
npm run e2e                      # browser tests (~30 s)
```

`npm run e2e` copies the two fixture projects in `test/fixtures` (`basic`: plain `new X()` code;
`factory`: `createSprite({...})` helpers, `TEX` constants, Prettier with single quotes) to
`test/.tmp`, starts Pixi Editor on each one, drives it in Chromium and checks the code it writes:
search, moving, text style, creating, the review dialog, duplicate and delete, parent and draw order,
textures, and that Prettier-clean files stay clean. `npm run e2e -- factory` runs only the scenarios
whose name contains "factory"; `HEADED=1 npm run e2e` shows the browser.

## Next steps

- Multi-selection and alignment tools.
- More components (e.g. layout with `@pixi/layout`, sprite animation, sound on click).
- Stroke and drop shadow for texts.
