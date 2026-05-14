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

function badgeClass(cat) {
  const k = cat.toLowerCase().replace(/\s+/g, "-").replace(/ë/g, "e");
  return `badge ${k}`;
}

function countCorrect(player) {
  return (player.timeline || []).filter((c) => c.correct).length;
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

  // Toggle landscape-hint class
  document.body.classList.toggle("in-game", state.session?.status === "playing");

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

function renderHome() {
  const name = escapeHtml(state.me.name);
  return `
    <div class="home">
      <h1><span class="h">HITSTER</span> <span class="c">CYCLING</span></h1>
      <div class="sub">Speel met 2–6 spelers. Iedereen op een eigen telefoon, in landschapsmodus.</div>
      <input type="text" id="nameInput" placeholder="Je naam" value="${name}" maxlength="14" />
      <div class="actions">
        <button class="btn btn-primary" id="btnCreate">Nieuw spel starten</button>
        <div class="divider">— OF —</div>
        <input type="text" id="codeInput" placeholder="CODE" class="code-input" maxlength="${CODE_LENGTH}" autocapitalize="characters" />
        <button class="btn btn-cyan" id="btnJoin">Meedoen met code</button>
      </div>
    </div>
  `;
}

function renderLobby() {
  const sess = state.session;
  const pids = Object.keys(sess.players || {});
  const isHost = sess.hostId === state.me.id;
  const canStart = pids.length >= MIN_PLAYERS;

  const playersHtml = pids.map((pid) => {
    const p = sess.players[pid];
    const isMe = pid === state.me.id;
    const crown = pid === sess.hostId ? `<span class="crown">★ host</span>` : "";
    return `<li class="${isMe ? "me" : ""}">${escapeHtml(p.name)} ${crown}</li>`;
  }).join("");

  return `
    <div class="lobby">
      <div class="code-box">
        <div class="label">Spelcode</div>
        <div class="code">${sess.hostId ? state.code : ""}</div>
        <div class="hint">Deel deze code met je medespelers</div>
      </div>
      <h2>Spelers (${pids.length}/${MAX_PLAYERS})</h2>
      <ul class="player-list">${playersHtml}</ul>
      ${isHost
        ? `<button class="btn btn-primary" id="btnStart" ${canStart ? "" : "disabled"}>Start spel</button>
           ${canStart ? "" : `<div class="sub" style="text-align:center;color:var(--mute)">Wacht op minstens ${MIN_PLAYERS} spelers…</div>`}`
        : `<div class="sub" style="text-align:center;color:var(--mute)">Wacht tot de host het spel start…</div>`
      }
      <button class="btn btn-ghost" id="btnLeave">Verlaat lobby</button>
    </div>
  `;
}

function renderGame() {
  const sess = state.session;
  const order = sess.turnOrder || [];
  const activeId = order[sess.turnIndex];
  const myTurn = activeId === state.me.id;
  const me = sess.players[state.me.id];
  const activeName = sess.players[activeId]?.name || "";

  // Scoreboard
  const scoreHtml = order.map((pid) => {
    const p = sess.players[pid];
    const isActive = pid === activeId;
    return `<div class="pill ${isActive ? "active" : ""}">${escapeHtml(p.name)}<span class="score">${countCorrect(p)}/${SCORE_TO_WIN}</span></div>`;
  }).join("");

  const turnHtml = myTurn
    ? `<div class="turn-banner">Jij bent aan de beurt</div>`
    : `<div class="turn-banner waiting">${escapeHtml(activeName)} is aan de beurt</div>`;

  // My timeline (always rendered)
  const sorted = sortTimeline(me.timeline);
  const hasDraw = !!me.currentDraw;
  const showSlots = myTurn && hasDraw && !state.cardOpen && !state.localResult;

  const tlHtml = renderTimeline(sorted, showSlots);

  // Center area: draw button, face-down/face-up card, result toast
  let centerHtml = "";
  if (state.localResult) {
    const r = state.localResult;
    centerHtml = `
      <div class="result ${r.correct ? "ok" : "bad"}">
        ${r.correct ? "Correct!" : "Helaas, fout"}
        <span class="year-big">${r.year}</span>
        <span class="rider">${escapeHtml(r.rider)}</span>
      </div>
    `;
  } else if (myTurn && !hasDraw) {
    centerHtml = `<button class="btn btn-primary" id="btnDraw">🎴 Volgende kaart</button>`;
  } else if (myTurn && hasDraw) {
    const card = MOMENTEN[me.currentDraw];
    if (state.cardOpen) {
      centerHtml = `
        <div class="face-up-card">
          <div class="top">
            <span class="${badgeClass(card.cat)}">${escapeHtml(card.cat)}</span>
            <button class="btn btn-ghost" id="btnClose" style="padding:6px 12px;font-size:0.85rem">Sluiten</button>
          </div>
          <div class="description">${escapeHtml(card.kort)}</div>
          <div class="description" style="color:var(--mute);font-size:0.85rem">${escapeHtml(card.lang)}</div>
        </div>
        <div class="placement-hint">Sluit de kaart en plaats hem in jouw tijdlijn</div>
      `;
    } else {
      centerHtml = `
        <div class="draw-area">
          <div class="face-down-card" id="cardFaceDown">
            <img src="logo.png" alt="">
            <div class="tap-hint">👆 Tik om te lezen</div>
          </div>
          <div class="placement-hint">Of kies direct een gleuf in jouw tijdlijn</div>
        </div>
      `;
    }
  } else {
    centerHtml = `<div class="turn-banner waiting">Wacht op ${escapeHtml(activeName)}…</div>`;
  }

  return `
    <div class="game">
      <div class="scoreboard">${scoreHtml}</div>
      ${turnHtml}
      ${centerHtml}
      <div class="timeline-wrap">
        <h3>${escapeHtml(me.name)}'s tijdlijn</h3>
        ${tlHtml}
      </div>
    </div>
  `;
}

function renderTimeline(sorted, showSlots) {
  // Render N cards interleaved with N+1 slots (only if showSlots).
  const parts = [];
  for (let i = 0; i <= sorted.length; i++) {
    if (showSlots) {
      parts.push(`<div class="tl-slot" data-slot="${i}">＋</div>`);
    }
    if (i < sorted.length) {
      const entry = sorted[i];
      const card = MOMENTEN[entry.cardId];
      const isAnchor = !entry.correct; // anchor is the only non-correct entry on the timeline
      parts.push(`
        <div class="tl-card ${entry.correct ? "correct" : "anchor"}">
          <div class="year">${entry.year}</div>
          <div class="rider">${escapeHtml(card.renner)}</div>
          <div class="race">${escapeHtml(card.race)}</div>
          ${isAnchor ? `<div class="anchor-tag">Start</div>` : ""}
        </div>
      `);
    }
  }
  return `<div class="timeline">${parts.join("")}</div>`;
}

function renderEnd() {
  const sess = state.session;
  const winner = sess.players[sess.winnerId];
  const order = sess.turnOrder || Object.keys(sess.players);
  const ranking = order.map((pid) => sess.players[pid])
    .sort((a, b) => countCorrect(b) - countCorrect(a));

  const listHtml = ranking.map((p, i) => `
    <li class="${i === 0 ? "first" : ""}">
      <span>${i === 0 ? "🏆 " : ""}${escapeHtml(p.name)}</span>
      <span>${countCorrect(p)} / ${SCORE_TO_WIN}</span>
    </li>
  `).join("");

  return `
    <div class="end">
      <h1>🎉 Winnaar!</h1>
      <div class="winner">${escapeHtml(winner?.name || "")}</div>
      <ul class="final-list">${listHtml}</ul>
      <button class="btn btn-primary" id="btnLeave">Terug naar start</button>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Event delegation
// ───────────────────────────────────────────────────────────────────────────
function bindEvents() {
  const $ = (sel) => $view.querySelector(sel);

  $("#btnCreate")?.addEventListener("click", () => {
    const name = $("#nameInput").value;
    createSession(name);
  });
  $("#btnJoin")?.addEventListener("click", () => {
    const name = $("#nameInput").value;
    const code = $("#codeInput").value;
    joinSession(code, name);
  });
  $("#btnStart")?.addEventListener("click", startGame);
  $("#btnLeave")?.addEventListener("click", leaveSession);
  $("#btnDraw")?.addEventListener("click", drawCard);
  $("#btnClose")?.addEventListener("click", () => { state.cardOpen = false; render(); });

  // Face-down card → reveal again
  $("#cardFaceDown")?.addEventListener("click", () => { state.cardOpen = true; render(); });

  // Timeline slots
  $view.querySelectorAll(".tl-slot").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.slot, 10);
      placeCard(idx);
    });
  });
}

// initial paint while waiting for auth
render();
