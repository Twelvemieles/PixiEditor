# Pixi Editor — project rules

- **Everything in this program is in English**: source code, identifiers, comments, UI text,
  status/error messages, README and docs. Never add Spanish (or any other language) to the codebase.
- Target users: a team that writes PixiJS v8 + Vite projects **code-only**. The editor must open
  their projects without requiring any change to them, and saving must rewrite their source
  (adjust numbers in place; insert a line right after the object's creation when no line exists).
- Projects are chosen inside the app: the top-bar search bar (recent projects + typed path) and the
  Browse button, which opens the OS native folder dialog (`src/server.js → pickFolder`).
- Keep the editor UI dependency-free (plain HTML/CSS/JS in `editor/`) and runtime deps pure JS.
- Run `npm test` after changing `src/instrument.js` or `src/writeback.js`, and `npm run e2e` after
  changing the editor UI, the plugin or the server. Add a scenario to `test/e2e/run.js` for new
  features (fixtures in `test/fixtures`: `basic` = plain code, `factory` = helper functions).
- Git is Diego's job: change files only, never commit or push.
- Components live in `templates/pixi-components.ts` (copied into projects on first use). It must pass
  the team's strict `tsc` and ESLint + Prettier config; run Prettier on it after edits.
- Always shut down cleanly: closing the project's Vite frees the HMR port (`src/server.js → shutdown`).
- Must work with code written in different styles: plain `new X()`, TypeScript casts
  (`new Application() as GameApp`), and factory helpers (`createSprite({ position: [x, y] })`,
  names matching `create|make|build…`). Test changes against a factory-style project too.
- Never reformat code the team didn't format: Prettier runs on a saved file only if it was already
  Prettier-clean.

- Vite 6+ calls `hotUpdate` once per environment (client, ssr…) and may re-transform a file the
  editor wrote without reloading the page: never consume a self-write on the first check, and keep
  the old code-site ids valid when the file still has the editor's contents (`register`).
- Whole-object code changes (delete, duplicate, draw order) live in `src/refactor.js` (pure, tested
  in `test/run.js`). They refuse instead of guessing when other code depends on the object.
- Saving goes through the Review dialog (`/api/preview` = dry-run save). Keep dry runs free of side
  effects on the code-site registry.
