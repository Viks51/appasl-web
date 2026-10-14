'use strict';

// ═══════════════════════════ VERSION ═══════════════════════════
// À chaque mise en ligne : ajouter une entrée en tête de APP_RELEASES et passer CACHE_NAME
// de sw.js au numéro suivant (règle : version 2.N ↔ cache appasl-v(N+1)).

const APP_AUTHOR = 'Baptiste Sené';

const APP_RELEASES = [
  { version: '2.6', date: '2026-10-14', title: 'Informations', notes: [
    'Menu « Informations » : version, date, mises à jour et auteur.',
    'Un nom de combattant long tient sur une ligne : les deux panneaux restent alignés.',
  ] },
  { version: '2.5', date: '2026-10-14', title: 'Fiabilité et écran de match', notes: [
    'Le match en cours est sauvegardé à chaque action et peut être repris après une fermeture de l\'app.',
    'Touches et cartons peuvent être saisis chrono arrêté.',
    'Chrono exact même écran verrouillé ; l\'écran reste allumé pendant le match.',
    'Grands boutons, barre « Valider / Effacer la salve / Défaire », Défaire sur plusieurs actions.',
    'Vibrations à la saisie, signaux à 10 s et à la fin du temps (son réglable).',
    'Saisie des deux noms en une fois, avec les noms récents.',
    'Affichage adapté au paysage et à la tablette ; bandeau « Nouvelle version disponible ».',
  ] },
  { version: '2.4', date: '2026-07-11', title: 'Zones touchées', notes: [
    'Silhouette des zones touchées dans la fiche de chaque combattant.',
  ] },
  { version: '2.3', date: '2026-07-11', title: 'Statistiques par combattant', notes: [
    'Noms des combattants modifiables avant le match.',
    'Onglet « Par combattant » : bilan, scores moyens, cartons, adversaires.',
  ] },
  { version: '2.2', date: '2026-07-11', title: 'Statistiques du club', notes: [
    'Tableau de statistiques : matchs, scores, durées, victoires, zones et cartons.',
  ] },
  { version: '2.1', date: '2026-07-11', title: 'Historique', notes: [
    'Historique des matchs enregistré sur l\'appareil, avec export CSV et suppression.',
  ] },
  { version: '2.0', date: '2026-07-10', title: 'Version web', notes: [
    'Application web installable sur l\'écran d\'accueil, utilisable hors ligne, export CSV.',
  ] },
];

const APP_VERSION = APP_RELEASES[0].version;

function formatDateFr(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ═══════════════════════════ ÉTAT ═══════════════════════════

function newFighter(name) {
  return { name, score: 0, whiteCards: 0, yellowCards: 0, hasRed: false, isExcluded: false };
}

const state = {
  fighter1: newFighter('Combattant rouge'),
  fighter2: newFighter('Combattant vert'),
  status: 'idle', // idle | running | paused | finished
  remainingSeconds: 180, // dérivé de l'horloge (voir syncClock), sert à l'affichage
  remainingMs: 180000,   // temps restant quand le chrono est arrêté
  timerEndsAt: null,     // échéance (Date.now()) quand le chrono tourne
  runningSince: null,
  elapsedMs: 0,          // temps de chrono écoulé, hors périodes en cours
  timerId: null,
  matchStartTime: null,
  salveFighter: null,
  salveMax: 0,
  salveHitCount: 0,
  salveZones: [],
  undoStack: [], // un état par action annulable (touche, carton), du plus ancien au plus récent
  events: [], // { matchSecond, description, type, fighterId, zone, isSalve, salveZones, pointsScored, carton, scoreRouge, scoreVert, isSuddenDeath, cancelled }
  winner: null,
  matchId: null,
};

function newMatchId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSuddenDeath() {
  return state.fighter1.score >= 10 && state.fighter2.score >= 10 && state.status !== 'finished';
}

const MATCH_MS = 180000;

// Le chrono se calcule à partir de l'horloge réelle et non en comptant les ticks :
// le navigateur ralentit les timers quand l'écran se verrouille ou que l'app passe
// en arrière-plan, ce qui faussait le temps affiché.
function currentRemainingMs() {
  if (state.status === 'running' && state.timerEndsAt !== null) return Math.max(0, state.timerEndsAt - Date.now());
  return state.remainingMs;
}

function syncClock() { state.remainingSeconds = Math.ceil(currentRemainingMs() / 1000); }

function elapsedSeconds() {
  let ms = state.elapsedMs;
  if (state.status === 'running' && state.runningSince !== null) ms += Date.now() - state.runningSince;
  return Math.floor(ms / 1000);
}

function timerDisplay() {
  const m = Math.floor(state.remainingSeconds / 60);
  const s = state.remainingSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function nowHms() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ═══════════════════════════ SNAPSHOT / UNDO ═══════════════════════════

function saveSnapshot() {
  state.undoStack.push({
    f1: { ...state.fighter1 },
    f2: { ...state.fighter2 },
    status: state.status,
    winner: state.winner,
    eventCountBefore: state.events.length,
  });
}

function canUndo() { return state.undoStack.length > 0; }

// libellé de l'action que « Défaire » va annuler (premier événement de cette action)
function undoTargetLabel() {
  const snap = state.undoStack[state.undoStack.length - 1];
  const e = snap && state.events[snap.eventCountBefore];
  return e ? e.description.replace(/ : (\d+) pts?$/, ' (+$1)') : '';
}

function undoLastAction() {
  const snap = state.undoStack.pop();
  if (!snap) return;

  Object.assign(state.fighter1, snap.f1);
  Object.assign(state.fighter2, snap.f2);

  // Les événements de chrono (arrêt, reprise, ajustements) ne sont pas défaits :
  // seuls ceux de l'action annulée (et une éventuelle fin de match) sont barrés.
  for (let i = snap.eventCountBefore; i < state.events.length; i++) {
    if (state.events[i].type !== 'chrono') state.events[i].cancelled = true;
  }

  // Le statut n'est restauré que si l'action annulée avait terminé le match :
  // sinon un « pause » intercalé entre l'action et l'annulation serait écrasé.
  if (state.status === 'finished') {
    deleteMatchRecord(state.matchId);
    state.status = snap.status;
    state.winner = snap.winner;
    if (snap.status === 'running') startTimer();
  }

  vibrate(15);
  render();
}

// ═══════════════════════════ ÉVÉNEMENTS ═══════════════════════════

function addTimestampEvent(label, type) {
  state.events.push({
    matchSecond: elapsedSeconds(),
    description: `${label} ${nowHms()}`,
    type,
    scoreRouge: state.fighter1.score,
    scoreVert: state.fighter2.score,
  });
}

// ═══════════════════════════ CHRONO ═══════════════════════════

function startStop() {
  if (state.status === 'finished') return;
  if (state.status === 'running') {
    addTimestampEvent('Arrêt chrono', 'chrono');
    pauseTimer();
  } else {
    if (state.status === 'idle') { state.matchStartTime = new Date(); state.matchId = newMatchId(); }
    addTimestampEvent(state.status === 'idle' ? 'Début match' : 'Reprise chrono', 'chrono');
    startTimer();
  }
}

function setRemainingMs(ms) {
  if (state.status === 'running') state.timerEndsAt = Date.now() + ms;
  else state.remainingMs = ms;
}

function resetTimer() {
  if (state.status === 'idle') { setRemainingMs(MATCH_MS); render(); return; }
  showModal('Remettre le chrono à 3:00 ?', 'Le temps restant du match en cours sera remplacé.', [
    { label: 'Annuler' },
    { label: 'Remettre à 3:00', danger: true, onClick: () => {
      setRemainingMs(MATCH_MS);
      addTimestampEvent('Chrono remis à 3:00', 'chrono');
      render();
    } },
  ]);
}

function addTime(seconds) {
  setRemainingMs(Math.min(599000, Math.max(0, currentRemainingMs() + seconds * 1000)));
  if (state.status !== 'idle') addTimestampEvent(`Chrono +${seconds} s`, 'chrono');
  render();
}

function tick() {
  const ms = currentRemainingMs();
  if (ms <= 0) { signalTimeUp(); endMatch(); return; }
  checkTimeSignals(ms);
  if (Math.ceil(ms / 1000) !== state.remainingSeconds) render();
}

function startTimer() {
  const now = Date.now();
  state.timerEndsAt = now + state.remainingMs;
  state.runningSince = now;
  state.status = 'running';
  clearInterval(state.timerId);
  state.timerId = setInterval(tick, 250);
  render();
}

// fige le chrono (pause ou fin) en reportant le temps écoulé
function freezeClock() {
  if (state.status !== 'running' || state.timerEndsAt === null) return;
  const now = Date.now();
  state.remainingMs = Math.max(0, state.timerEndsAt - now);
  state.elapsedMs += now - state.runningSince;
  state.timerEndsAt = null;
  state.runningSince = null;
}

function pauseTimer() {
  clearInterval(state.timerId);
  freezeClock();
  state.status = 'paused';
  render();
}

function endMatch() {
  if (state.status === 'finished') return;
  clearInterval(state.timerId);
  freezeClock();
  commitSalveInternal(); // peut elle-même terminer le match (15 pts)
  if (state.status === 'finished') return;
  state.status = 'finished';

  if (state.winner === null) {
    if (state.fighter1.score > state.fighter2.score) state.winner = state.fighter1.name;
    else if (state.fighter2.score > state.fighter1.score) state.winner = state.fighter2.name;
    else state.winner = 'Égalité';
  }
  addTimestampEvent('Fin du match', 'finMatch');
  persistCurrentMatch();
  render();
}

// ═══════════════════════════ SALVE / TOUCHES ═══════════════════════════

function zoneValue(zone) { return zone === 'A' ? 1 : zone === 'B' ? 3 : 5; }

function isMatchLive() { return state.status === 'running' || state.status === 'paused'; }

function hitZone(fighterId, zone) {
  if (!isMatchLive()) return;
  const fighter = fighterId === 1 ? state.fighter1 : state.fighter2;
  if (fighter.isExcluded) return;

  const val = zoneValue(zone);
  if (isSuddenDeath() && val < 5) return;
  if (state.salveFighter !== null && state.salveFighter !== fighterId) return;

  if (state.salveFighter === null) {
    state.salveFighter = fighterId;
    state.salveMax = val;
    state.salveHitCount = 1;
    state.salveZones = [zone];
  } else {
    if (val > state.salveMax) state.salveMax = val;
    state.salveHitCount++;
    state.salveZones.push(zone);
  }
  vibrate(25);
  render();
}

function cancelPendingSalve() {
  if (state.salveFighter === null) return;
  state.salveFighter = null;
  state.salveMax = 0;
  state.salveHitCount = 0;
  state.salveZones = [];
  render();
}

function commitSalve() {
  if (state.salveFighter === null) return;
  vibrate(60);
  saveSnapshot();
  commitSalveInternal();
  render();
}

function commitSalveInternal() {
  if (state.salveFighter === null) return;
  const fighter = state.salveFighter === 1 ? state.fighter1 : state.fighter2;

  const wasSuddenDeath = state.fighter1.score >= 10 && state.fighter2.score >= 10;
  const winningZone = state.salveMax === 1 ? 'A' : state.salveMax === 3 ? 'B' : 'C';
  const zones = state.salveZones.slice();
  const hitCount = state.salveHitCount;
  const savedFighterId = state.salveFighter;

  fighter.score += state.salveMax;

  let zoneDesc = '';
  zones.forEach((z, i) => { zoneDesc += i === 0 ? `touche zone ${z}` : `, salve zone ${z}`; });

  state.events.push({
    matchSecond: elapsedSeconds(),
    description: `${fighter.name} ${zoneDesc} : ${state.salveMax} pt${state.salveMax > 1 ? 's' : ''}`,
    pointsScored: state.salveMax,
    type: 'touche',
    fighterId: savedFighterId,
    zone: winningZone,
    isSalve: hitCount >= 2,
    salveZones: zones,
    scoreRouge: state.fighter1.score,
    scoreVert: state.fighter2.score,
    isSuddenDeath: wasSuddenDeath,
  });

  state.salveFighter = null;
  state.salveMax = 0;
  state.salveHitCount = 0;
  state.salveZones = [];

  if (fighter.score >= 15 && state.status !== 'finished') {
    state.winner = fighter.name;
    endMatch();
  }
}

// ═══════════════════════════ CARTONS ═══════════════════════════

const CARTON_CSV_NAME = { white: 'blanc', yellow: 'jaune', red: 'rouge', black: 'noir' };

function addCard(fighterId, color) {
  if (!isMatchLive()) return;
  const fighter = fighterId === 1 ? state.fighter1 : state.fighter2;
  const opponent = fighterId === 1 ? state.fighter2 : state.fighter1;

  vibrate([30, 40, 30]);
  saveSnapshot();

  if (color === 'white') {
    fighter.whiteCards++;
    if (fighter.whiteCards === 1) {
      state.events.push(ev(fighterId, `${fighter.name} : carton blanc (1)`, { type: 'carton', carton: 'white' }));
    } else {
      opponent.score += 3;
      state.events.push(ev(fighterId, `${fighter.name} : ${fighter.whiteCards}e carton blanc → carton jaune, +3 pts pour ${opponent.name}`, { type: 'carton', carton: 'yellow', pointsScored: 3 }));
      if (opponent.score >= 15 && state.status !== 'finished') { state.winner = opponent.name; endMatch(); return; }
    }
  } else if (color === 'yellow') {
    fighter.yellowCards++;
    if (fighter.yellowCards === 1) {
      opponent.score += 3;
      state.events.push(ev(fighterId, `${fighter.name} : carton jaune → +3 pts pour ${opponent.name}`, { type: 'carton', carton: 'yellow', pointsScored: 3 }));
    } else {
      opponent.score += 6;
      state.events.push(ev(fighterId, `${fighter.name} : ${fighter.yellowCards}e carton jaune → carton rouge, +6 pts pour ${opponent.name}`, { type: 'carton', carton: 'red', pointsScored: 6 }));
    }
    if (opponent.score >= 15 && state.status !== 'finished') { state.winner = opponent.name; endMatch(); return; }
  } else if (color === 'red') {
    fighter.hasRed = true;
    opponent.score += 6;
    state.events.push(ev(fighterId, `${fighter.name} : carton rouge → +6 pts pour ${opponent.name}`, { type: 'carton', carton: 'red', pointsScored: 6 }));
    if (opponent.score >= 15 && state.status !== 'finished') { state.winner = opponent.name; endMatch(); return; }
  } else if (color === 'black') {
    fighter.isExcluded = true;
    state.winner = opponent.name;
    state.events.push(ev(fighterId, `${fighter.name} : CARTON NOIR — EXCLUSION`, { type: 'carton', carton: 'black' }));
    endMatch();
    return;
  }

  render();
}

function ev(fighterId, description, extra) {
  return Object.assign({
    matchSecond: elapsedSeconds(),
    description,
    fighterId,
    scoreRouge: state.fighter1.score,
    scoreVert: state.fighter2.score,
  }, extra);
}

// ═══════════════════════════ RESET ═══════════════════════════

function resetMatch() {
  clearInterval(state.timerId);
  Object.assign(state.fighter1, newFighter('Combattant rouge'));
  Object.assign(state.fighter2, newFighter('Combattant vert'));
  state.status = 'idle';
  state.remainingSeconds = 180;
  state.remainingMs = MATCH_MS;
  state.timerEndsAt = null;
  state.runningSince = null;
  state.elapsedMs = 0;
  state.matchStartTime = null;
  state.salveFighter = null;
  state.salveMax = 0;
  state.salveHitCount = 0;
  state.salveZones = [];
  state.undoStack = [];
  state.events = [];
  state.winner = null;
  state.matchId = null;
  render();
}

// ═══════════════════════════ CSV / HISTORIQUE ═══════════════════════════

const EVENT_TYPE_CSV = { touche: 'touche', carton: 'carton', chrono: 'chrono', finMatch: 'fin_match' };

function buildMatchRecord() {
  let dateStr = '', heureStr = '';
  if (state.matchStartTime) {
    const t = state.matchStartTime;
    dateStr = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    heureStr = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
  }
  return {
    id: state.matchId ?? newMatchId(),
    savedAt: Date.now(),
    dateStr,
    heureStr,
    fighter1Name: state.fighter1.name,
    fighter2Name: state.fighter2.name,
    score1: state.fighter1.score,
    score2: state.fighter2.score,
    winner: state.winner ?? '',
    durationS: elapsedSeconds(),
    events: state.events.map((e) => ({ ...e })),
  };
}

function generateCsvFromRecord(record) {
  const lines = [];

  lines.push('cle,valeur');
  lines.push(`date,${record.dateStr}`);
  lines.push(`heure_debut,${record.heureStr}`);
  lines.push(`combattant_rouge,"${record.fighter1Name}"`);
  lines.push(`combattant_vert,"${record.fighter2Name}"`);
  lines.push(`score_final_rouge,${record.score1}`);
  lines.push(`score_final_vert,${record.score2}`);
  lines.push(`vainqueur,"${record.winner}"`);
  lines.push(`duree_s,${record.durationS}`);
  lines.push('');

  lines.push('num,temps_match_s,type,combattant,zone,salve,salve_zones,points_event,score_rouge,score_vert,carton,mort_subite,annule');

  record.events.forEach((e, idx) => {
    const combattant = e.fighterId === 1 ? 'rouge' : e.fighterId === 2 ? 'vert' : '';
    const zone = e.zone ?? '';
    const salve = e.type === 'touche' ? (e.isSalve ? 'oui' : 'non') : '';
    const salveZones = e.isSalve ? e.salveZones.join('|') : '';
    const points = e.pointsScored != null ? String(e.pointsScored) : '';
    const carton = e.carton ? CARTON_CSV_NAME[e.carton] : '';
    const mortSubite = e.type === 'touche' ? (e.isSuddenDeath ? 'oui' : 'non') : '';
    const annule = e.cancelled ? 'oui' : 'non';

    lines.push([
      idx + 1, e.matchSecond, EVENT_TYPE_CSV[e.type], combattant, zone,
      salve, salveZones, points, e.scoreRouge, e.scoreVert, carton, mortSubite, annule,
    ].join(','));
  });

  return lines.join('\n') + '\n';
}

function downloadCsv(record) {
  const rec = record ?? buildMatchRecord();
  const content = generateCsvFromRecord(rec);
  const timestamp = new Date(rec.savedAt).toISOString().replace(/:/g, '-').substring(0, 19);
  const filename = `appasl_match_${timestamp}.csv`;

  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return filename;
}

function exportCsv() {
  try {
    const filename = downloadCsv();
    showToast(`CSV exporté : ${filename}`);
  } catch (e) {
    showToast(`Erreur export : ${e}`);
  }
}

// ── stockage IndexedDB ──

const HISTORY_DB_NAME = 'appasl-db';
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE = 'matches';

function openHistoryDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveMatchRecord(record) {
  try {
    const db = await openHistoryDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Erreur sauvegarde historique', e);
  }
}

async function getAllMatchRecords() {
  try {
    const db = await openHistoryDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readonly');
      const req = tx.objectStore(HISTORY_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('Erreur lecture historique', e);
    return [];
  }
}

async function deleteMatchRecord(id) {
  try {
    const db = await openHistoryDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Erreur suppression historique', e);
  }
}

async function clearMatchHistory() {
  try {
    const db = await openHistoryDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_STORE, 'readwrite');
      tx.objectStore(HISTORY_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Erreur vidage historique', e);
  }
}

function persistCurrentMatch() {
  if (!state.matchId) return;
  saveMatchRecord(buildMatchRecord());
}

// ═══════════════════════════ RENDU ═══════════════════════════

const LOG_KEYWORDS = [
  ['zone A', '#43A047'],
  ['zone B', '#FFB300'],
  ['zone C', '#E53935'],
  ['carton blanc', '#FFFFFF'],
  ['carton jaune', '#FFEB3B'],
  ['carton rouge', '#E53935'],
  ['carton noir', '#9E9E9E'],
  ['CARTON NOIR', '#9E9E9E'],
];

function colorizeInto(container, text) {
  const hits = [];
  for (const [kw, color] of LOG_KEYWORDS) {
    let pos = 0;
    while (pos < text.length) {
      const idx = text.indexOf(kw, pos);
      if (idx === -1) break;
      hits.push([idx, idx + kw.length, color]);
      pos = idx + kw.length;
    }
  }
  if (hits.length === 0) { container.appendChild(document.createTextNode(text)); return; }

  hits.sort((a, b) => a[0] - b[0]);
  const deduped = [];
  let lastEnd = 0;
  for (const h of hits) { if (h[0] >= lastEnd) { deduped.push(h); lastEnd = h[1]; } }

  let cursor = 0;
  for (const [start, end, color] of deduped) {
    if (cursor < start) container.appendChild(document.createTextNode(text.substring(cursor, start)));
    const span = document.createElement('span');
    span.style.color = color;
    span.style.fontWeight = 'bold';
    span.textContent = text.substring(start, end);
    container.appendChild(span);
    cursor = end;
  }
  if (cursor < text.length) container.appendChild(document.createTextNode(text.substring(cursor)));
}

const COMPACT_LOG_ROWS = 3;

// Le plus récent en haut. compact : seules les dernières lignes sont affichées en match
// (portrait), le journal complet s'ouvre d'un tap.
function renderEventLog(container, events = state.events, { compact = false, emptyText = 'Aucun événement' } = {}) {
  container.innerHTML = '';
  container.classList.toggle('compact', compact);
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-log-empty';
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const row = document.createElement('div');
    const rank = events.length - 1 - i;
    row.className = 'log-row' + (e.cancelled ? ' cancelled' : '') + (rank === 0 ? ' first' : '')
      + (compact && rank >= COMPACT_LOG_ROWS ? ' overflow' : '');

    const m = Math.floor(e.matchSecond / 60);
    const s = e.matchSecond % 60;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `${m}:${pad2(s)}`;
    row.appendChild(time);

    const desc = document.createElement('span');
    desc.className = 'log-desc';
    if (e.cancelled) desc.textContent = e.description;
    else colorizeInto(desc, e.description);
    row.appendChild(desc);

    container.appendChild(row);
  }
  if (compact && events.length > COMPACT_LOG_ROWS) {
    const more = document.createElement('div');
    more.className = 'log-more';
    const hidden = events.length - COMPACT_LOG_ROWS;
    more.textContent = `+ ${hidden} ligne${hidden > 1 ? 's' : ''} — toucher pour tout voir`;
    container.appendChild(more);
  }
}

function openLog() {
  renderEventLog(document.getElementById('event-log-full'));
  document.getElementById('log-overlay').classList.remove('hidden');
}

function closeLog() { document.getElementById('log-overlay').classList.add('hidden'); }

function salveSummary() {
  const pts = `+${state.salveMax} pt${state.salveMax > 1 ? 's' : ''}`;
  return state.salveHitCount >= 2 ? `${pts} · salve ×${state.salveHitCount}` : pts;
}

function renderStatusLine() {
  const el = document.getElementById('status-line');
  let text = '';
  let kind = '';
  if (state.status === 'idle') {
    text = 'Touchez ▶ pour lancer · un nom pour le saisir';
    kind = 'hint';
  } else if (state.status === 'paused') {
    text = 'CHRONO ARRÊTÉ — saisie toujours possible';
    kind = 'paused';
  }
  el.textContent = text || '·';
  el.className = `status-line ${kind}`;
  el.classList.toggle('invisible', !text);
}

function renderActionBar() {
  const pending = state.salveFighter !== null;
  document.getElementById('btn-cancel-salve').classList.toggle('hidden', !pending);
  document.getElementById('btn-validate').classList.toggle('hidden', !pending);
  document.getElementById('btn-undo').classList.toggle('hidden', pending);
  if (pending) {
    const fighter = state.salveFighter === 1 ? state.fighter1 : state.fighter2;
    document.getElementById('validate-main').textContent = `✓ Valider ${salveSummary()}`;
    document.getElementById('validate-sub').textContent = fighter.name;
  }
  document.getElementById('btn-undo').disabled = !canUndo();
  document.getElementById('undo-sub').textContent = canUndo() ? undoTargetLabel() : 'rien à défaire';
}

function renderFighterPanel(id, fighter) {
  const panel = document.getElementById(`panel-${id}`);
  const hasPendingSalve = state.salveFighter === id;
  const enabled = isMatchLive() && (state.salveFighter === null || state.salveFighter === id);

  panel.classList.toggle('excluded', fighter.isExcluded);
  panel.classList.toggle('pending-salve', hasPendingSalve);

  const nameEl = document.getElementById(`name-${id}`);
  const editable = state.status === 'idle';
  nameEl.textContent = editable ? `${fighter.name} ✎` : fighter.name;
  nameEl.classList.toggle('editable', editable);
  nameEl.disabled = !editable;
  document.getElementById(`score-${id}`).textContent = fighter.score;

  // emplacement toujours réservé : rien ne bouge sous le doigt de l'arbitre
  const badge = document.getElementById(`salve-badge-${id}`);
  badge.classList.toggle('invisible', !hasPendingSalve);
  badge.textContent = hasPendingSalve ? salveSummary() : '·';

  const zonesEl = document.getElementById(`zones-${id}`);
  zonesEl.classList.toggle('hidden', fighter.isExcluded);
  document.getElementById(`excluded-${id}`).classList.toggle('hidden', !fighter.isExcluded);

  const sd = isSuddenDeath();
  zonesEl.querySelectorAll('.zone-btn').forEach((btn) => {
    const zone = btn.dataset.zone;
    const dimmed = zone !== 'C' && sd;
    const active = enabled && !dimmed;
    btn.disabled = !active;
    btn.classList.toggle('dim', dimmed);
  });

  const cardButtons = document.getElementById(`card-buttons-${id}`);
  cardButtons.classList.toggle('hidden', fighter.isExcluded);
  cardButtons.classList.toggle('invisible', !enabled);

  renderCardChips(document.getElementById(`card-chips-${id}`), fighter);
}

function renderCardChips(container, fighter) {
  container.innerHTML = '';
  if (fighter.whiteCards === 0 && fighter.yellowCards === 0 && !fighter.hasRed && !fighter.isExcluded) return;

  const chip = (color, label) => {
    const d = document.createElement('div');
    d.className = `card-chip ${color}`;
    d.textContent = label;
    container.appendChild(d);
  };

  const showWhiteChip = fighter.whiteCards === 1;
  const whiteYellowCount = fighter.whiteCards >= 2 ? fighter.whiteCards - 1 : 0;
  const showYellowChip = fighter.yellowCards === 1;
  const yellowRedCount = fighter.yellowCards >= 2 ? fighter.yellowCards - 1 : 0;

  if (showWhiteChip) chip('white', 'B');
  for (let i = 0; i < whiteYellowCount; i++) chip('yellow', 'J');
  if (showYellowChip) chip('yellow', 'J');
  for (let i = 0; i < yellowRedCount; i++) chip('red', 'R');
  if (fighter.hasRed) chip('red', 'R');
  if (fighter.isExcluded) chip('black', 'N');
}

function renderWinnerTitle() {
  const el = document.getElementById('winner-title');
  el.innerHTML = '';
  const w = state.winner;
  if (w === null || w === 'Égalité') {
    el.innerHTML = '<span class="tie">Égalité</span>';
    return;
  }
  const isRed = w === state.fighter1.name;
  el.innerHTML = `Victoire<br>Combattant <span class="${isRed ? 'red-name' : 'green-name'}">${isRed ? 'rouge' : 'vert'}</span>`;
}

function render() {
  syncClock();
  const isRunning = state.status === 'running';
  const isFinished = state.status === 'finished';
  const isPulsing = state.remainingSeconds < 10 && isRunning;

  document.getElementById('screen-match').classList.toggle('hidden', isFinished);
  document.getElementById('screen-result').classList.toggle('hidden', !isFinished);

  document.getElementById('sudden-death-banner').classList.toggle('hidden', !isSuddenDeath());

  const timerEl = document.getElementById('timer-display');
  timerEl.textContent = timerDisplay();
  timerEl.classList.toggle('low', state.remainingSeconds <= 30);
  timerEl.classList.toggle('pulsing', isPulsing);

  document.getElementById('icon-play').classList.toggle('hidden', isRunning);
  document.getElementById('icon-pause').classList.toggle('hidden', !isRunning);
  document.getElementById('btn-play-pause').classList.toggle('running', isRunning);

  renderStatusLine();
  renderFighterPanel(1, state.fighter1);
  renderFighterPanel(2, state.fighter2);
  renderEventLog(document.getElementById('event-log'), state.events, { compact: true, emptyText: 'Journal du match' });
  renderActionBar();
  if (isShown('log-overlay')) renderEventLog(document.getElementById('event-log-full'));

  if (isFinished) {
    renderWinnerTitle();
    document.getElementById('result-score-1').textContent = `${state.fighter1.name}  ${state.fighter1.score} pts`;
    document.getElementById('result-score-2').textContent = `${state.fighter2.name}  ${state.fighter2.score} pts`;
    document.getElementById('btn-undo-result').classList.toggle('hidden', !canUndo());
    renderEventLog(document.getElementById('event-log-result'));
  }

  persistLiveMatch();
  updateWakeLock();
}

// ═══════════════════════════ RETOURS : VIBRATIONS ET SIGNAUX ═══════════════════════════
// L'arbitre regarde le combat, pas l'écran : chaque saisie est confirmée par une vibration,
// et la fin du temps (et les 10 dernières secondes) par un signal.

const SOUND_KEY = 'appasl-sound';
let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) {}
let audioCtx = null;

function vibrate(pattern) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
}

// l'audio ne peut démarrer qu'après un geste de l'utilisateur
function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function beep(freq, durationMs, startDelayMs = 0) {
  if (!soundOn || !audioCtx) return;
  const t0 = audioCtx.currentTime + startDelayMs / 1000;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
  gain.gain.setValueAtTime(0.25, t0 + durationMs / 1000 - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.02);
}

function signalTenSeconds() {
  vibrate([120, 60, 120]);
  beep(880, 120); beep(880, 120, 200);
}

function signalTimeUp() {
  vibrate([400, 120, 400, 120, 400]);
  beep(660, 900);
}

let warnedTenSeconds = false;

function checkTimeSignals(ms) {
  if (ms > 10000) { warnedTenSeconds = false; return; }
  if (!warnedTenSeconds && state.status === 'running') { warnedTenSeconds = true; signalTenSeconds(); }
}

function toggleSound() {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch (e) {}
  updateSoundMenuLabel();
  if (soundOn) { unlockAudio(); beep(880, 100); }
  showToast(soundOn ? 'Signaux sonores activés' : 'Signaux sonores coupés (vibrations conservées)');
}

function updateSoundMenuLabel() {
  document.querySelector('[data-action="sound"]').innerHTML =
    soundOn ? '🔔&nbsp;&nbsp;Signaux sonores : oui' : '🔕&nbsp;&nbsp;Signaux sonores : non';
}

// ═══════════════════════════ UI : MODAL / MENU / TOAST ═══════════════════════════

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add('hidden'), 4000);
}

// dismissable: false → ni un tap à côté ni le bouton retour ne ferment la fenêtre
function showModal(title, bodyHtml, buttons, { dismissable = true } = {}) {
  modalDismissable = dismissable;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const actions = document.getElementById('modal-actions');
  actions.innerHTML = '';
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.danger) btn.className = 'danger';
    btn.onclick = () => { hideModal(); if (b.onClick) b.onClick(); };
    actions.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}

let modalDismissable = true;

function hideModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

function toggleMenu(show) { document.getElementById('menu-overlay').classList.toggle('hidden', !show); }

function confirmReset() {
  showModal('Reset', 'Effacer le match en cours ?', [
    { label: 'Annuler' },
    { label: 'Reset', danger: true, onClick: resetMatch },
  ]);
}

function confirmBlackCard(fighterId) {
  const fighter = fighterId === 1 ? state.fighter1 : state.fighter2;
  showModal('Carton Noir', `Exclure ${fighter.name} ?`, [
    { label: 'Annuler' },
    { label: 'Confirmer', danger: true, onClick: () => addCard(fighterId, 'black') },
  ]);
}

// ═══════════════════════════ HISTORIQUE : UI ═══════════════════════════

let historyRecords = [];
let historyDetailId = null;

async function openHistory() {
  historyRecords = await getAllMatchRecords();
  historyRecords.sort((a, b) => b.savedAt - a.savedAt);
  renderHistoryList();
  document.getElementById('history-overlay').classList.remove('hidden');
}

function closeHistory() {
  document.getElementById('history-overlay').classList.add('hidden');
}

function renderHistoryList() {
  const container = document.getElementById('history-list');
  container.innerHTML = '';
  if (historyRecords.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-log-empty';
    empty.textContent = 'Aucun match enregistré';
    container.appendChild(empty);
    return;
  }
  historyRecords.forEach((rec) => {
    const row = document.createElement('button');
    row.className = 'history-row';
    row.dataset.id = rec.id;
    const winnerLabel = rec.winner && rec.winner !== 'Égalité' ? `Vainqueur : ${rec.winner}` : 'Égalité';
    row.innerHTML = `
      <span class="history-row-date">${rec.dateStr} ${rec.heureStr}</span>
      <span class="history-row-names">${rec.fighter1Name} <b>${rec.score1}</b> — <b>${rec.score2}</b> ${rec.fighter2Name}</span>
      <span class="history-row-winner">${winnerLabel}</span>
    `;
    container.appendChild(row);
  });
}

function openHistoryDetail(id) {
  const rec = historyRecords.find((r) => r.id === id);
  if (!rec) return;
  historyDetailId = id;
  document.getElementById('history-detail-title').textContent =
    `${rec.dateStr} ${rec.heureStr} — ${rec.fighter1Name} ${rec.score1} / ${rec.score2} ${rec.fighter2Name}`;
  renderEventLog(document.getElementById('history-detail-log'), rec.events);
  document.getElementById('history-detail-overlay').classList.remove('hidden');
}

function closeHistoryDetail() {
  document.getElementById('history-detail-overlay').classList.add('hidden');
  historyDetailId = null;
}

function exportHistoryEntry(id) {
  const rec = historyRecords.find((r) => r.id === id);
  if (!rec) return;
  try {
    const filename = downloadCsv(rec);
    showToast(`CSV exporté : ${filename}`);
  } catch (e) {
    showToast(`Erreur export : ${e}`);
  }
}

async function deleteHistoryEntry(id) {
  await deleteMatchRecord(id);
  historyRecords = historyRecords.filter((r) => r.id !== id);
  renderHistoryList();
  closeHistoryDetail();
  showToast("Match supprimé de l'historique");
}

function confirmDeleteHistoryEntry(id) {
  showModal('Supprimer', 'Supprimer ce match de l\'historique ?', [
    { label: 'Annuler' },
    { label: 'Supprimer', danger: true, onClick: () => deleteHistoryEntry(id) },
  ]);
}

function confirmClearHistory() {
  if (historyRecords.length === 0) return;
  showModal("Vider l'historique", 'Supprimer tous les matchs enregistrés ? Cette action est irréversible.', [
    { label: 'Annuler' },
    { label: 'Vider', danger: true, onClick: async () => {
      await clearMatchHistory();
      historyRecords = [];
      renderHistoryList();
      showToast('Historique vidé');
    } },
  ]);
}

// ═══════════════════════════ STATISTIQUES ═══════════════════════════

const ZONE_LABELS = { A: 'Zone A (1 pt)', B: 'Zone B (3 pts)', C: 'Zone C (5 pts)' };
const ZONE_COLORS = { A: '#43A047', B: '#FFB300', C: '#E53935' };
const CARD_LABELS = { white: 'Blanc', yellow: 'Jaune', red: 'Rouge', black: 'Noir' };
const CARD_COLORS = { white: '#FFFFFF', yellow: '#FFEB3B', red: '#E53935', black: '#000000' };

function computeStats(records) {
  const s = {
    totalMatches: records.length,
    winsRed: 0, winsGreen: 0, ties: 0,
    totalScoreRed: 0, totalScoreGreen: 0,
    totalDurationS: 0,
    suddenDeathMatches: 0,
    zoneCounts: { A: 0, B: 0, C: 0 },
    cardCounts: { white: 0, yellow: 0, red: 0, black: 0 },
  };

  records.forEach((rec) => {
    if (rec.winner === rec.fighter1Name) s.winsRed++;
    else if (rec.winner === rec.fighter2Name) s.winsGreen++;
    else s.ties++;

    s.totalScoreRed += rec.score1;
    s.totalScoreGreen += rec.score2;
    s.totalDurationS += rec.durationS;

    if (rec.events.some((e) => !e.cancelled && e.isSuddenDeath)) s.suddenDeathMatches++;

    rec.events.forEach((e) => {
      if (e.cancelled) return;
      if (e.type === 'touche' && e.zone) s.zoneCounts[e.zone]++;
      if (e.type === 'carton' && e.carton) s.cardCounts[e.carton]++;
    });
  });

  return s;
}

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${pad2(s)}`;
}

function statTile(label, value) {
  const tile = document.createElement('div');
  tile.className = 'stat-tile';
  const lbl = document.createElement('div');
  lbl.className = 'stat-tile-label';
  lbl.textContent = label;
  const val = document.createElement('div');
  val.className = 'stat-tile-value';
  val.textContent = value;
  tile.append(lbl, val);
  return tile;
}

function statBarRow(label, value, max, color, extraClass) {
  const row = document.createElement('div');
  row.className = 'stat-bar-row';

  const lbl = document.createElement('span');
  lbl.className = 'stat-bar-label';
  lbl.textContent = label;

  const track = document.createElement('div');
  track.className = 'stat-bar-track';
  const fill = document.createElement('div');
  fill.className = 'stat-bar-fill' + (extraClass ? ` ${extraClass}` : '');
  fill.style.background = color;
  fill.style.width = max > 0 ? `${Math.max((value / max) * 100, value > 0 ? 3 : 0)}%` : '0%';
  track.appendChild(fill);

  const val = document.createElement('span');
  val.className = 'stat-bar-value';
  val.textContent = String(value);

  row.append(lbl, track, val);
  return row;
}

function renderCardBreakdown(container, cardCounts, title) {
  const cardTotal = cardCounts.white + cardCounts.yellow + cardCounts.red + cardCounts.black;
  if (cardTotal === 0) return;
  const cardSection = document.createElement('div');
  cardSection.className = 'stats-section';
  const cardTitle = document.createElement('div');
  cardTitle.className = 'stats-section-title';
  cardTitle.textContent = title;
  cardSection.appendChild(cardTitle);
  const cardMax = Math.max(cardCounts.white, cardCounts.yellow, cardCounts.red, cardCounts.black, 1);
  ['white', 'yellow', 'red', 'black'].forEach((color) => {
    const extraClass = color === 'black' && cardCounts.black > 0 ? 'black-fill' : undefined;
    cardSection.appendChild(statBarRow(CARD_LABELS[color], cardCounts[color], cardMax, CARD_COLORS[color], extraClass));
  });
  container.appendChild(cardSection);
}

function renderZoneBreakdown(container, zoneCounts, title) {
  const zoneSection = document.createElement('div');
  zoneSection.className = 'stats-section';
  const zoneTitle = document.createElement('div');
  zoneTitle.className = 'stats-section-title';
  zoneTitle.textContent = title;
  zoneSection.appendChild(zoneTitle);
  const zoneMax = Math.max(zoneCounts.A, zoneCounts.B, zoneCounts.C, 1);
  ['C', 'B', 'A'].forEach((zone) => {
    zoneSection.appendChild(statBarRow(ZONE_LABELS[zone], zoneCounts[zone], zoneMax, ZONE_COLORS[zone]));
  });
  container.appendChild(zoneSection);
}

function zoneHeatColor(count, maxZone) {
  if (count === 0) return 'rgba(255,255,255,0.08)';
  const intensity = maxZone > 0 ? count / maxZone : 0;
  const opacity = (0.3 + 0.6 * intensity).toFixed(2);
  return `rgba(255,152,0,${opacity})`; // ramp mono-teinte sur #FF9800
}

function renderZoneHeatmap(container, zoneCounts, title) {
  const section = document.createElement('div');
  section.className = 'stats-section';
  const heading = document.createElement('div');
  heading.className = 'stats-section-title';
  heading.textContent = title;
  section.appendChild(heading);

  const maxZone = Math.max(zoneCounts.A, zoneCounts.B, zoneCounts.C);
  const colorC = zoneHeatColor(zoneCounts.C, maxZone);
  const colorB = zoneHeatColor(zoneCounts.B, maxZone);
  const colorA = zoneHeatColor(zoneCounts.A, maxZone);

  const wrap = document.createElement('div');
  wrap.className = 'zone-heatmap-wrap';
  wrap.innerHTML = `
    <svg class="zone-heatmap-svg" viewBox="0 0 140 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Silhouette du combattant colorée selon les zones les plus touchées">
      <line x1="46" y1="54" x2="20" y2="120" stroke="${colorB}" stroke-width="16" stroke-linecap="round"/>
      <line x1="94" y1="54" x2="120" y2="120" stroke="${colorB}" stroke-width="16" stroke-linecap="round"/>
      <line x1="58" y1="118" x2="46" y2="220" stroke="${colorB}" stroke-width="18" stroke-linecap="round"/>
      <line x1="82" y1="118" x2="94" y2="220" stroke="${colorB}" stroke-width="18" stroke-linecap="round"/>
      <ellipse cx="44" cy="228" rx="14" ry="7" fill="${colorB}"/>
      <ellipse cx="96" cy="228" rx="14" ry="7" fill="${colorB}"/>
      <rect x="40" y="44" width="60" height="80" rx="18" fill="${colorC}"/>
      <circle cx="70" cy="24" r="18" fill="${colorC}"/>
      <circle cx="16" cy="126" r="10" fill="${colorA}"/>
      <circle cx="124" cy="126" r="10" fill="${colorA}"/>
    </svg>
  `;
  section.appendChild(wrap);

  const total = zoneCounts.A + zoneCounts.B + zoneCounts.C;
  const legend = document.createElement('div');
  legend.className = 'stats-legend';
  const items = [
    { label: 'Tête, torse, épaules, dos', count: zoneCounts.C, color: colorC },
    { label: 'Bras, jambes, pieds', count: zoneCounts.B, color: colorB },
    { label: 'Mains, poignée', count: zoneCounts.A, color: colorA },
  ];
  items.forEach((item) => {
    const li = document.createElement('div');
    li.className = 'stats-legend-item';
    const dot = document.createElement('span');
    dot.className = 'stats-legend-dot';
    dot.style.background = item.color;
    const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
    const txt = document.createElement('span');
    txt.textContent = `${item.label} : ${item.count} (${pct}%)`;
    li.append(dot, txt);
    legend.appendChild(li);
  });
  section.appendChild(legend);
  container.appendChild(section);
}

function renderClubStats(container, stats) {
  container.innerHTML = '';

  if (stats.totalMatches === 0) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty';
    empty.textContent = 'Aucun match enregistré pour le moment.';
    container.appendChild(empty);
    return;
  }

  const avgScore = (stats.totalScoreRed + stats.totalScoreGreen) / (2 * stats.totalMatches);
  const avgDurationS = stats.totalDurationS / stats.totalMatches;
  const suddenDeathPct = Math.round((stats.suddenDeathMatches / stats.totalMatches) * 100);

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'stats-kpi-grid';
  kpiGrid.append(
    statTile('Matchs joués', String(stats.totalMatches)),
    statTile('Score moyen / combattant', avgScore.toFixed(1)),
    statTile('Durée moyenne', formatDuration(avgDurationS)),
    statTile('Mort subite', `${suddenDeathPct}%`),
  );
  container.appendChild(kpiGrid);

  // ── victoires ──
  const winsSection = document.createElement('div');
  winsSection.className = 'stats-section';
  const winsTitle = document.createElement('div');
  winsTitle.className = 'stats-section-title';
  winsTitle.textContent = 'Victoires';
  winsSection.appendChild(winsTitle);

  const total = stats.totalMatches;
  const bar = document.createElement('div');
  bar.className = 'stats-stacked-bar';
  const segments = [
    { count: stats.winsRed, color: '#E53935' },
    { count: stats.winsGreen, color: '#43A047' },
    { count: stats.ties, color: 'rgba(255,255,255,0.24)' },
  ];
  segments.forEach((seg) => {
    if (seg.count === 0) return;
    const el = document.createElement('div');
    el.className = 'stats-stacked-seg';
    el.style.background = seg.color;
    el.style.flex = `${seg.count} 0 0`;
    bar.appendChild(el);
  });
  winsSection.appendChild(bar);

  const legend = document.createElement('div');
  legend.className = 'stats-legend';
  const legendItems = [
    { label: 'Combattant rouge', count: stats.winsRed, color: '#E53935' },
    { label: 'Combattant vert', count: stats.winsGreen, color: '#43A047' },
    { label: 'Égalité', count: stats.ties, color: 'rgba(255,255,255,0.24)' },
  ];
  legendItems.forEach((item) => {
    const li = document.createElement('div');
    li.className = 'stats-legend-item';
    const dot = document.createElement('span');
    dot.className = 'stats-legend-dot';
    dot.style.background = item.color;
    const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
    const txt = document.createElement('span');
    txt.textContent = `${item.label} : ${item.count} (${pct}%)`;
    li.append(dot, txt);
    legend.appendChild(li);
  });
  winsSection.appendChild(legend);
  container.appendChild(winsSection);

  renderZoneBreakdown(container, stats.zoneCounts, 'Touches par zone');
  renderCardBreakdown(container, stats.cardCounts, 'Cartons');
}

// ── statistiques par combattant ──

function normalizeName(name) {
  return (name || '').trim().replace(/\s+/g, ' ');
}

function computeFighterRoster(records) {
  const roster = new Map(); // key: nom normalisé (lowercase) -> { displayName, entries: [{record, side}] }
  records.forEach((rec) => {
    [1, 2].forEach((side) => {
      const name = normalizeName(side === 1 ? rec.fighter1Name : rec.fighter2Name);
      if (!name) return;
      const key = name.toLowerCase();
      if (!roster.has(key)) roster.set(key, { displayName: name, entries: [] });
      roster.get(key).entries.push({ record: rec, side });
    });
  });
  return roster;
}

function computeFighterStats(entries) {
  const s = {
    matches: entries.length,
    wins: 0, losses: 0, ties: 0,
    totalScoreFor: 0, totalScoreAgainst: 0,
    zoneCounts: { A: 0, B: 0, C: 0 },
    cardCounts: { white: 0, yellow: 0, red: 0, black: 0 },
    opponents: new Map(), // nom adversaire -> { matches, wins, losses, ties }
  };

  entries.forEach(({ record, side }) => {
    const myName = side === 1 ? record.fighter1Name : record.fighter2Name;
    const oppName = side === 1 ? record.fighter2Name : record.fighter1Name;
    s.totalScoreFor += side === 1 ? record.score1 : record.score2;
    s.totalScoreAgainst += side === 1 ? record.score2 : record.score1;

    let outcome = 'tie';
    if (record.winner === myName) { s.wins++; outcome = 'win'; }
    else if (record.winner === oppName) { s.losses++; outcome = 'loss'; }
    else { s.ties++; }

    const oppKey = normalizeName(oppName) || '—';
    if (!s.opponents.has(oppKey)) s.opponents.set(oppKey, { matches: 0, wins: 0, losses: 0, ties: 0 });
    const o = s.opponents.get(oppKey);
    o.matches++;
    if (outcome === 'win') o.wins++;
    else if (outcome === 'loss') o.losses++;
    else o.ties++;

    record.events.forEach((e) => {
      if (e.cancelled || e.fighterId !== side) return;
      if (e.type === 'touche' && e.zone) s.zoneCounts[e.zone]++;
      if (e.type === 'carton' && e.carton) s.cardCounts[e.carton]++;
    });
  });

  return s;
}

function renderFightersList(container) {
  container.innerHTML = '';
  const roster = computeFighterRoster(statsRecords);

  if (roster.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty';
    empty.textContent = "Aucun combattant nommé pour le moment. Touchez le nom d'un combattant avant un match pour le renseigner.";
    container.appendChild(empty);
    return;
  }

  const rows = [...roster.entries()]
    .map(([key, data]) => ({ key, displayName: data.displayName, stats: computeFighterStats(data.entries) }))
    .sort((a, b) => b.stats.matches - a.stats.matches || a.displayName.localeCompare(b.displayName, 'fr'));

  const list = document.createElement('div');
  list.className = 'fighters-list';
  rows.forEach(({ key, displayName, stats }) => {
    const winRate = stats.matches > 0 ? Math.round((stats.wins / stats.matches) * 100) : 0;
    const row = document.createElement('button');
    row.className = 'fighter-row';
    row.dataset.key = key;

    const main = document.createElement('div');
    main.className = 'fighter-row-main';
    const nameEl = document.createElement('span');
    nameEl.className = 'fighter-row-name';
    nameEl.textContent = displayName;
    const recordEl = document.createElement('span');
    recordEl.className = 'fighter-row-record';
    recordEl.textContent = `${stats.matches} match${stats.matches > 1 ? 's' : ''} · ${stats.wins}V / ${stats.losses}D / ${stats.ties}N`;
    main.append(nameEl, recordEl);

    const winRateEl = document.createElement('span');
    winRateEl.className = 'fighter-row-winrate';
    winRateEl.textContent = `${winRate}%`;

    row.append(main, winRateEl);
    list.appendChild(row);
  });
  container.appendChild(list);

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.fighter-row');
    if (!row) return;
    statsSelectedFighter = row.dataset.key;
    renderStatsBody();
  });
}

function renderFighterDetail(container, key) {
  container.innerHTML = '';
  const roster = computeFighterRoster(statsRecords);
  const data = roster.get(key);
  if (!data) { statsSelectedFighter = null; renderFightersList(container); return; }
  const stats = computeFighterStats(data.entries);

  const back = document.createElement('button');
  back.className = 'text-btn stats-back-btn';
  back.textContent = '← Tous les combattants';
  back.addEventListener('click', () => { statsSelectedFighter = null; renderStatsBody(); });
  container.appendChild(back);

  const title = document.createElement('div');
  title.className = 'stats-fighter-title';
  title.textContent = data.displayName;
  container.appendChild(title);

  const winRate = stats.matches > 0 ? Math.round((stats.wins / stats.matches) * 100) : 0;
  const avgFor = stats.matches > 0 ? stats.totalScoreFor / stats.matches : 0;
  const avgAgainst = stats.matches > 0 ? stats.totalScoreAgainst / stats.matches : 0;

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'stats-kpi-grid';
  kpiGrid.append(
    statTile('Matchs', String(stats.matches)),
    statTile('Victoires', `${stats.wins} (${winRate}%)`),
    statTile('Score moyen marqué', avgFor.toFixed(1)),
    statTile('Score moyen concédé', avgAgainst.toFixed(1)),
  );
  container.appendChild(kpiGrid);

  renderZoneHeatmap(container, stats.zoneCounts, 'Zones touchées');
  renderCardBreakdown(container, stats.cardCounts, 'Cartons reçus');

  const oppSection = document.createElement('div');
  oppSection.className = 'stats-section';
  const oppTitle = document.createElement('div');
  oppTitle.className = 'stats-section-title';
  oppTitle.textContent = 'Adversaires affrontés';
  oppSection.appendChild(oppTitle);
  const oppList = document.createElement('div');
  oppList.className = 'opponents-list';
  [...stats.opponents.entries()]
    .sort((a, b) => b[1].matches - a[1].matches)
    .forEach(([oppName, rec]) => {
      const row = document.createElement('div');
      row.className = 'opponent-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'opponent-name';
      nameEl.textContent = oppName;
      const recordEl = document.createElement('span');
      recordEl.className = 'opponent-record';
      recordEl.textContent = `${rec.matches} match${rec.matches > 1 ? 's' : ''} · ${rec.wins}V / ${rec.losses}D / ${rec.ties}N`;
      row.append(nameEl, recordEl);
      oppList.appendChild(row);
    });
  oppSection.appendChild(oppList);
  container.appendChild(oppSection);
}

let statsRecords = [];
let statsActiveTab = 'club';
let statsSelectedFighter = null;

function renderStatsBody() {
  document.getElementById('tab-stats-club').classList.toggle('active', statsActiveTab === 'club');
  document.getElementById('tab-stats-fighters').classList.toggle('active', statsActiveTab === 'fighters');
  const body = document.getElementById('stats-body');
  if (statsActiveTab === 'club') {
    renderClubStats(body, computeStats(statsRecords));
  } else if (statsSelectedFighter) {
    renderFighterDetail(body, statsSelectedFighter);
  } else {
    renderFightersList(body);
  }
}

async function openStats() {
  statsRecords = await getAllMatchRecords();
  statsActiveTab = 'club';
  statsSelectedFighter = null;
  renderStatsBody();
  document.getElementById('stats-overlay').classList.remove('hidden');
}

function closeStats() {
  document.getElementById('stats-overlay').classList.add('hidden');
}

// ═══════════════════════════ NOM DES COMBATTANTS ═══════════════════════════

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ═══════════════════════════ INFORMATIONS ═══════════════════════════

const INFO_RECENT_RELEASES = 3; // mises à jour détaillées ; les plus anciennes sont repliées

function renderReleaseNotes(release) {
  const notes = release.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  return `<div class="info-release-head"><b>${release.version}</b> · ${escapeHtml(release.title)}`
    + `<span class="info-release-date">${formatDateFr(release.date)}</span></div><ul>${notes}</ul>`;
}

function openInfo() {
  const latest = APP_RELEASES[0];
  const recent = APP_RELEASES.slice(0, INFO_RECENT_RELEASES)
    .map((r) => `<div class="info-release">${renderReleaseNotes(r)}</div>`).join('');
  const older = APP_RELEASES.slice(INFO_RECENT_RELEASES)
    .map((r) => `<div class="info-release">${renderReleaseNotes(r)}</div>`).join('');

  document.getElementById('info-body').innerHTML = `
    <div class="info-app">AppASL — Scoring Sabre Laser<span>ASL Reims</span></div>
    <div class="stats-kpi-grid">
      <div class="stat-tile"><div class="stat-tile-label">Version actuelle</div><div class="stat-tile-value" id="info-version">${latest.version}</div></div>
      <div class="stat-tile"><div class="stat-tile-label">Dernière version</div><div class="stat-tile-value info-date" id="info-date">${formatDateFr(latest.date)}</div></div>
    </div>
    <div class="stats-section">
      <div class="stats-section-title">Dernières mises à jour</div>
      ${recent}
      ${older ? `<details class="info-older"><summary>Versions précédentes</summary>${older}</details>` : ''}
    </div>
    <div class="stats-section">
      <div class="stats-section-title">Auteur</div>
      <div class="info-author" id="info-author">${escapeHtml(APP_AUTHOR)}</div>
    </div>`;
  document.getElementById('info-body').scrollTop = 0;
  document.getElementById('info-overlay').classList.remove('hidden');
}

function closeInfo() { document.getElementById('info-overlay').classList.add('hidden'); }

const DEFAULT_NAMES = { 1: 'Combattant rouge', 2: 'Combattant vert' };

// noms déjà utilisés, du plus récent au plus ancien
async function recentFighterNames(limit = 12) {
  const records = (await getAllMatchRecords()).sort((x, y) => y.savedAt - x.savedAt);
  const seen = new Map();
  const defaults = new Set(Object.values(DEFAULT_NAMES).map((n) => n.toLowerCase()));
  records.forEach((r) => [r.fighter1Name, r.fighter2Name].forEach((raw) => {
    const n = normalizeName(raw);
    if (n && !defaults.has(n.toLowerCase()) && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }));
  return [...seen.values()].slice(0, limit);
}

// Saisie des deux noms d'un coup. Pas de focus automatique : le clavier masquerait
// les noms récents, qui se choisissent d'un tap.
async function promptNames(focusId = 1) {
  if (state.status !== 'idle') return;
  const recent = await recentFighterNames();
  const value = (id) => {
    const f = id === 1 ? state.fighter1 : state.fighter2;
    return f.name === DEFAULT_NAMES[id] ? '' : f.name;
  };
  const chips = recent.map((n) => `<button type="button" class="name-chip">${escapeHtml(n)}</button>`).join('');

  showModal('Combattants', `
    <label class="name-field red"><span>Rouge</span>
      <input id="name-input-1" type="text" maxlength="24" autocomplete="off" value="${escapeHtml(value(1))}" placeholder="${DEFAULT_NAMES[1]}">
    </label>
    <button type="button" id="btn-swap-names" class="text-btn swap-btn">⇅ Inverser</button>
    <label class="name-field green"><span>Vert</span>
      <input id="name-input-2" type="text" maxlength="24" autocomplete="off" value="${escapeHtml(value(2))}" placeholder="${DEFAULT_NAMES[2]}">
    </label>
    ${chips ? `<div class="name-chips-title">Noms récents</div><div class="name-chips">${chips}</div>` : ''}
  `, [
    { label: 'Annuler' },
    { label: 'Valider', onClick: () => {
      [1, 2].forEach((id) => {
        const f = id === 1 ? state.fighter1 : state.fighter2;
        f.name = normalizeName(document.getElementById(`name-input-${id}`).value) || DEFAULT_NAMES[id];
      });
      render();
    } },
  ]);

  const inputs = { 1: document.getElementById('name-input-1'), 2: document.getElementById('name-input-2') };
  let target = focusId;
  inputs[target].classList.add('target');
  const setTarget = (id) => {
    target = id;
    inputs[1].classList.toggle('target', id === 1);
    inputs[2].classList.toggle('target', id === 2);
  };
  inputs[1].addEventListener('focus', () => setTarget(1));
  inputs[2].addEventListener('focus', () => setTarget(2));
  document.getElementById('btn-swap-names').addEventListener('click', () => {
    [inputs[1].value, inputs[2].value] = [inputs[2].value, inputs[1].value];
  });
  document.querySelectorAll('#modal-body .name-chip').forEach((chip) => chip.addEventListener('click', () => {
    inputs[target].value = chip.textContent;
    const other = target === 1 ? 2 : 1;
    if (!inputs[other].value) setTarget(other); // enchaîne sur le champ encore vide
  }));
}

function doToss() {
  const redWins = Math.random() < 0.5;
  const winnerName = redWins ? state.fighter1.name : state.fighter2.name;
  showModal(
    'Toss — Pile ou Face',
    `<span class="toss-emoji">⚔️</span><span class="toss-winner" style="color:${redWins ? '#ef5350' : '#66bb6a'}">${winnerName}</span>`,
    [{ label: 'OK' }],
  );
}

// ═══════════════════════════ MATCH EN COURS : SAUVEGARDE / REPRISE ═══════════════════════════
// Le match en cours est recopié à chaque rendu : un rechargement, un appel entrant ou un
// onglet fermé par le téléphone ne doit pas faire perdre le match.

const LIVE_MATCH_KEY = 'appasl-live-match';
let liveRestorePending = false; // ne pas écraser la sauvegarde tant que l'arbitre n'a pas choisi

function persistLiveMatch() {
  if (liveRestorePending) return;
  try {
    if (!isMatchLive()) { localStorage.removeItem(LIVE_MATCH_KEY); return; }
    localStorage.setItem(LIVE_MATCH_KEY, JSON.stringify({
      v: 1,
      fighter1: state.fighter1,
      fighter2: state.fighter2,
      remainingMs: currentRemainingMs(),
      elapsedMs: elapsedSeconds() * 1000,
      matchStartTime: state.matchStartTime ? state.matchStartTime.getTime() : null,
      salveFighter: state.salveFighter,
      salveMax: state.salveMax,
      salveHitCount: state.salveHitCount,
      salveZones: state.salveZones,
      undoStack: state.undoStack,
      events: state.events,
      matchId: state.matchId,
    }));
  } catch (e) { /* stockage indisponible (navigation privée) : on continue sans */ }
}

function readLiveMatch() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIVE_MATCH_KEY));
    return saved && saved.v === 1 && saved.matchId ? saved : null;
  } catch (e) { return null; }
}

function restoreLiveMatch(saved) {
  Object.assign(state.fighter1, saved.fighter1);
  Object.assign(state.fighter2, saved.fighter2);
  Object.assign(state, {
    status: 'paused', // l'arbitre relance le chrono lui-même
    remainingMs: saved.remainingMs,
    timerEndsAt: null,
    runningSince: null,
    elapsedMs: saved.elapsedMs,
    matchStartTime: saved.matchStartTime ? new Date(saved.matchStartTime) : new Date(),
    salveFighter: saved.salveFighter,
    salveMax: saved.salveMax,
    salveHitCount: saved.salveHitCount,
    salveZones: saved.salveZones,
    undoStack: saved.undoStack || [],
    events: saved.events,
    winner: null,
    matchId: saved.matchId,
  });
  addTimestampEvent('Match restauré', 'chrono');
  render();
}

function offerLiveMatchRestore() {
  const saved = readLiveMatch();
  if (!saved) return;
  liveRestorePending = true;
  const m = Math.floor(Math.ceil(saved.remainingMs / 1000) / 60);
  const s = Math.ceil(saved.remainingMs / 1000) % 60;
  showModal('Match en cours retrouvé', `
    <b>${escapeHtml(saved.fighter1.name)}</b> ${saved.fighter1.score} — ${saved.fighter2.score} <b>${escapeHtml(saved.fighter2.name)}</b><br>
    Chrono arrêté à ${m}:${pad2(s)}. Reprendre ce match ?
  `, [
    { label: 'Abandonner', danger: true, onClick: () => { liveRestorePending = false; render(); } },
    { label: 'Reprendre', onClick: () => { liveRestorePending = false; restoreLiveMatch(saved); } },
  ], { dismissable: false });
}

// ═══════════════════════════ ÉCRAN MAINTENU ALLUMÉ ═══════════════════════════

let wakeLock = null;
let wakeLockPending = false;

async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  const wanted = isMatchLive() && document.visibilityState === 'visible';
  if (wanted && !wakeLock && !wakeLockPending) {
    wakeLockPending = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* refusé (économie d'énergie) : sans conséquence sur le match */ }
    wakeLockPending = false;
  } else if (!wanted && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ═══════════════════════════ BOUTON RETOUR (ANDROID) ═══════════════════════════
// Une entrée d'historique « tampon » absorbe le retour : il ferme le panneau ouvert au lieu
// de quitter l'app. Elle est (ré)armée sur un tap, car Chrome ignore les entrées ajoutées
// sans geste de l'utilisateur.

let backArmed = false;

function armBack() {
  if (backArmed) return;
  history.pushState({ appasl: true }, '');
  backArmed = true;
}

function isShown(id) { return !document.getElementById(id).classList.contains('hidden'); }

function closeTopLayer() {
  if (isShown('modal-overlay')) { if (modalDismissable) hideModal(); return true; }
  if (isShown('menu-overlay')) { toggleMenu(false); return true; }
  if (isShown('log-overlay')) { closeLog(); return true; }
  if (isShown('info-overlay')) { closeInfo(); return true; }
  if (isShown('history-detail-overlay')) { closeHistoryDetail(); return true; }
  if (isShown('stats-overlay')) { closeStats(); return true; }
  if (isShown('history-overlay')) { closeHistory(); return true; }
  return false;
}

window.addEventListener('popstate', () => {
  backArmed = false;
  if (closeTopLayer()) return;
  if (isMatchLive()) showToast('Match en cours : il reste enregistré si vous quittez l\'app.');
});

// ═══════════════════════════ LIAISON DES ÉVÉNEMENTS DOM ═══════════════════════════

document.addEventListener('click', armBack, true);
document.addEventListener('click', unlockAudio, true);

document.getElementById('event-log').addEventListener('click', () => { if (state.events.length) openLog(); });
document.getElementById('btn-log-close').addEventListener('click', closeLog);
document.getElementById('btn-info-close').addEventListener('click', closeInfo);
document.getElementById('info-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'info-overlay') closeInfo();
});
document.getElementById('log-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'log-overlay') closeLog();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    render();
    if (swRegistration) swRegistration.update().catch(() => {});
  } else {
    updateWakeLock();
  }
});

document.getElementById('btn-reset-timer').addEventListener('click', resetTimer);
document.getElementById('btn-add-time').addEventListener('click', () => addTime(30));
document.getElementById('btn-play-pause').addEventListener('click', startStop);

document.getElementById('btn-validate').addEventListener('click', commitSalve);
document.getElementById('btn-cancel-salve').addEventListener('click', cancelPendingSalve);
document.getElementById('btn-undo').addEventListener('click', undoLastAction);
document.getElementById('btn-undo-result').addEventListener('click', undoLastAction);

document.getElementById('btn-export-result').addEventListener('click', exportCsv);
document.getElementById('btn-history-result').addEventListener('click', openHistory);
document.getElementById('btn-new-match').addEventListener('click', () => { resetMatch(); promptNames(1); });

[1, 2].forEach((id) => {
  document.getElementById(`zones-${id}`).addEventListener('click', (e) => {
    const btn = e.target.closest('.zone-btn');
    if (btn && !btn.disabled) hitZone(id, btn.dataset.zone);
  });
  document.getElementById(`card-buttons-${id}`).addEventListener('click', (e) => {
    const btn = e.target.closest('.mini-card');
    if (!btn) return;
    const color = btn.dataset.card;
    if (color === 'black') confirmBlackCard(id);
    else addCard(id, color);
  });
  document.getElementById(`name-${id}`).addEventListener('click', () => promptNames(id));
});

document.getElementById('btn-menu').addEventListener('click', () => toggleMenu(true));
document.getElementById('menu-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'menu-overlay') { toggleMenu(false); return; }
  const action = e.target.dataset.action;
  if (!action) return;
  toggleMenu(false);
  if (action === 'toss') doToss();
  else if (action === 'export') exportCsv();
  else if (action === 'history') openHistory();
  else if (action === 'stats') openStats();
  else if (action === 'sound') toggleSound();
  else if (action === 'info') openInfo();
  else if (action === 'reset') confirmReset();
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay' && modalDismissable) hideModal();
});

document.getElementById('btn-history-close').addEventListener('click', closeHistory);
document.getElementById('history-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'history-overlay') closeHistory();
});
document.getElementById('history-list').addEventListener('click', (e) => {
  const row = e.target.closest('.history-row');
  if (row) openHistoryDetail(row.dataset.id);
});
document.getElementById('btn-history-clear').addEventListener('click', confirmClearHistory);
document.getElementById('btn-history-stats').addEventListener('click', () => { closeHistory(); openStats(); });

document.getElementById('btn-history-detail-close').addEventListener('click', closeHistoryDetail);
document.getElementById('history-detail-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'history-detail-overlay') closeHistoryDetail();
});
document.getElementById('btn-history-detail-export').addEventListener('click', () => exportHistoryEntry(historyDetailId));
document.getElementById('btn-history-detail-delete').addEventListener('click', () => confirmDeleteHistoryEntry(historyDetailId));

document.getElementById('btn-stats-close').addEventListener('click', closeStats);
document.getElementById('stats-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'stats-overlay') closeStats();
});
document.getElementById('tab-stats-club').addEventListener('click', () => {
  statsActiveTab = 'club';
  statsSelectedFighter = null;
  renderStatsBody();
});
document.getElementById('tab-stats-fighters').addEventListener('click', () => {
  statsActiveTab = 'fighters';
  statsSelectedFighter = null;
  renderStatsBody();
});

// empêche le pull-to-refresh / zoom accidentel pendant le match
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

// ═══════════════════════════ PWA : SERVICE WORKER ═══════════════════════════

// Une nouvelle version prend la main en arrière-plan : on le signale au lieu de laisser
// l'arbitre sur l'ancienne sans le savoir (le rechargement est sûr, le match est sauvegardé).
let swRegistration = null;

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) document.getElementById('update-banner').classList.remove('hidden');
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => { swRegistration = reg; }).catch(() => {});
  });
}

document.getElementById('btn-update-reload').addEventListener('click', () => location.reload());

// ═══════════════════════════ INIT ═══════════════════════════

updateSoundMenuLabel();
offerLiveMatchRestore();
render();
