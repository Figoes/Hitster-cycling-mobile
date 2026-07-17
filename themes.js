// Theme registry — bundles the game's separate card pools (wielrennen /
// ajax / algemene kennis) and the shared chip icon/style lookup for their
// "cat" fields, so app.js never has to know theme-specific detail.

import { MOMENTEN as MOMENTEN_WIELRENNEN } from "./cards.js";

// cards-ajax.js and cards-algemeen.js are generated separately and may not
// have landed yet — load them dynamically so a missing file doesn't break
// the whole app; each theme just won't be offered until its file exists
// (see the filter below).
async function loadCards(path, exportName) {
  try {
    const mod = await import(path);
    return mod[exportName] || {};
  } catch (e) {
    console.warn(`[themes] ${path} not available yet:`, e.message);
    return {};
  }
}
const MOMENTEN_AJAX = await loadCards("./cards-ajax.js", "MOMENTEN_AJAX");
const MOMENTEN_ALGEMEEN = await loadCards("./cards-algemeen.js", "MOMENTEN_ALGEMEEN");

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
