// Theme registry — bundles the game's separate card pools (wielrennen /
// ajax / algemene kennis) and the shared chip icon/style lookup for their
// "cat" fields, so app.js never has to know theme-specific detail.

import { MOMENTEN as MOMENTEN_WIELRENNEN } from "./cards.js";
import { MOMENTEN_AJAX } from "./cards-ajax.js";
import { MOMENTEN_ALGEMEEN } from "./cards-algemeen.js";

export const THEMES = {
  wielrennen: { label: "Wielrennen",       emoji: "🚴", cards: MOMENTEN_WIELRENNEN },
  ajax:       { label: "Ajax 1995–2026",   emoji: "⚽", cards: MOMENTEN_AJAX },
  algemeen:   { label: "Algemene kennis",  emoji: "🧠", cards: MOMENTEN_ALGEMEEN },
};

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
