'use strict';

// ═══════════════════════════ ÉTAT ═══════════════════════════

function newFighter(name) {
  return { name, score: 0, whiteCards: 0, yellowCards: 0, hasRed: false, isExcluded: false };
}

const state = {
  fighter1: newFighter('Combattant rouge'),
  fighter2: newFighter('Combattant vert'),
  status: 'idle', // idle | running | paused | finished
  remainingSeconds: 180,
  timerId: null,
  matchStartTime: null,
  salveFighter: null,
  salveMax: 0,
  salveHitCount: 0,
  salveZones: [],
  lastSnapshot: null,
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

function elapsedSeconds() { return 180 - state.remainingSeconds; }

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
  state.lastSnapshot = {
    f1: { ...state.fighter1 },
    f2: { ...state.fighter2 },
    status: state.status,
    winner: state.winner,
    eventCountBefore: state.events.length,
  };
}

function canUndo() { return state.lastSnapshot !== null; }

function undoLastAction() {
  const snap = state.lastSnapshot;
  if (!snap) return;

  Object.assign(state.fighter1, snap.f1);
  Object.assign(state.fighter2, snap.f2);

  for (let i = snap.eventCountBefore; i < state.events.length; i++) {
    state.events[i].cancelled = true;
  }

  const wasFinished = state.status === 'finished';
  state.status = snap.status;
  state.winner = snap.winner;

  if (wasFinished && snap.status === 'running') {
    startTimer();
  }

  state.lastSnapshot = null;
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

function resetTimer() {
  state.remainingSeconds = 180;
  render();
}

function addTime(seconds) {
  state.remainingSeconds = Math.min(599, Math.max(0, state.remainingSeconds + seconds));
  render();
}

function startTimer() {
  state.status = 'running';
  clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    if (state.remainingSeconds > 0) {
      state.remainingSeconds--;
      render();
    } else {
      endMatch(true);
    }
  }, 1000);
  render();
}

function pauseTimer() {
  state.status = 'paused';
  clearInterval(state.timerId);
  render();
}

function endMatch() {
  clearInterval(state.timerId);
  commitSalveInternal();
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

function hitZone(fighterId, zone) {
  if (state.status !== 'running') return;
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
  if (state.status !== 'running') return;
  const fighter = fighterId === 1 ? state.fighter1 : state.fighter2;
  const opponent = fighterId === 1 ? state.fighter2 : state.fighter1;

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
  state.matchStartTime = null;
  state.salveFighter = null;
  state.salveMax = 0;
  state.salveHitCount = 0;
  state.salveZones = [];
  state.lastSnapshot = null;
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

function renderEventLog(container, events = state.events) {
  container.innerHTML = '';
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-log-empty';
    empty.textContent = 'Aucun événement';
    container.appendChild(empty);
    return;
  }
  // column-reverse affiche déjà le dernier élément du DOM en haut visuellement,
  // donc on ajoute dans l'ordre chronologique et "first" = dernier ajouté.
  events.forEach((e, i) => {
    const row = document.createElement('div');
    const isFirst = i === events.length - 1;
    row.className = 'log-row' + (e.cancelled ? ' cancelled' : '') + (isFirst ? ' first' : '');

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
  });
}

function renderFighterPanel(id, fighter) {
  const panel = document.getElementById(`panel-${id}`);
  const isRunning = state.status === 'running';
  const hasPendingSalve = state.salveFighter === id;
  const enabled = isRunning && (state.salveFighter === null || state.salveFighter === id);

  panel.classList.toggle('excluded', fighter.isExcluded);
  panel.classList.toggle('pending-salve', hasPendingSalve);

  const nameEl = document.getElementById(`name-${id}`);
  nameEl.textContent = fighter.name;
  nameEl.classList.toggle('editable', state.status === 'idle');
  document.getElementById(`score-${id}`).textContent = fighter.score;

  const badge = document.getElementById(`salve-badge-${id}`);
  if (hasPendingSalve) {
    badge.classList.remove('hidden');
    const multi = state.salveHitCount >= 2;
    badge.textContent = `+ ${state.salveMax} pt${state.salveMax > 1 ? 's' : ''}${multi ? ' (salve)' : ''}`;
  } else {
    badge.classList.add('hidden');
  }

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
  cardButtons.classList.toggle('hidden', fighter.isExcluded || !enabled);

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
  const isRunning = state.status === 'running';
  const isPaused = state.status === 'paused';
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

  document.getElementById('pause-indicator').classList.toggle('hidden', !isPaused);

  renderFighterPanel(1, state.fighter1);
  renderFighterPanel(2, state.fighter2);

  renderEventLog(document.getElementById('event-log'));

  document.getElementById('btn-validate').disabled = state.salveFighter === null;
  document.getElementById('btn-cancel-salve').disabled = state.salveFighter === null;
  document.getElementById('btn-undo').disabled = !canUndo();

  if (isFinished) {
    renderWinnerTitle();
    document.getElementById('result-score-1').textContent = `${state.fighter1.name}  ${state.fighter1.score} pts`;
    document.getElementById('result-score-2').textContent = `${state.fighter2.name}  ${state.fighter2.score} pts`;
    document.getElementById('btn-undo-result').classList.toggle('hidden', !canUndo());
    renderEventLog(document.getElementById('event-log-result'));
  }
}

// ═══════════════════════════ UI : MODAL / MENU / TOAST ═══════════════════════════

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add('hidden'), 4000);
}

function showModal(title, bodyHtml, buttons) {
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

  renderZoneBreakdown(container, stats.zoneCounts, 'Touches par zone');
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

async function promptRenameFighter(id) {
  if (state.status !== 'idle') return;
  const fighter = id === 1 ? state.fighter1 : state.fighter2;
  const defaultName = id === 1 ? 'Combattant rouge' : 'Combattant vert';

  const records = await getAllMatchRecords();
  const knownNames = new Set();
  records.forEach((r) => {
    if (r.fighter1Name) knownNames.add(normalizeName(r.fighter1Name));
    if (r.fighter2Name) knownNames.add(normalizeName(r.fighter2Name));
  });
  const options = [...knownNames].sort((a, b) => a.localeCompare(b, 'fr'))
    .map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');

  showModal('Nom du combattant', `
    <input id="rename-input" type="text" list="rename-suggestions" maxlength="24" value="${escapeHtml(fighter.name)}" placeholder="${escapeHtml(defaultName)}">
    <datalist id="rename-suggestions">${options}</datalist>
  `, [
    { label: 'Annuler' },
    { label: 'Valider', onClick: () => {
      const input = document.getElementById('rename-input');
      fighter.name = normalizeName(input.value) || defaultName;
      render();
    } },
  ]);

  setTimeout(() => {
    const input = document.getElementById('rename-input');
    if (input) { input.focus(); input.select(); }
  }, 50);
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

// ═══════════════════════════ LIAISON DES ÉVÉNEMENTS DOM ═══════════════════════════

document.getElementById('btn-reset-timer').addEventListener('click', resetTimer);
document.getElementById('btn-add-time').addEventListener('click', () => addTime(30));
document.getElementById('btn-play-pause').addEventListener('click', startStop);

document.getElementById('btn-validate').addEventListener('click', commitSalve);
document.getElementById('btn-cancel-salve').addEventListener('click', cancelPendingSalve);
document.getElementById('btn-undo').addEventListener('click', undoLastAction);
document.getElementById('btn-undo-result').addEventListener('click', undoLastAction);

document.getElementById('btn-export-result').addEventListener('click', exportCsv);
document.getElementById('btn-history-result').addEventListener('click', openHistory);
document.getElementById('btn-new-match').addEventListener('click', resetMatch);

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
  document.getElementById(`name-${id}`).addEventListener('click', () => promptRenameFighter(id));
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
  else if (action === 'reset') confirmReset();
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') hideModal();
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ═══════════════════════════ INIT ═══════════════════════════

render();
