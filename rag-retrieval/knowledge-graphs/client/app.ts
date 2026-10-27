// The page: plain-language sections (static), the walkthrough (autoplays on one
// clock), the results, and an "Ask your own question" panel that works when the
// app runs locally with Neo4j and a Gemini key. Review hooks: ?only=<section id>
// shows one section; ?scene, ?t, ?speed and ?play drive the walkthrough.

import { renderAskPanel, renderLoses, renderPayoff, renderProblem, renderProduction, renderRoles } from "./sections.ts";
import { initWalkthrough } from "./walkthrough.ts";

const root = document.documentElement;
const $ = (id: string) => document.getElementById(id)!;

function renderThemeLabel() {
  $("theme").textContent = root.dataset.theme === "dark" ? "Light" : "Dark";
}
$("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("kg-theme", root.dataset.theme);
  } catch {
    // Storage may be unavailable; the theme still applies for this visit.
  }
  renderThemeLabel();
});

renderProblem();
renderPayoff();
renderAskPanel();
renderLoses();
renderRoles();
renderProduction();
renderThemeLabel();
initWalkthrough();

const params = new URLSearchParams(location.search);
const only = params.get("only") ?? (params.has("solo") && params.has("scene") ? "theatre" : null);
if (only && document.getElementById(only)) for (const sec of document.querySelectorAll("main > section")) (sec as HTMLElement).hidden = sec.id !== only;
else if (params.has("scene")) {
  root.style.scrollBehavior = "auto";
  $("theatre").scrollIntoView();
  root.style.scrollBehavior = "";
}
