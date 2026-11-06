// HTML on top of the canvas: a small menu built with the DOM, like many games' name/login screens.
export function createMenu(): HTMLDivElement {
  const menu = document.createElement("div");
  menu.style.position = "fixed";
  menu.style.right = "16px";
  menu.style.top = "16px";
  menu.style.padding = "8px";
  menu.style.background = "#0b1220";

  const playBtn = document.createElement("button");
  playBtn.textContent = "Play";
  menu.appendChild(playBtn);
  return menu;
}
