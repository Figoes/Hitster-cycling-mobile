// Theme registry — bundles the game's separate card pools (wielrennen /
// ajax / algemene kennis) and the shared chip icon/style lookup for their
// "cat" fields, so app.js never has to know theme-specific detail.

import { MOMENTEN as MOMENTEN_WIELRENNEN } from "./cards.js";
import { MOMENTEN_ALGEMEEN } from "./cards-algemeen.js";

// cards-ajax.js is generated separately and may not have landed yet — load
// it dynamically so a missing file doesn't break the whole app; the theme
// just won't be offered until it exists (see the filter below).
let MOMENTEN_AJAX = {};
try {
  ({ MOMENTEN_AJAX } = await import("./cards-ajax.js"));
} catch (e) {
  console.warn("[themes] cards-ajax.js not available yet:", e.message);
}

const RAW_THEMES = {
  wielrennen: { label: "Wielrennen",       emoji: "🚴", cards: MOMENTEN_WIELRENNEN },
  ajax:       { label: "Ajax 1995–2026",   emoji: "⚽", cards: MOMENTEN_AJAX },
  algemeen:   { label: "Algemene kennis",  emoji: "🧠", cards: MOMENTEN_ALGEMEEN },
};

// Only offer themes that actually have cards — keeps a not-yet-generated
// set from appearing as a selectable, unplayable option.
export const THEMES = Object.fromEntries(
  Object.entries(RAW_THEMES).filter(([, t]) => Object.keys(t.cards).length > 0)
);

export const DEFAULT_THEME = "wielrennen";

// Every "cat" value used across all themes maps to a chip icon + optional
// hc-chip modifier class. Unknown categories fall back to a neutral chip.
const CATEGORY_STYLES = {
  "Grote Ronde":         { icon: "🚴", cls: "" },
  "Klassiek":            { icon: "◆",  cls: "hc-chip--classic" },
  "Memorabel":           { icon: "⚡", cls: "hc-chip--memo" },
  "Wereldkampioenschap": { icon: "🏆", cls: "hc-chip--epic" },

  "Landstitel":          { icon: "🏆", cls: "hc-chip--epic" },
  "Europa":              { icon: "⭐", cls: "hc-chip--classic" },
  "Beker":               { icon: "🏅", cls: "hc-chip--memo" },
  "Icoon":               { icon: "⚡", cls: "" },

  "Wetenschap":          { icon: "🔬", cls: "hc-chip--classic" },
  "Geschiedenis":        { icon: "📜", cls: "hc-chip--epic" },
  "Cultuur":             { icon: "🎭", cls: "hc-chip--memo" },
  "Sport":               { icon: "🏅", cls: "" },
};

export function chipStyle(cat) {
  return CATEGORY_STYLES[cat] || { icon: "•", cls: "" };
}
