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
};

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
    if (state.status === 'idle') state.matchStartTime = new Date();
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
  render();
}

// ═══════════════════════════ CSV ═══════════════════════════

const EVENT_TYPE_CSV = { touche: 'touche', carton: 'carton', chrono: 'chrono', finMatch: 'fin_match' };

function generateCsv() {
  const lines = [];

  let dateStr = '', heureStr = '';
  if (state.matchStartTime) {
    const t = state.matchStartTime;
    dateStr = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    heureStr = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
  }

  lines.push('cle,valeur');
  lines.push(`date,${dateStr}`);
  lines.push(`heure_debut,${heureStr}`);
  lines.push(`combattant_rouge,"${state.fighter1.name}"`);
  lines.push(`combattant_vert,"${state.fighter2.name}"`);
  lines.push(`score_final_rouge,${state.fighter1.score}`);
  lines.push(`score_final_vert,${state.fighter2.score}`);
  lines.push(`vainqueur,"${state.winner ?? ''}"`);
  lines.push(`duree_s,${elapsedSeconds()}`);
  lines.push('');

  lines.push('num,temps_match_s,type,combattant,zone,salve,salve_zones,points_event,score_rouge,score_vert,carton,mort_subite,annule');

  state.events.forEach((e, idx) => {
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

function downloadCsv() {
  const content = generateCsv();
  const timestamp = new Date().toISOString().replace(/:/g, '-').substring(0, 19);
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

function renderEventLog(container) {
  container.innerHTML = '';
  if (state.events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'event-log-empty';
    empty.textContent = 'Aucun événement';
    container.appendChild(empty);
    return;
  }
  // column-reverse affiche déjà le dernier élément du DOM en haut visuellement,
  // donc on ajoute dans l'ordre chronologique et "first" = dernier ajouté.
  state.events.forEach((e, i) => {
    const row = document.createElement('div');
    const isFirst = i === state.events.length - 1;
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

  document.getElementById(`name-${id}`).textContent = fighter.name;
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
});

document.getElementById('btn-menu').addEventListener('click', () => toggleMenu(true));
document.getElementById('menu-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'menu-overlay') { toggleMenu(false); return; }
  const action = e.target.dataset.action;
  if (!action) return;
  toggleMenu(false);
  if (action === 'toss') doToss();
  else if (action === 'export') exportCsv();
  else if (action === 'reset') confirmReset();
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') hideModal();
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
