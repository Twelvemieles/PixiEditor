// Some team projects ship their styles inside the JS bundle: the host loads only the script and
// never links a stylesheet, so each CSS file is imported as a string (?inline) and the lot is
// concatenated into one hand-built <style> at startup. That element carries no Vite dev id or href,
// and holds rules from several files at once, so the editor has to resolve each rule to its own
// source .css file by the rules it contains.
import themeText from "./inline-theme.css?inline";
import badgeText from "./inline-badge.css?inline";

export function injectInlineTheme(): void {
  const style = document.createElement("style");
  style.id = "inline-theme";
  style.textContent = `${themeText}\n${badgeText}`;
  document.head.appendChild(style);
}
