// Hitster Cycling v3 — multiplayer game logic + Firebase wiring.
// Firebase modular SDK loaded from gstatic CDN.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getDatabase, ref, set, get, update, onValue, off, runTransaction
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

import { MOMENTEN } from "./cards.js";
import { firebaseConfig } from "./firebase-config.js";

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────
const SCORE_TO_WIN = 5;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const CODE_LENGTH = 4;
const CARD_IDS = Object.keys(MOMENTEN);

// ───────────────────────────────────────────────────────────────────────────
// Firebase init
// ───────────────────────────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ───────────────────────────────────────────────────────────────────────────
// Local state
// ───────────────────────────────────────────────────────────────────────────
const state = {
  me: { id: null, name: localStorage.getItem("hc_name") || "" },
  code: null,
  session: null,
  unsub: null,
  cardOpen: false,          // local UI state for face-down vs face-up
  localResult: null,        // { correct, year, rider } shown briefly after placing
  resultTimer: null,
  error: null,
  drawing: false,           // debounce flag for auto-draw
};

const $view = document.getElementById("view");
const $meta = document.getElementById("meta");

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────
const sessionRef = (code) => ref(db, `sessions/${code}`);
const playerRef  = (code, pid) => ref(db, `sessions/${code}/players/${pid}`);

function generateCode() {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function sortTimeline(tl) {
  // Sort by year ascending. For same year, preserve insertion order.
  return [...(tl || [])].sort((a, b) => a.year - b.year);
}

function isPlacementCorrect(timeline, year, slotIndex) {
  // timeline is the SORTED list of cards already in the player's timeline.
  // slotIndex 0..timeline.length, picks the slot between cards [i-1] and [i].
  const prev = timeline[slotIndex - 1];
  const next = timeline[slotIndex];
  const lo = prev ? prev.year : -Infinity;
  const hi = next ? next.year :  Infinity;
  return year >= lo && year <= hi;
}

function showError(msg) {
  state.error = msg;
  render();
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { state.error = null; render(); }, 2800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function chipClass(cat) {
  const k = cat.toLowerCase();
  if (k.startsWith("memorabel")) return "hc-chip hc-chip--memo";
  if (k.startsWith("klassiek")) return "hc-chip hc-chip--classic";
  if (k.startsWith("wereldkampioenschap")) return "hc-chip hc-chip--epic";
  return "hc-chip"; // grote ronde — neutral
}

function chipIcon(cat) {
  const k = cat.toLowerCase();
  if (k.startsWith("memorabel")) return "⚡";
  if (k.startsWith("klassiek")) return "◆";
  if (k.startsWith("wereldkampioenschap")) return "🏆";
  return "🚴";
}

function countCorrect(player) {
  return (player.timeline || []).filter((c) => c.correct).length;
}

const ACCENT_CYCLE = ["cyan", "yellow", "pink", "orange"];
function accentForIndex(i) { return ACCENT_CYCLE[i % ACCENT_CYCLE.length]; }
function accentForPlayerIndex(i) { return ACCENT_CYCLE[i % ACCENT_CYCLE.length]; }

function shortYearTag(year) {
  if (year >= 2000) return "#" + String(year - 2000).padStart(2, "0");
  return "#" + String(year).slice(-2);
}

// ───────────────────────────────────────────────────────────────────────────
// Auth bootstrap
// ───────────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (user) {
    state.me.id = user.uid;
    // resume session if we had one
    const savedCode = localStorage.getItem("hc_code");
    if (savedCode && !state.code) {
      tryResume(savedCode);
    } else {
      render();
    }
  }
});
signInAnonymously(auth).catch((e) => showError("Inloggen mislukt: " + e.message));

async function tryResume(code) {
  const snap = await get(sessionRef(code));
  if (!snap.exists()) {
    localStorage.removeItem("hc_code");
    render();
    return;
  }
  const sess = snap.val();
  if (sess.players && sess.players[state.me.id]) {
    subscribe(code);
  } else {
    localStorage.removeItem("hc_code");
    render();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ───────────────────────────────────────────────────────────────────────────
async function createSession(name) {
  if (!name.trim()) { showError("Vul je naam in"); return; }
  if (!state.me.id) { showError("Nog niet ingelogd, probeer opnieuw"); return; }

  // Try a few codes in case of collision (very unlikely with ~1M space)
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateCode();
    const existing = await get(sessionRef(code));
    if (existing.exists()) continue;

    const now = Date.now();
    const initialSession = {
      status: "lobby",
      hostId: state.me.id,
      createdAt: now,
      turnIndex: 0,
      players: {
        [state.me.id]: { name: name.trim(), joinedAt: now, score: 0 }
      }
    };
    try {
      await set(sessionRef(code), initialSession);
    } catch (e) {
      console.error("createSession set() failed:", e);
      showError("Aanmaken mislukt: " + (e?.code || e?.message || "onbekende fout"));
      return;
    }
    localStorage.setItem("hc_name", name.trim());
    localStorage.setItem("hc_code", code);
    state.me.name = name.trim();
    subscribe(code);
    return;
  }
  showError("Kon geen vrije code maken, probeer opnieuw");
}

async function joinSession(rawCode, name) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) { showError("Ongeldige code"); return; }
  if (!name.trim()) { showError("Vul je naam in"); return; }
  if (!state.me.id) { showError("Nog niet ingelogd, probeer opnieuw"); return; }

  const trimmedName = name.trim();

  // Read once to check existence, status, capacity. (Race-safety against another
  // joiner pushing us over MAX_PLAYERS isn't worth a transaction here — at worst
  // we end up with one extra player in a friend group game.)
  let preSnap;
  try {
    preSnap = await get(sessionRef(code));
  } catch (e) {
    console.error("[join] get failed:", e);
    showError("Lezen mislukt: " + (e?.code || e?.message || "onbekende fout"));
    return;
  }
  if (!preSnap.exists()) { showError("Spelcode niet gevonden"); return; }
  const sess = preSnap.val();
  if (sess.status !== "lobby") { showError("Spel is al begonnen"); return; }
  const players = sess.players || {};
  if (Object.keys(players).length >= MAX_PLAYERS && !players[state.me.id]) {
    showError("Spel is vol");
    return;
  }

  try {
    await set(playerRef(code, state.me.id), players[state.me.id] || {
      name: trimmedName, joinedAt: Date.now(), score: 0
    });
  } catch (e) {
    console.error("[join] set failed:", e);
    showError("Meedoen mislukt: " + (e?.code || e?.message || "onbekende fout"));
    return;
  }

  localStorage.setItem("hc_name", trimmedName);
  localStorage.setItem("hc_code", code);
  state.me.name = trimmedName;
  subscribe(code);
}

function subscribe(code) {
  if (state.unsub) state.unsub();
  state.code = code;
  const r = sessionRef(code);
  const handler = (snap) => {
    if (!snap.exists()) {
      // session was deleted
      leaveLocal();
      showError("Spel bestaat niet meer");
      return;
    }
    state.session = snap.val();
    render();
  };
  onValue(r, handler);
  state.unsub = () => off(r, "value", handler);
}

function leaveLocal() {
  if (state.unsub) state.unsub();
  state.unsub = null;
  state.code = null;
  state.session = null;
  state.cardOpen = false;
  state.localResult = null;
  localStorage.removeItem("hc_code");
  render();
}

async function leaveSession() {
  if (state.code && state.me.id) {
    // Remove self if game still in lobby. Otherwise just stop listening (avoid
    // breaking active games when someone closes the tab).
    if (state.session && state.session.status === "lobby") {
      await set(playerRef(state.code, state.me.id), null);
      // If we were the host and were last to leave, delete session.
      const snap = await get(sessionRef(state.code));
      if (snap.exists()) {
        const sess = snap.val();
        const remaining = Object.keys(sess.players || {});
        if (remaining.length === 0) await set(sessionRef(state.code), null);
      }
    }
  }
  leaveLocal();
}

async function endGame() {
  if (!state.session || !state.code) return;
  const players = state.session.players || {};
  const ranked = Object.entries(players)
    .sort(([, a], [, b]) =>
      (countCorrect(b) - countCorrect(a)) ||
      ((a.joinedAt || 0) - (b.joinedAt || 0))
    );
  const updates = { status: "ended" };
  const winnerId = ranked[0]?.[0];
  if (winnerId) updates.winnerId = winnerId;
  try {
    await update(sessionRef(state.code), updates);
  } catch (e) {
    console.error("[endGame] update failed:", e);
    showError("Afsluiten mislukt: " + (e?.code || e?.message || "onbekende fout"));
  }
}

async function closeSessionFromTopbar() {
  if (!state.session) return;
  if (state.session.status === "lobby") {
    if (!confirm("Lobby verlaten?")) return;
    await leaveSession();
  } else if (state.session.status === "playing") {
    if (!confirm("Spel afsluiten? Dit eindigt het spel voor iedereen.")) return;
    await endGame();
  } else {
    leaveLocal();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Start game: pick starter cards, randomize turn order
// ───────────────────────────────────────────────────────────────────────────
async function startGame() {
  if (!state.session) return;
  if (state.session.hostId !== state.me.id) return;
  const pids = Object.keys(state.session.players || {});
  if (pids.length < MIN_PLAYERS) { showError(`Minstens ${MIN_PLAYERS} spelers`); return; }

  // Shuffle a fresh card pool and slice the first N as anchors
  const shuffledCards = [...CARD_IDS].sort(() => Math.random() - 0.5);
  const anchors = {};
  const drawn = {};
  pids.forEach((pid, i) => {
    const cid = shuffledCards[i];
    const card = MOMENTEN[cid];
    anchors[pid] = { cardId: cid, year: card.jaar, correct: false }; // anchor doesn't count
    drawn[cid] = pid;
  });

  // Shuffle turn order
  const turnOrder = [...pids].sort(() => Math.random() - 0.5);

  const updates = {};
  updates[`status`] = "playing";
  updates[`turnOrder`] = turnOrder;
  updates[`turnIndex`] = 0;
  updates[`drawn`] = drawn;
  pids.forEach((pid) => {
    updates[`players/${pid}/timeline`] = [anchors[pid]];
    updates[`players/${pid}/score`] = 0;
    updates[`players/${pid}/currentDraw`] = null;
  });
  await update(sessionRef(state.code), updates);
}

// ───────────────────────────────────────────────────────────────────────────
// Draw: transactionally pick an undrawn card, assign to current player
// ───────────────────────────────────────────────────────────────────────────
function maybeAutoDraw() {
  if (state.drawing) return;
  if (!state.session || state.session.status !== "playing") return;
  if (state.localResult) return;
  const order = state.session.turnOrder || [];
  if (order[state.session.turnIndex] !== state.me.id) return;
  const me = state.session.players?.[state.me.id];
  if (!me || me.currentDraw) return;
  state.drawing = true;
  drawCard().finally(() => { state.drawing = false; });
}

async function drawCard() {
  if (!state.session || state.session.status !== "playing") return;
  const myTurn = state.session.turnOrder[state.session.turnIndex] === state.me.id;
  if (!myTurn) return;
  const me = state.session.players[state.me.id];
  if (me.currentDraw) return; // already have one

  let assigned = null;
  const res = await runTransaction(sessionRef(state.code), (sess) => {
    if (!sess || sess.status !== "playing") return;
    if (sess.turnOrder[sess.turnIndex] !== state.me.id) return;
    sess.players = sess.players || {};
    if (sess.players[state.me.id].currentDraw) return; // already drawn
    sess.drawn = sess.drawn || {};
    // pick a random undrawn card
    const undrawn = CARD_IDS.filter((id) => !sess.drawn[id]);
    if (undrawn.length === 0) return;
    const pick = undrawn[Math.floor(Math.random() * undrawn.length)];
    sess.drawn[pick] = state.me.id;
    sess.players[state.me.id].currentDraw = pick;
    assigned = pick;
    return sess;
  });
  if (!res.committed || !assigned) {
    showError("Kon geen kaart trekken");
    return;
  }
  state.cardOpen = false; // appears face-down per spec; player taps to reveal
}

// ───────────────────────────────────────────────────────────────────────────
// Place: validate + commit
// ───────────────────────────────────────────────────────────────────────────
async function placeCard(slotIndex) {
  if (!state.session || state.session.status !== "playing") return;
  const me = state.session.players[state.me.id];
  if (!me?.currentDraw) return;
  const myTurn = state.session.turnOrder[state.session.turnIndex] === state.me.id;
  if (!myTurn) return;

  const cardId = me.currentDraw;
  const card = MOMENTEN[cardId];
  const sortedTl = sortTimeline(me.timeline);
  const correct = isPlacementCorrect(sortedTl, card.jaar, slotIndex);

  // Build the new timeline. If correct, insert at slot; if incorrect, leave timeline unchanged.
  let newTimeline = me.timeline || [];
  let newScore = me.score || 0;
  if (correct) {
    // store unsorted; we always sort on display. We'll insert based on year.
    newTimeline = [...newTimeline, { cardId, year: card.jaar, correct: true }];
    newScore = (newScore || 0) + 1;
  }

  // Advance turn
  const order = state.session.turnOrder;
  const nextIndex = (state.session.turnIndex + 1) % order.length;

  // Determine end-of-game
  let nextStatus = state.session.status;
  let winnerId = state.session.winnerId || null;
  if (correct && newScore >= SCORE_TO_WIN) {
    nextStatus = "ended";
    winnerId = state.me.id;
  }

  const updates = {};
  updates[`players/${state.me.id}/timeline`] = newTimeline;
  updates[`players/${state.me.id}/score`] = newScore;
  updates[`players/${state.me.id}/currentDraw`] = null;
  updates[`turnIndex`] = nextIndex;
  updates[`status`] = nextStatus;
  if (nextStatus === "ended") updates[`winnerId`] = winnerId;

  await update(sessionRef(state.code), updates);

  // Show local result toast
  state.cardOpen = false;
  state.localResult = {
    correct,
    year: card.jaar,
    rider: card.renner,
    cardId,
  };
  clearTimeout(state.resultTimer);
  state.resultTimer = setTimeout(() => {
    state.localResult = null;
    render();
  }, 3500);
  render();
}

// ───────────────────────────────────────────────────────────────────────────
// Rendering — one function per view
// ───────────────────────────────────────────────────────────────────────────
function render() {
  // Update meta line in topbar
  if (state.code) $meta.textContent = `Code ${state.code}`;
  else $meta.textContent = "";

  // Show topbar close button only when in a session
  const $topClose = document.getElementById("btnTopClose");
  if ($topClose) $topClose.hidden = !state.session;

  // Toggle landscape-hint class
  document.body.classList.toggle("in-game", state.session?.status === "playing");

  // Auto-draw a card the moment it becomes my turn — no separate "Trek nieuwe
  // kaart" step. The face-down card just appears, ready to be opened.
  maybeAutoDraw();

  let html = "";
  if (!state.me.id) {
    html = `<div class="home"><div class="sub">Verbinden…</div></div>`;
  } else if (!state.session) {
    html = renderHome();
  } else if (state.session.status === "lobby") {
    html = renderLobby();
  } else if (state.session.status === "playing") {
    html = renderGame();
  } else if (state.session.status === "ended") {
    html = renderEnd();
  }

  if (state.error) {
    html += `<div class="error-toast">${escapeHtml(state.error)}</div>`;
  }

  $view.innerHTML = html;
  bindEvents();
}

// ── HOME ─────────────────────────────────────────────────────────────────
function renderHome() {
  const name = escapeHtml(state.me.name);
  return `
    <div class="home">
      <div class="left">
        <div class="logo-tile"></div>
        <div class="label">Multiplayer · 2–6 spelers</div>
        <div class="title"><span class="h">HITSTER</span> <span class="c">CYCLING</span></div>
        <div class="sub">Iedereen op een eigen telefoon. Speel in landschapsmodus rondom de tafel.</div>
      </div>
      <div class="hc-card right">
        <div class="form-block">
          <div class="field-label">Je naam</div>
          <input type="text" id="nameInput" placeholder="Bijv. Pietje" value="${name}" maxlength="14" />
        </div>
        <button class="hc-btn hc-btn--primary" id="btnCreate">Nieuw spel starten</button>
        <div class="or">— OF —</div>
        <div class="form-block">
          <div class="field-label">Spelcode</div>
          <input type="text" id="codeInput" placeholder="ABCD" class="code-input" maxlength="${CODE_LENGTH}" autocapitalize="characters" />
        </div>
        <button class="hc-btn hc-btn--outline-cyan" id="btnJoin">Meedoen met code</button>
      </div>
    </div>
  `;
}

// ── LOBBY ────────────────────────────────────────────────────────────────
function renderLobby() {
  const sess = state.session;
  const pids = Object.keys(sess.players || {});
  const isHost = sess.hostId === state.me.id;
  const canStart = pids.length >= MIN_PLAYERS;

  const playersHtml = pids.map((pid, i) => {
    const p = sess.players[pid];
    const isMe = pid === state.me.id;
    const isPlayerHost = pid === sess.hostId;
    const accent = accentForPlayerIndex(i);
    return `
      <div class="player-row">
        <div class="player-avatar" style="background:var(--hc-${accent})">${escapeHtml((p.name || "?")[0].toUpperCase())}</div>
        <div class="player-info">
          <div class="name ${isMe ? "is-me" : isPlayerHost ? "is-host" : ""}">
            ${escapeHtml(p.name)}${isMe ? " (jij)" : ""}
          </div>
          <div class="sub">Doel: ${SCORE_TO_WIN} kaarten</div>
        </div>
        <div class="status ${isPlayerHost ? "host" : ""}">${isPlayerHost ? "★ HOST" : "✓ READY"}</div>
      </div>
    `;
  }).join("");

  const startBtn = isHost
    ? `<button class="hc-btn hc-btn--primary" id="btnStart" ${canStart ? "" : "disabled"}>Start spel</button>`
    : "";
  const leaveBtn = `<button class="hc-btn hc-btn--outline-cyan" id="btnLeave">Verlaat lobby</button>`;
  const hint = !canStart && isHost
    ? `<div class="hint">Wacht op minstens ${MIN_PLAYERS} spelers…</div>`
    : !isHost
    ? `<div class="hint">Wacht tot de host het spel start…</div>`
    : "";

  return `
    <div class="lobby">
      <div class="lobby-left">
        <div class="logo-tile"></div>
        <div class="waiting">Wachten op spelers · ${pids.length}/${MAX_PLAYERS}</div>
        <div class="kamercode">Kamercode</div>
        <div class="roomcode">${escapeHtml(state.code || "")}</div>
        <div class="actions">${startBtn}${leaveBtn}</div>
        ${hint}
      </div>
      <div class="hc-card lobby-right">
        <div class="section-label">Spelers</div>
        ${playersHtml}
      </div>
    </div>
  `;
}

// ── GAME (turn states) ───────────────────────────────────────────────────
function renderGame() {
  const sess = state.session;
  const order = sess.turnOrder || [];
  const activeId = order[sess.turnIndex];
  const myTurn = activeId === state.me.id;
  const me = sess.players[state.me.id] || {};
  const activeName = sess.players[activeId]?.name || "";

  // Header — player tabs + turn status
  const tabsHtml = order.map((pid) => {
    const p = sess.players[pid];
    if (!p) return "";
    const isActive = pid === activeId;
    const isMe = pid === state.me.id;
    const cls = isMe ? "is-me" : isActive ? "is-active" : "";
    return `<div class="hc-playertab ${cls}"><span>${escapeHtml(p.name)}</span><span class="score">${countCorrect(p)}/${SCORE_TO_WIN}</span></div>`;
  }).join("");

  const hasDraw = !!me.currentDraw;
  let turnMsg, turnCls;
  if (state.localResult) {
    turnMsg = state.localResult.correct ? "Correct! →" : "Helaas, fout →";
    turnCls = state.localResult.correct ? "mine" : "placing";
  } else if (myTurn && hasDraw && state.cardOpen) {
    turnMsg = "Plaats de kaart →";
    turnCls = "placing";
  } else if (myTurn) {
    turnMsg = "Jij bent aan de beurt →";
    turnCls = "mine";
  } else {
    turnMsg = `${activeName} is aan de beurt`;
    turnCls = "waiting";
  }

  // Grid columns per view — always two tracks so the right column doesn't wrap.
  const gridCols = state.localResult
    ? "1fr 1.2fr"
    : (myTurn && hasDraw && state.cardOpen)
    ? "1.1fr 1fr"
    : "200px 1fr";

  // Build sub-views
  const sortedTl = sortTimeline(me.timeline);
  const showSlots = myTurn && hasDraw && !state.localResult;

  let leftHtml, rightHtml;

  if (state.localResult) {
    // ── RevealYear ──
    const r = state.localResult;
    const card = MOMENTEN[r.cardId] || {};
    const sideLabel = `${escapeHtml(me.name || "")} · ${countCorrect(me)} / ${SCORE_TO_WIN} kaarten`;
    leftHtml = `
      <div class="hc-card ${r.correct ? "hc-card--yellow" : "hc-card--pink"} reveal-card ${r.correct ? "" : "bad"}">
        <span class="hc-chip ${chipClass(card.cat).split(" ").slice(1).join(" ")}" style="align-self:flex-start">${chipIcon(card.cat)} ${escapeHtml(card.cat || "")}</span>
        <div class="center">
          <div class="label-was">${r.correct ? "Het jaar was" : "Helaas — het was"}</div>
          <div class="year-big">${r.year}</div>
          <div class="rider-name">${escapeHtml(r.rider)}</div>
          <div class="nat-race">${escapeHtml(card.nat || "")} · ${escapeHtml(card.race || "")}</div>
        </div>
        <div class="footer">
          <span class="hc-chip ${r.correct ? "hc-chip--green" : "hc-chip--red"}">${r.correct ? "✓ Correct geplaatst" : "✗ Niet correct"}</span>
        </div>
      </div>
    `;
    rightHtml = `
      <div class="reveal-side">
        <div class="label">${sideLabel}</div>
        ${renderTimelineStrip(sortedTl, "filled", -1, r.correct ? r.cardId : null)}
      </div>
    `;
  } else if (myTurn && hasDraw && state.cardOpen) {
    // ── CardDetail (hero card on left, timeline preview on right) ──
    const card = MOMENTEN[me.currentDraw];
    leftHtml = `
      <div class="hc-card hc-card--pink hero-card">
        <div class="row-top">
          <span class="${chipClass(card.cat)}">${chipIcon(card.cat)} ${escapeHtml(card.cat)}</span>
          <span class="card-id">${escapeHtml(me.currentDraw)}</span>
        </div>
        <div class="hero-bib">
          <div class="year-mask">????</div>
          <div class="meta">
            <div class="rider">${escapeHtml(card.renner)}</div>
            <div class="nat">${escapeHtml(card.nat)}</div>
            <div class="race">${escapeHtml(card.race)}</div>
          </div>
        </div>
        <p class="blurb">${escapeHtml(card.lang)}</p>
        <div class="stats-row">
          <span class="uc display" style="font-size:9px;color:var(--hc-text-dim)">Moeilijkheid${renderDiffDots(card.diff)}</span>
          <span class="uc display glow-pink" style="font-size:9px">+1 PUNT</span>
        </div>
        <div class="action-row">
          <button class="hc-btn hc-btn--outline-pink" id="btnClose">← Sluit kaart</button>
        </div>
      </div>
    `;
    rightHtml = `
      <div class="timeline-side">
        <div class="timeline-head">
          <div class="lbl">Jouw tijdlijn</div>
          <div class="meta">Plaats je kaart in de juiste volgorde</div>
        </div>
        ${renderTimelineStrip(sortedTl, "preview-active", null)}
        <div class="timeline-foot glow-pink">← Lees rustig · plaats hem dan in de juiste volgorde</div>
      </div>
    `;
  } else {
    // ── GameBoard (face-down draw card on left, timeline on right) ──
    // Auto-draw fires before render so myTurn && hasDraw is the common case.
    // Tap the card OR the helper text to flip face-up.
    const tappable = myTurn && hasDraw;
    const helperLabel = !myTurn
      ? `${escapeHtml(activeName)} is aan de beurt`
      : hasDraw
      ? "👆 Tik om te lezen"
      : "Kaart wordt getrokken…";

    leftHtml = `
      <div class="draw-side">
        <div class="label">Nieuwe kaart</div>
        <div class="draw-card" ${tappable ? `data-action="open"` : ""}>
          <div class="inner"></div>
        </div>
        ${tappable
          ? `<button class="hc-btn hc-btn--primary" data-action="open" style="font-size:11px;padding:8px 14px">${helperLabel}</button>`
          : `<div class="label" style="text-align:center">${helperLabel}</div>`}
      </div>
    `;
    rightHtml = `
      <div class="timeline-side">
        <div class="timeline-head">
          <div class="lbl">${escapeHtml(myTurn ? "Jouw tijdlijn" : me.name + "'s tijdlijn")}</div>
          <div class="meta">${sortedTl.length} kaarten</div>
        </div>
        ${renderTimelineStrip(sortedTl, showSlots ? "active" : "filled", null)}
        ${showSlots ? `<div class="timeline-foot">↑ Plaats je kaart in de juiste volgorde</div>` : ``}
      </div>
    `;
  }

  return `
    <div class="game">
      <div class="game-header">
        <div class="tabs">${tabsHtml}</div>
        <div class="turn-msg ${turnCls}">${turnMsg}</div>
      </div>
      <div class="game-body" style="grid-template-columns: ${gridCols};">
        ${leftHtml}
        ${rightHtml}
      </div>
    </div>
  `;
}

// Difficulty dots — returns an inline span
function renderDiffDots(diff) {
  const total = 3;
  const filled = Math.max(0, Math.min(total, diff || 0));
  let dots = `<span class="diff-dots">`;
  for (let i = 0; i < total; i++) {
    dots += `<span class="hc-dot ${i < filled ? "hc-dot--on" : "hc-dot--off"}"></span>`;
  }
  dots += `</span>`;
  return dots;
}

// Timeline strip with cards interleaved with slots.
// mode:
//   "filled"      — no slots, just cards
//   "active"      — slots between every pair, all tappable
//   "preview-active" — slots tappable but rendered dim (player is reading the card)
function renderTimelineStrip(sorted, mode, _activeIdx, highlightCardId = null) {
  const showSlots = mode !== "filled";
  const dim = mode === "preview-active";
  const parts = [];
  for (let i = 0; i <= sorted.length; i++) {
    if (showSlots) {
      parts.push(`<div class="tl-slot ${dim ? "dim" : ""}" data-slot="${i}"></div>`);
    }
    if (i < sorted.length) {
      const entry = sorted[i];
      const card = MOMENTEN[entry.cardId];
      if (!card) continue;
      const isAnchor = !entry.correct;
      const isHighlight = highlightCardId && entry.cardId === highlightCardId;
      const accent = isHighlight ? "yellow" : isAnchor ? "cyan" : accentForIndex(i);
      const tag = isAnchor ? "START" : shortYearTag(entry.year);
      parts.push(`
        <div class="tl-card accent-${accent}" data-card="${escapeHtml(entry.cardId)}">
          <div class="year">${entry.year}</div>
          <div class="rider">${escapeHtml(card.renner)}</div>
          <div class="race">${escapeHtml(card.race)}</div>
          <div class="footer">${tag}</div>
        </div>
      `);
    }
  }
  return `<div class="tl-strip">${parts.join("")}</div>`;
}

// ── END SCREEN ───────────────────────────────────────────────────────────
function renderEnd() {
  const sess = state.session;
  const order = sess.turnOrder || Object.keys(sess.players || {});
  const ranking = order
    .map((pid) => ({ pid, p: sess.players[pid] }))
    .filter((x) => x.p)
    .sort((a, b) => countCorrect(b.p) - countCorrect(a.p));

  const winner = ranking[0]?.p;
  const winnerName = (winner?.name || "").toUpperCase();

  const RANK_COLORS = ["var(--hc-yellow)", "var(--hc-cyan)", "var(--hc-pink)", "var(--hc-text-dim)", "var(--hc-text-dim)", "var(--hc-text-dim)"];
  const MEDALS = ["🏆", "🥈", "🥉", "•", "•", "•"];

  const rowsHtml = ranking.map(({ p }, i) => {
    const color = RANK_COLORS[i] || "var(--hc-text-dim)";
    return `
      <div class="lb-row rank-${i + 1}" style="--rank-color:${color}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-medal">${MEDALS[i] || "•"}</span>
        <span class="lb-name">${escapeHtml(p.name)}</span>
        <span class="lb-score">${countCorrect(p)}/${SCORE_TO_WIN}</span>
      </div>
    `;
  }).join("");

  const winnerScore = winner ? countCorrect(winner) : 0;
  return `
    <div class="end">
      <div class="end-left">
        <div class="lbl">🏆 Eindklassement</div>
        <div class="winner-text">${escapeHtml(winnerName)}<br/>WINT!</div>
        <div class="stats">${winnerScore} kaarten correct geplaatst</div>
        <div class="actions">
          <button class="hc-btn hc-btn--primary" id="btnLeave">Opnieuw spelen</button>
        </div>
      </div>
      <div class="hc-card end-leaderboard">${rowsHtml}</div>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Event delegation
// ───────────────────────────────────────────────────────────────────────────
function bindEvents() {
  const $ = (sel) => $view.querySelector(sel);

  $("#btnCreate")?.addEventListener("click", () => {
    const name = $("#nameInput")?.value || "";
    createSession(name);
  });
  $("#btnJoin")?.addEventListener("click", () => {
    const name = $("#nameInput")?.value || "";
    const code = $("#codeInput")?.value || "";
    joinSession(code, name);
  });
  $("#btnStart")?.addEventListener("click", startGame);

  // The end screen "Opnieuw spelen" and lobby "Verlaat lobby" share btnLeave
  $("#btnLeave")?.addEventListener("click", leaveSession);

  // Game-board face-down card / draw button (data-action="draw" or "open")
  $view.querySelectorAll('[data-action="draw"]').forEach((el) => {
    el.addEventListener("click", drawCard);
  });
  $view.querySelectorAll('[data-action="open"]').forEach((el) => {
    el.addEventListener("click", () => { state.cardOpen = true; render(); });
  });

  // CardDetail close button — keep card open or close (toggle)
  $("#btnClose")?.addEventListener("click", () => { state.cardOpen = false; render(); });

  // Timeline slots
  $view.querySelectorAll(".tl-slot").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.slot, 10);
      placeCard(idx);
    });
  });
}

// Bind topbar close button once — it lives outside #view so isn't rebound on render.
document.getElementById("btnTopClose")?.addEventListener("click", closeSessionFromTopbar);

// initial paint while waiting for auth
render();
