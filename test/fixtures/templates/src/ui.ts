// Like many team projects: the whole UI is one template assigned to innerHTML, styled by classes.
export function createUi(mount: HTMLElement): void {
  const label = "Play";
  mount.innerHTML = `
    <section class="panel" id="panel">
      <h2 class="title">Settings</h2>
      <button class="cta" id="play" title="Start">${label}</button>
      <p class="hint">Press start</p>
      <ul class="list">${[1, 2].map((n) => `<li class="item" data-n="${n}">Item ${n}</li>`).join("")}</ul>
    </section>`;
}
