/**
 * app.js — Main application
 *
 * Responsibilities:
 *  • Tab switching & import form
 *  • Manual table CRUD
 *  • Plan parsing (calls parser.js)
 *  • Session lifecycle (calls timer.js)
 *  • UI rendering & updates
 *  • Modal management
 *  • MCP polling (GET /api/plan every 2 s, ETag-based)
 *  • SQLite persistence via /api/state (heartbeat + event-driven)
 *  • Keyboard shortcuts
 */

'use strict';

// ═══════════════════════════════════════════════════════════════ State

const State = {
  tasks:           [],
  timer:           null,
  phase:           'idle',
  lastEtag:        '0',
  pollingTimer:    null,
  heartbeatTimer:  null,
  planContent:     '',
  planFormat:      'markdown',
  autoBreak:       false,      // insert breaks between tasks automatically
  breakMinutes:    10,         // duration of each auto-inserted break
};

// ═══════════════════════════════════════════════════════════════ DOM helpers

const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ═══════════════════════════════════════════════════════════════ Bootstrap

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initManualTable();
  initImportControls();
  initSessionControls();
  initModalControls();
  initKeyboard();
  startPolling();
  checkSavedSession();   // offer to restore last session from DB
});

// Save state when user closes/reloads the tab (best-effort)
window.addEventListener('beforeunload', () => {
  if (State.phase !== 'idle' && State.phase !== 'done') {
    persistState();   // synchronous-ish: fetch keepalive
  }
});

// ═══════════════════════════════════════════════════════════════ Tabs

function initTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`panel-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

// ═══════════════════════════════════════════════════════════════ Manual table

let _rowId = 0;

function initManualTable() {
  $('btn-add-row').addEventListener('click', () => addTableRow());
  // Start with 3 empty rows
  for (let i = 0; i < 3; i++) addTableRow();
}

// Table drag state — separate from the task-list drag state
let _tblDrag = { el: null };

function addTableRow(data = {}) {
  const id = _rowId++;
  const tr = document.createElement('tr');
  tr.dataset.rid  = id;
  tr.draggable    = true;

  tr.innerHTML = `
    <td class="cell-drag"><span class="tl-drag" aria-hidden="true" title="Reordenar">⠿</span></td>
    <td><input class="cell-input cell-name" type="text" placeholder="Nombre" value="${_esc(data.name || '')}"></td>
    <td><input class="cell-input cell-min"  type="number" placeholder="25" min="1" max="600" value="${data.minutes || ''}"></td>
    <td><input class="cell-input cell-desc" type="text" placeholder="Descripción" value="${_esc(data.description || '')}"></td>
    <td class="cell-checkbox"><input type="checkbox" ${data.m25 ? 'checked' : ''} aria-label="25%"></td>
    <td class="cell-checkbox"><input type="checkbox" ${data.m50 ? 'checked' : ''} aria-label="50%"></td>
    <td class="cell-checkbox"><input type="checkbox" ${data.m75 ? 'checked' : ''} aria-label="75%"></td>
    <td><button class="btn-remove-row" onclick="this.closest('tr').remove()" title="Eliminar fila">✕</button></td>
  `;

  tr.addEventListener('dragstart', _tblDragStart);
  tr.addEventListener('dragover',  _tblDragOver);
  tr.addEventListener('dragend',   _tblDragEnd);

  $('task-table-body').appendChild(tr);
}

function _tblDragStart(e) {
  _tblDrag.el = this;
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => this.classList.add('is-dragging'));
}

function _tblDragOver(e) {
  e.preventDefault();
  if (!_tblDrag.el || _tblDrag.el === this) return;
  // Live swap: insert the dragged row before or after this one
  const tbody   = $('task-table-body');
  const rows    = Array.from(tbody.querySelectorAll('tr'));
  const fromIdx = rows.indexOf(_tblDrag.el);
  const toIdx   = rows.indexOf(this);
  if (fromIdx < toIdx) {
    tbody.insertBefore(_tblDrag.el, this.nextSibling);
  } else {
    tbody.insertBefore(_tblDrag.el, this);
  }
}

function _tblDragEnd() {
  this.classList.remove('is-dragging');
  _tblDrag.el = null;
}


function _getTableRows() {
  return Array.from($$('#task-table-body tr')).map(tr => {
    const inputs   = tr.querySelectorAll('input[type=text], input[type=number]');
    const checks   = tr.querySelectorAll('input[type=checkbox]');
    return {
      name:        inputs[0]?.value || '',
      minutes:     inputs[1]?.value || '',
      description: inputs[2]?.value || '',
      m25:         checks[0]?.checked || false,
      m50:         checks[1]?.checked || false,
      m75:         checks[2]?.checked || false,
    };
  });
}

// ═══════════════════════════════════════════════════════════════ Import

function initImportControls() {
  $('btn-parse').addEventListener('click', parsePlan);
  $('markdown-input').addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'Enter') parsePlan();
  });
  $('btn-toggle-import').addEventListener('click', () => {
    const isCollapsed = $('import-section').classList.contains('collapsed');
    $('import-section').classList.toggle('collapsed');
    // When opening, always land on the table tab (primary UI)
    if (isCollapsed) {
      document.querySelector('.tab-btn[data-tab=table]')?.click();
    }
  });
  $('btn-toggle-example').addEventListener('click', async () => {
    const example = await getExampleMcp();
    if (!example) { showError('No se pudo obtener el plan de ejemplo.'); return; }
    // Switch to markdown tab and populate textarea
    document.querySelector('.tab-btn[data-tab=markdown]')?.click();
    $('import-section').classList.remove('collapsed');
    $('markdown-input').value = example.trim();
    $('markdown-input').focus();
  });
  $('btn-auto-break').addEventListener('click', () => {
    State.autoBreak = !State.autoBreak;
    $('btn-auto-break').classList.toggle('active', State.autoBreak);
  });

  // Keep State.breakMinutes in sync with the number input
  const breakInput = $('break-minutes-input');
  breakInput.addEventListener('input', () => {
    const v = parseInt(breakInput.value, 10);
    if (v >= 1 && v <= 120) State.breakMinutes = v;
  });
  // Clamp on blur so the field never shows an out-of-range value
  breakInput.addEventListener('blur', () => {
    const v = Math.min(120, Math.max(1, parseInt(breakInput.value, 10) || 10));
    breakInput.value = v;
    State.breakMinutes = v;
  });
}

/**
 * Insert a 10-minute break task between every pair of adjacent non-break tasks.
 * Break tasks are marked with isBreak:true so the task-list can style them differently.
 * @param {Object[]} tasks — parsed task array
 * @returns {Object[]} new array with breaks interleaved
 */
function _insertBreaks(tasks) {
  if (tasks.length < 2) return tasks;
  const result = [];
  tasks.forEach((task, i) => {
    result.push(task);
    if (i < tasks.length - 1 && !task.isBreak) {
      result.push({
        name:         'Descanso',
        minutes:      State.breakMinutes,
        description:  '',
        milestones:   [],
        completion:   0,
        extraMinutes: 0,
        isBreak:      true,
      });
    }
  });
  return result;
}

function parsePlan() {
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  let tasks = [];
  let content = '';
  let format  = 'markdown';

  if (activeTab === 'markdown') {
    content = $('markdown-input').value.trim();
    if (!content) { showError('Escribe un plan en Markdown.'); return; }
    tasks = parseMarkdown(content);
    format = 'markdown';
  } else {
    tasks = parseTableRows(_getTableRows());
    // Serialise the manual table to a canonical markdown for storage
    content = _tableRowsToMarkdown(_getTableRows());
    format  = 'markdown';
  }

  if (tasks.length === 0) {
    showError('No se encontraron tareas. Revisa el formato del plan.');
    return;
  }

  // Inject 10-min breaks between tasks if the toggle is on
  if (State.autoBreak) {
    tasks = _insertBreaks(tasks);
  }

  // Keep raw content for DB sync
  State.planContent = content;
  State.planFormat  = format;

  // Persist plan to DB — capture the new etag so the poller
  // gets a 304 on the next tick and never reloads without breaks.
  fetch('/api/plan', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ content, format }),
  }).then(r => r.json())
    .then(d => { if (d.etag != null) State.lastEtag = String(d.etag); })
    .catch(() => {});

  loadSession(tasks);
}

function showError(msg) {
  const el = $('parse-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ═══════════════════════════════════════════════════════════════ Session lifecycle

function loadSession(tasks) {
  State.tasks = tasks;

  // Collapse import, show session
  $('import-section').classList.add('collapsed');
  $('session-view').classList.remove('hidden');
  $('header-session').classList.remove('hidden');
  $('btn-toggle-import').textContent = '✏️ Plan';

  // Reset any previous timer
  if (State.timer) {
    State.timer.pause();
    State.timer = null;
  }

  // Create timer
  const timer = new SessionTimer(tasks);
  timer.onTick       = onTick;
  timer.onTaskEnd    = onTaskEnd;
  timer.onSessionEnd = onSessionEnd;
  State.timer = timer;

  // UI
  $('session-summary').classList.add('hidden');
  $('session-idle').classList.remove('hidden');
  $('task-card').classList.add('hidden');

  const total = tasks.reduce((s, t) => s + t.minutes, 0);
  const h  = Math.floor(total / 60);
  const m  = total % 60;
  $('idle-summary').textContent =
    `${tasks.length} tareas · ${h > 0 ? h + 'h ' : ''}${m > 0 ? m + ' min' : ''}`;

  renderTaskList();
  updateHeaderTimer(timer.sessionRemaining);
  setPhase('ready');
  $('btn-add-task').classList.remove('hidden');
  requestNotificationPermission();
}

function startSession() {
  if (!State.timer) return;
  $('session-idle').classList.add('hidden');
  $('task-card').classList.remove('hidden');
  updateTaskCard();
  State.timer.start();
  playStartTone();
  setPhase('running');
  startHeartbeat();
}

// ═══════════════════════════════════════════════════════════════ Timer callbacks

function onTick(sessionRem, taskRem, inExtra) {
  updateTaskTimerDisplay(taskRem, inExtra);
  updateHeaderTimer(sessionRem);
  $('session-timer').textContent = SessionTimer.formatTime(sessionRem, true);

  // Time bar
  if (State.timer) {
    const task     = State.timer.currentTask;
    const totalSec = (task.minutes + task.extraMinutes) * 60;
    const elapsed  = totalSec - taskRem;
    const pct      = Math.min(100, (elapsed / totalSec) * 100);
    const bar      = $('task-time-bar');
    bar.style.width = `${pct}%`;
    bar.className   = 'time-bar-fill' +
      (inExtra ? ' extra' : pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');

    // Tick sound in last 30 s
    if (!inExtra && taskRem <= 30 && Math.round(taskRem) % 5 === 0) {
      playTickTone();
    }

    // Danger pulse on big timer
    const timerEl = $('task-timer');
    timerEl.classList.toggle('danger-pulse', !inExtra && taskRem <= 30);
    timerEl.classList.toggle('extra-time',   inExtra);
  }
}

function onTaskEnd(task, nextTask) {
  playAlarm();
  showNotification(
    `Tiempo: ${task.name}`,
    nextTask ? `Siguiente -> ${nextTask.name} (${nextTask.minutes} min)` : 'Ultima tarea completada'
  );
  stopHeartbeat();
  persistState();            // save position when task ends
  setPhase('task-ended');
  openTaskEndModal(task, nextTask);
}

function onSessionEnd(tasks) {
  playSessionAlarm();
  showNotification('Sesion completada!', `${tasks.length} tareas finalizadas`);
  stopHeartbeat();
  persistState('done');      // save final state
  setPhase('done');
  showSummary(tasks);
}

// ═══════════════════════════════════════════════════════════════ UI update

function updateTaskTimerDisplay(taskRem, inExtra) {
  $('task-timer').textContent = SessionTimer.formatTime(taskRem);
  $('extra-badge').classList.toggle('hidden', !inExtra);
}

// ── Editable timer (click-to-edit, Windows-style) ─────────────────────────

function openTimerEdit() {
  if (!State.timer) return;
  const display = $('task-timer');
  const input   = $('task-timer-input');

  // Pre-fill with current time text (e.g. "12:34")
  input.value = display.textContent.trim();
  display.classList.add('hidden');
  input.classList.remove('hidden');

  // Select all so user can type right over it
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

function closeTimerEdit() {
  $('task-timer').classList.remove('hidden');
  $('task-timer-input').classList.add('hidden');
}

/** Parse "M:SS", "MM:SS", "H:MM:SS", or a plain number as seconds */
function _parseTimerInput(raw) {
  const s = raw.trim();
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return parts[0];                          // bare seconds
  if (parts.length === 2) return parts[0] * 60 + parts[1];          // M:SS
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // H:MM:SS
  return null;
}

function confirmTimerEdit() {
  const newSecs = _parseTimerInput($('task-timer-input').value);
  closeTimerEdit();
  if (newSecs === null || !State.timer || newSecs < 0) return;

  const delta = newSecs - State.timer._taskRem;
  State.timer._taskRem    = newSecs;
  State.timer._sessionRem = Math.max(0, State.timer._sessionRem + delta);

  // Refresh displays immediately
  updateTaskTimerDisplay(State.timer._taskRem, State.timer._inExtra);
  updateHeaderTimer(State.timer._sessionRem);
  $('session-timer').textContent = SessionTimer.formatTime(State.timer._sessionRem, true);
}

function updateHeaderTimer(sessionRem) {
  $('header-session-time').textContent = SessionTimer.formatTime(sessionRem, true);
}

function updateTaskCard() {
  const timer = State.timer;
  if (!timer || !timer.currentTask) return;
  const task = timer.currentTask;

  $('task-index-badge').textContent =
    `Tarea ${timer.currentIndex + 1} de ${timer.totalTasks}`;
  $('task-name').textContent = task.name;
  $('task-desc').textContent = task.description || '';

  // Milestones: always show all buttons; highlight by task config
  $$('#task-milestones .btn-milestone').forEach(btn => {
    const pct = parseInt(btn.dataset.pct);
    btn.classList.remove('active');
    // Grey out unconfigured intermediate milestones (but keep enabled)
    if (pct !== 100 && !task.milestones.includes(pct)) {
      btn.style.opacity = '0.38';
    } else {
      btn.style.opacity = '';
    }
  });
  syncMilestoneButtons(task.completion);

  $('tasks-remaining-label').textContent =
    `${timer.totalTasks - timer.currentIndex - 1} restantes`;

  // Reset time bar
  $('task-time-bar').style.width = '0%';
  $('task-time-bar').className   = 'time-bar-fill';
  $('task-timer').classList.remove('danger-pulse', 'extra-time');
  $('extra-badge').classList.add('hidden');

  updateTaskTimerDisplay(timer.taskRemaining, false);
  $('session-timer').textContent = SessionTimer.formatTime(timer.sessionRemaining, true);
}

function syncMilestoneButtons(pct) {
  $$('#task-milestones .btn-milestone').forEach(btn => {
    const v = parseInt(btn.dataset.pct);
    btn.classList.toggle('active', v === pct);
  });
}

// ═══════════════════════════════════════════════════════════════ Task list

// ── Drag state ────────────────────────────────────────────────────────────
let _drag = { fromIdx: -1, toIdx: -1 };

function renderTaskList() {
  const list       = $('task-list');
  list.innerHTML   = '';
  const tasks      = State.tasks;
  const currentIdx = State.timer?.currentIndex ?? -1;

  tasks.forEach((task, i) => {
    // While paused: current slot + pending are all draggable.
    // While running/ready: only strictly pending tasks.
    const isPaused    = State.phase === 'paused';
    const isDraggable = isPaused ? (i >= currentIdx) : (i > currentIdx);

    const div = document.createElement('div');
    div.className = 'task-item' + (task.isBreak ? ' is-break' : '');
    div.id = `tl-${i}`;

    if (isDraggable) {
      div.draggable    = true;
      div.dataset.idx  = i;
      div.addEventListener('dragstart', _onDragStart);
      div.addEventListener('dragover',  _onDragOver);
      div.addEventListener('dragleave', _onDragLeave);
      div.addEventListener('drop',      _onDragDrop);
      div.addEventListener('dragend',   _onDragEnd);
    }

    const icon       = task.isBreak ? '⏸' : '○';
    const dragHandle = isDraggable
      ? `<span class="tl-drag" aria-hidden="true" title="Reordenar">⠿</span>`
      : `<span class="tl-drag tl-drag--hidden" aria-hidden="true"></span>`;

    div.innerHTML = `
      <div class="ti-header">
        ${dragHandle}
        <span class="ti-icon" id="ti-icon-${i}">${icon}</span>
        <span class="ti-name">${_esc(task.name)}</span>
        <span class="ti-time">${task.minutes} min</span>
      </div>
      ${task.description && !task.isBreak ? `<div class="ti-desc">${_esc(task.description)}</div>` : ''}
      <div class="ti-progress-track">
        <div class="ti-progress-fill" id="ti-bar-${i}" style="width:0%"></div>
      </div>
      <div class="ti-pct-label" id="ti-pct-${i}"></div>
    `;
    list.appendChild(div);
  });

  updateTaskListHighlight();
  updateTaskListSummary();
}

// ── Drag-and-drop handlers ─────────────────────────────────────────────────

function _onDragStart(e) {
  _drag.fromIdx = parseInt(this.dataset.idx);
  e.dataTransfer.effectAllowed = 'move';
  // Defer class so the ghost image renders normally
  requestAnimationFrame(() => this.classList.add('is-dragging'));
}

function _onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const toIdx      = parseInt(this.dataset.idx);
  const currentIdx = State.timer?.currentIndex ?? -1;
  // Paused: allow dropping at the current slot too (swap tasks freely)
  // Running/ready: only strictly pending slots
  const minDropIdx = State.phase === 'paused' ? currentIdx : currentIdx + 1;
  if (toIdx >= minDropIdx && toIdx !== _drag.fromIdx) {
    _drag.toIdx = toIdx;
    $$('.task-item.drag-over').forEach(el => el.classList.remove('drag-over'));
    this.classList.add('drag-over');
  }
}

function _onDragLeave() {
  this.classList.remove('drag-over');
}

function _onDragDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const { fromIdx, toIdx } = _drag;
  if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
    _moveTask(fromIdx, toIdx);
  }
}

function _onDragEnd() {
  this.classList.remove('is-dragging');
  $$('.task-item.drag-over').forEach(el => el.classList.remove('drag-over'));
  _drag = { fromIdx: -1, toIdx: -1 };
}

// ── Task mutation helpers ──────────────────────────────────────────────────

/**
 * Reorder tasks.
 * - Running/ready: only pending tasks (strictly after current) may move.
 * - Paused: current task slot is also flexible — any task at index >= currentIdx.
 *   If the task at the current slot changes, the task timer resets to the
 *   new task's full duration and the task card updates.
 */
function _moveTask(fromIdx, toIdx) {
  const currentIdx = State.timer?.currentIndex ?? -1;
  const isPaused   = State.phase === 'paused';
  const minIdx     = isPaused ? currentIdx : currentIdx + 1;

  if (fromIdx < minIdx || toIdx < minIdx) return;
  if (fromIdx === toIdx) return;

  // Remember which task object is currently active before the splice
  const prevCurrentTask = currentIdx >= 0 ? State.tasks[currentIdx] : null;

  const [task] = State.tasks.splice(fromIdx, 1);
  State.tasks.splice(toIdx, 0, task);

  if (State.timer) {
    const [t] = State.timer.tasks.splice(fromIdx, 1);
    State.timer.tasks.splice(toIdx, 0, t);

    // If the task in the active slot changed, reset the task timer to the
    // new task's full duration and refresh the task card
    const newCurrentTask = State.tasks[currentIdx];
    if (newCurrentTask && newCurrentTask !== prevCurrentTask) {
      State.timer._taskRem = newCurrentTask.minutes * 60;
      updateTaskCard();
    }
  }

  renderTaskList();
  updateTaskListHighlight();
  updateTaskListSummary();
}

/**
 * Insert a new task at a given index.
 * If inserted before the current task, bumps timer._index by 1.
 * Adds the task's duration to session remaining.
 */
function _insertTaskAt(index, { name, minutes, isBreak = false }) {
  const task = {
    name,
    minutes,
    description:  '',
    milestones:   isBreak ? [] : [100],
    completion:   0,
    extraMinutes: 0,
    isBreak,
  };

  State.tasks.splice(index, 0, task);

  if (State.timer) {
    State.timer.tasks.splice(index, 0, task);
    // Keep session time accurate
    State.timer._sessionRem = (State.timer._sessionRem || 0) + minutes * 60;
    // If new task lands before current, shift index forward
    if (index <= State.timer._index) State.timer._index++;
  }

  renderTaskList();
  updateTaskListHighlight();
  updateTaskListSummary();
  if (State.timer) updateHeaderTimer(State.timer.sessionRemaining);
  persistState();
}

// ── Insert-task modal ──────────────────────────────────────────────────────

function openInsertTaskModal() {
  const currentIdx = State.timer?.currentIndex ?? -1;
  const sel        = $('insert-task-pos');
  sel.innerHTML    = '';

  // Build position options: after current, after each pending, at end
  const addOpt = (value, label) => {
    const o = document.createElement('option');
    o.value       = value;
    o.textContent = label;
    sel.appendChild(o);
  };

  addOpt(currentIdx + 1, 'Justo a continuación');
  State.tasks.forEach((t, i) => {
    if (i > currentIdx) {
      addOpt(i + 1, `Después de "${t.name.length > 24 ? t.name.slice(0,24)+'…' : t.name}"`);
    }
  });
  addOpt(State.tasks.length, 'Al final');

  $('insert-task-name').value = '';
  $('insert-task-mins').value = 25;
  $('modal-insert-task').classList.remove('hidden');
  setTimeout(() => $('insert-task-name').focus(), 60);
}

function _closeInsertModal() {
  $('modal-insert-task').classList.add('hidden');
}

function _confirmInsertTask() {
  const name = $('insert-task-name').value.trim();
  if (!name) { $('insert-task-name').focus(); return; }
  const minutes = Math.max(1, parseInt($('insert-task-mins').value, 10) || 25);
  const index   = parseInt($('insert-task-pos').value, 10);
  _insertTaskAt(index, { name, minutes });
  _closeInsertModal();
}

function updateTaskListHighlight() {
  const idx = State.timer?.currentIndex ?? -1;
  State.tasks.forEach((_, i) => {
    const el = $(`tl-${i}`);
    if (!el) return;
    el.classList.toggle('is-current', i === idx);
    el.classList.toggle('is-done',    i < idx);
    const icon = $(`ti-icon-${i}`);
    if (icon) {
      icon.textContent = i < idx ? '✓' : i === idx ? '▶' : '○';
    }
  });
  // Scroll current task into view
  const cur = $(`tl-${idx}`);
  if (cur) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateTaskListProgress(idx, pct) {
  const bar   = $(`ti-bar-${idx}`);
  const label = $(`ti-pct-${idx}`);
  if (!bar || !label) return;
  bar.style.width = `${pct}%`;
  bar.className   = `ti-progress-fill${pct > 0 ? ` p${pct}` : ''}`;
  label.textContent = pct > 0 ? `${pct}%` : '';
}

function updateTaskListSummary() {
  const done = State.tasks.filter(t => t.completion === 100).length;
  $('tl-summary').textContent = `${done}/${State.tasks.length}`;
}

// ═══════════════════════════════════════════════════════════════ Phase / button state

function setPhase(phase) {
  const prevPhase = State.phase;
  State.phase = phase;
  const btn = $('btn-start-pause');
  switch (phase) {
    case 'idle':
      btn.textContent = '▶ Iniciar'; btn.disabled = true;  break;
    case 'ready':
      btn.textContent = '▶ Iniciar'; btn.disabled = false; break;
    case 'running':
      btn.textContent = '⏸ Pausar';  btn.disabled = false; break;
    case 'paused':
      btn.textContent = '▶ Continuar'; btn.disabled = false; break;
    case 'task-ended':
      btn.textContent = '▶ Continuar'; btn.disabled = true;  break;
    case 'done':
      btn.textContent = '✓ Listo';   btn.disabled = true;  break;
  }
  // Re-render task list when entering or leaving paused state
  // so drag handles on the current task appear/disappear correctly
  const affectsHandles = phase === 'paused' || prevPhase === 'paused';
  if (affectsHandles && State.tasks.length > 0) renderTaskList();
}

// ═══════════════════════════════════════════════════════════════ Session controls

function initSessionControls() {
  $('btn-start-pause').addEventListener('click', onStartPause);
  $('btn-skip').addEventListener('click', onSkip);
  $('btn-reset').addEventListener('click', onReset);
  $('btn-extra-time').addEventListener('click', () => openExtraModal());
  $('btn-new-session').addEventListener('click', resetApp);

  // Milestone buttons in task card
  $$('#task-milestones .btn-milestone').forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = parseInt(btn.dataset.pct);
      State.timer?.setCompletion(pct);
      syncMilestoneButtons(pct);
      // Update task list live
      updateTaskListProgress(State.timer?.currentIndex ?? 0, pct);
      updateTaskListSummary();
    });
  });

  // Click-to-edit timer (Windows-style)
  $('task-timer').addEventListener('click', openTimerEdit);
  const inp = $('task-timer-input');
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmTimerEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); closeTimerEdit(); }
  });
  inp.addEventListener('blur', confirmTimerEdit);
}

function onStartPause() {
  const timer = State.timer;
  if (!timer) return;

  if (State.phase === 'ready') {
    startSession();
  } else if (State.phase === 'running') {
    timer.pause();
    setPhase('paused');
    persistState();          // save position to DB on every pause
    stopHeartbeat();
  } else if (State.phase === 'paused') {
    timer.resume();
    setPhase('running');
    startHeartbeat();
  }
}

function onSkip() {
  if (!State.timer || !State.timer.currentTask) return;
  // Show task-end modal (user chooses completion)
  State.timer.pause();
  setPhase('task-ended');
  openTaskEndModal(State.timer.currentTask, State.timer.nextTask);
}

function onReset() {
  if (!confirm('¿Reiniciar la sesión? Se perderá el progreso actual.')) return;
  if (State.timer) { State.timer.pause(); State.timer = null; }
  const tasks = State.tasks.map(t => ({ ...t, completion: 0, extraMinutes: 0 }));
  loadSession(tasks);
}

function resetApp() {
  if (State.timer) { State.timer.pause(); State.timer = null; }
  State.tasks = [];
  State.phase = 'idle';
  $('session-view').classList.add('hidden');
  $('header-session').classList.add('hidden');
  $('import-section').classList.remove('collapsed');
  $('session-summary').classList.add('hidden');
  $('task-card').classList.add('hidden');
  $('session-idle').classList.remove('hidden');
  $('btn-add-task').classList.add('hidden');
  $('modal-insert-task').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════ Task-end modal

function openTaskEndModal(task, nextTask) {
  const modal = $('modal-task-end');
  $('modal-task-name').textContent = task.name;
  $('modal-next-info').textContent = nextTask
    ? `Siguiente: ${nextTask.name} (${nextTask.minutes} min)`
    : 'Esta es la última tarea.';

  // Pre-select current completion
  const pct = task.completion || 0;
  $$('.modal-milestone').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.pct) === pct);
  });

  modal.classList.remove('hidden');
}

function closeTaskEndModal() {
  $('modal-task-end').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════ Extra-time modal

function openExtraModal(fromTaskEnd = false) {
  $('extra-minutes-input').value = '10';
  $('modal-extra-time').classList.remove('hidden');
  setTimeout(() => $('extra-minutes-input').select(), 50);

  // Remember if we opened from task-end modal (need to close it too)
  $('modal-extra-time').dataset.fromTaskEnd = fromTaskEnd ? '1' : '0';
}

function closeExtraModal() {
  $('modal-extra-time').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════ Modal controls

function initModalControls() {
  // ── Task-end modal ──
  $$('.modal-milestone').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.modal-milestone').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  $('btn-modal-extra').addEventListener('click', () => {
    closeTaskEndModal();
    openExtraModal(true);
  });

  $('btn-modal-next').addEventListener('click', () => {
    const active = document.querySelector('.modal-milestone.active');
    const pct    = active ? parseInt(active.dataset.pct) : 100;
    const idx    = State.timer?.currentIndex ?? 0;

    State.timer?.completeTask(pct);
    playTaskCompleteTone();

    closeTaskEndModal();
    // Update UI for new current task
    updateTaskListProgress(idx, pct);
    updateTaskListHighlight();
    updateTaskListSummary();

    if (State.timer && State.timer.currentIndex < State.timer.totalTasks) {
      $('session-idle').classList.add('hidden');
      $('task-card').classList.remove('hidden');
      updateTaskCard();
      setPhase('running');
      startHeartbeat();
      persistState();        // record task completion to DB
    }
  });

  // ── Extra-time modal ──
  $('btn-confirm-extra').addEventListener('click', () => {
    const mins = parseFloat($('extra-minutes-input').value) || 5;
    State.timer?.addExtraTime(mins);
    closeExtraModal();
    $('session-idle').classList.add('hidden');
    $('task-card').classList.remove('hidden');
    updateTaskCard();
    setPhase('running');
    startHeartbeat();
    persistState();           // record extra time extension to DB
  });

  $('btn-cancel-extra').addEventListener('click', () => {
    closeExtraModal();
    // If timer was paused for task-end, re-open that modal
    if ($('modal-extra-time').dataset.fromTaskEnd === '1' && State.timer) {
      openTaskEndModal(State.timer.currentTask, State.timer.nextTask);
    }
  });

  // Close modals on overlay click
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.classList.add('hidden');
      }
    });
  });

  // ── Insert-task modal ──
  $('btn-add-task').addEventListener('click', openInsertTaskModal);
  $('btn-cancel-insert').addEventListener('click', _closeInsertModal);
  $('btn-confirm-insert').addEventListener('click', _confirmInsertTask);
  // Allow Enter to confirm
  $('insert-task-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _confirmInsertTask(); }
    if (e.key === 'Escape') _closeInsertModal();
  });
  $('insert-task-mins').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _confirmInsertTask(); }
    if (e.key === 'Escape') _closeInsertModal();
  });
}

// ═══════════════════════════════════════════════════════════════ Summary

function showSummary(tasks) {
  $('task-card').classList.add('hidden');
  $('session-idle').classList.add('hidden');

  const studyTasks  = tasks.filter(t => !t.isBreak);
  const breakTasks  = tasks.filter(t =>  t.isBreak);

  // Effective study time: planned + extra, breaks excluded
  const studyMins = studyTasks.reduce((s, t) => s + t.minutes + (t.extraMinutes || 0), 0);
  const breakMins = breakTasks.reduce((s, t) => s + t.minutes, 0);
  const totalMins = tasks.reduce((s, t) => s + t.minutes, 0);

  const completed = studyTasks.filter(t => t.completion === 100).length;
  const avgPct    = studyTasks.length
    ? Math.round(studyTasks.reduce((s, t) => s + t.completion, 0) / studyTasks.length)
    : 0;

  // Format helper: "Xh Ymin" or "Y min"
  const fmtMins = m => {
    const h = Math.floor(m / 60), rem = m % 60;
    return h > 0 ? `${h}h ${rem > 0 ? rem + 'min' : ''}`.trim() : `${rem} min`;
  };

  $('summary-stats').innerHTML =
    `<strong>${completed}</strong> de <strong>${studyTasks.length}</strong> tareas al 100% &nbsp;·&nbsp; ` +
    `Promedio <strong>${avgPct}%</strong> &nbsp;·&nbsp; ` +
    `<strong>${totalMins} min</strong> planificados`;

  // Effective study time highlight — the headline number
  const effectiveEl = $('summary-effective');
  if (effectiveEl) {
    effectiveEl.innerHTML =
      `<span class="eff-value">${fmtMins(studyMins)}</span>` +
      `<span class="eff-label">de estudio efectivo</span>` +
      (breakMins > 0 ? `<span class="eff-break">+ ${fmtMins(breakMins)} de descanso</span>` : '');
  }

  let html = '';
  // Only render non-break tasks in the per-task breakdown
  studyTasks.forEach(task => {
    const colorClass = task.completion >= 100 ? 'p100'
      : task.completion >= 75  ? 'p75'
      : task.completion >= 50  ? 'p50'
      : task.completion >= 25  ? 'p25' : '';
    const mins = task.minutes + (task.extraMinutes || 0);
    html += `
      <div class="summary-task">
        <span class="summary-name">${_esc(task.name)}</span>
        <span class="summary-mins">${mins} min</span>
        <div class="summary-bar-track">
          <div class="summary-bar-fill ${colorClass}" style="width:${task.completion}%;background:var(--${colorClass === 'p100' || colorClass === 'p75' ? 'success' : 'warning'})"></div>
        </div>
        <span class="summary-pct">${task.completion}%</span>
      </div>`;
  });
  $('summary-tasks').innerHTML = html;
  $('session-summary').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════ Keyboard shortcuts

function initKeyboard() {
  document.addEventListener('keydown', e => {
    // Ignore when typing in an input
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (e.key === ' ') {
      e.preventDefault();
      if (State.phase === 'ready' || State.phase === 'paused') {
        onStartPause();
      } else if (State.phase === 'running') {
        State.timer?.pause();
        setPhase('paused');
      }
    }
    if (e.key === 'Escape') {
      $$('.modal-overlay').forEach(m => m.classList.add('hidden'));
    }
    if (e.key === 'ArrowRight' && !e.ctrlKey && State.phase !== 'idle') {
      onSkip();
    }
  });
}

// ═══════════════════════════════════════════════════════════════ MCP polling

function startPolling() {
  State.pollingTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/plan', {
        headers: { 'If-None-Match': State.lastEtag }
      });
      if (res.status === 304) return;   // no change
      if (!res.ok) return;

      const data = await res.json();
      State.lastEtag = String(data.etag);

      if (data.plan?.content && data.plan?.source === 'mcp') {
        // Only auto-load plans injected by an external MCP agent
        handleExternalPlan(data.plan);
      }
    } catch (_) { /* server not reachable */ }
  }, 2000);
}

async function getExampleMcp(){
  try{
    const res = await fetch('/mcp/tools/get_example_plan');
    if(!res.ok){return null}
    const data = await res.json();
    return data['Example plan'];
  }
  catch(_){
    return null
  }
}


function handleExternalPlan(plan) {
  // Don't interrupt an active running session without asking
  if (State.phase === 'running' || State.phase === 'paused') {
    const ok = confirm(
      '📡 Se recibió un nuevo plan vía MCP.\n¿Deseas reemplazar la sesión actual?'
    );
    if (!ok) return;
  }

  if (plan.format === 'markdown' || !plan.format) {
    const tasks = parseMarkdown(plan.content || '');
    if (tasks.length > 0) {
      loadSession(tasks);
      // Populate textarea for reference
      $('markdown-input').value = plan.content;
      // Switch to markdown tab
      document.querySelector('.tab-btn[data-tab=markdown]')?.click();
      showMcpToast();
    }
  }
}

function showMcpToast() {
  const toast = $('mcp-toast');
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 4000);
}

// ═══════════════════════════════════════════════════════════════ Persistence
//
//  Strategy (NSUserDefaults-style):
//    • Write on significant events: pause, task-complete, extra-time, close
//    • Heartbeat every 30 s while running (captures position if app crashes)
//    • Never write on every timer tick (no need; recovery resolution = 30 s)
//    • SQLite WAL on server side keeps writes non-blocking
//

/**
 * Collect current session state and POST it to /api/state.
 * Fire-and-forget — failures are silently ignored.
 * @param {string} [phaseOverride]  optionally override phase (e.g. 'done')
 */
function persistState(phaseOverride) {
  if (!State.timer || !State.tasks.length) return;

  const payload = {
    tasks:            State.timer.tasks,          // includes completion values
    currentIndex:     State.timer.currentIndex,
    sessionRemaining: State.timer.sessionRemaining,
    taskRemaining:    State.timer.taskRemaining,
    phase:            phaseOverride || State.phase,
    planContent:      State.planContent,
    planFormat:       State.planFormat,
  };

  // Use keepalive so the request survives page unload (beforeunload)
  fetch('/api/state', {
    method:    'POST',
    headers:   { 'Content-Type': 'application/json' },
    body:      JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

/** Start 30-second heartbeat while a session is running. */
function startHeartbeat() {
  stopHeartbeat();
  State.heartbeatTimer = setInterval(() => {
    if (State.phase === 'running') persistState();
  }, 30_000);
}

function stopHeartbeat() {
  if (State.heartbeatTimer) {
    clearInterval(State.heartbeatTimer);
    State.heartbeatTimer = null;
  }
}

// ── Session restore ─────────────────────────────────────────────────────────

/**
 * On page load, check DB for a saved session.
 * If one exists (and isn't 'done'), show a restore banner.
 */
async function checkSavedSession() {
  try {
    const res  = await fetch('/api/state');
    if (!res.ok) return;
    const data = await res.json();
    const s    = data.state;
    if (!s || !s.tasks?.length || s.phase === 'done') return;

    // Don't offer restore if user already loaded a plan in this tab
    if (State.phase !== 'idle') return;

    showRestoreBanner(s);
  } catch (_) {}
}

/**
 * Show a subtle banner offering to resume the last session.
 * @param {Object} saved — the persisted state object
 */
function showRestoreBanner(saved) {
  // Build the banner element
  const banner = document.createElement('div');
  banner.id = 'restore-banner';
  banner.className = 'restore-banner';

  const ago = saved.savedAt
    ? _timeAgo(saved.savedAt)
    : 'hace un momento';

  const taskName  = saved.tasks?.[saved.currentIndex]?.name ?? '?';
  const taskCount = saved.tasks?.length ?? 0;
  const remStr    = SessionTimer.formatTime(saved.sessionRemaining ?? 0, true);

  banner.innerHTML = `
    <div class="rb-content">
      <span class="rb-icon">💾</span>
      <div class="rb-text">
        <strong>Sesion guardada</strong> &nbsp;·&nbsp; ${ago}
        <br><span class="rb-detail">Tarea ${saved.currentIndex + 1}/${taskCount}: ${_esc(taskName)} &nbsp;·&nbsp; ${remStr} restantes</span>
      </div>
    </div>
    <div class="rb-actions">
      <button id="rb-restore" class="btn-primary btn-sm">Continuar sesion</button>
      <button id="rb-dismiss" class="btn-ghost btn-sm">Descartar</button>
    </div>
  `;

  document.body.appendChild(banner);
  setTimeout(() => banner.classList.add('rb-visible'), 50);

  $('rb-restore').addEventListener('click', () => {
    banner.remove();
    restoreSession(saved);
  });
  $('rb-dismiss').addEventListener('click', () => {
    banner.classList.remove('rb-visible');
    setTimeout(() => banner.remove(), 300);
    // Reset UI completely — no ghost session visible after dismissal
    resetApp();
    // Also clear the DB record so the banner never reappears on reload
    fetch('/api/state', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tasks: [], currentIndex: 0,
                                sessionRemaining: 0, taskRemaining: 0,
                                phase: 'done', planContent: '' }),
    }).catch(() => {});
  });
}

/**
 * Restore a saved session: reconstruct tasks, set timer to saved position,
 * leave in 'paused' state so user explicitly presses Play.
 */
function restoreSession(saved) {
  const tasks = (saved.tasks || []).map(t => ({
    ...t,
    // Ensure required fields exist
    milestones:   t.milestones   || [100],
    extraMinutes: t.extraMinutes || 0,
    completion:   t.completion   || 0,
  }));
  if (!tasks.length) return;

  // Populate markdown editor with the saved plan if available
  if (saved.planContent) {
    $('markdown-input').value = saved.planContent;
    State.planContent = saved.planContent;
    State.planFormat  = saved.planFormat || 'markdown';
    document.querySelector('.tab-btn[data-tab=markdown]')?.click();
  }

  State.tasks = tasks;

  // Set up session view
  $('import-section').classList.add('collapsed');
  $('session-view').classList.remove('hidden');
  $('header-session').classList.remove('hidden');
  $('session-summary').classList.add('hidden');
  $('session-idle').classList.add('hidden');
  $('task-card').classList.remove('hidden');

  // Create timer and fast-forward its internal state to saved position
  const timer = new SessionTimer(tasks);
  // Override the internal counters to match saved position
  timer._index      = Math.min(saved.currentIndex ?? 0, tasks.length - 1);
  timer._sessionRem = saved.sessionRemaining ?? 0;
  timer._taskRem    = saved.taskRemaining    ?? 0;
  // Copy completion values from saved tasks into timer's task copies
  timer.tasks.forEach((t, i) => {
    t.completion   = tasks[i]?.completion   ?? 0;
    t.extraMinutes = tasks[i]?.extraMinutes ?? 0;
  });
  timer.onTick       = onTick;
  timer.onTaskEnd    = onTaskEnd;
  timer.onSessionEnd = onSessionEnd;
  State.timer = timer;

  renderTaskList();
  updateTaskCard();
  updateHeaderTimer(timer.sessionRemaining);

  // Start paused — let user explicitly resume
  setPhase('paused');

  // Restore task-list progress bars for completed tasks
  tasks.forEach((t, i) => {
    if (t.completion > 0) updateTaskListProgress(i, t.completion);
  });
  updateTaskListHighlight();
  updateTaskListSummary();

  showRestoreToast();
}

function showRestoreToast() {
  const toast = $('mcp-toast');
  toast.textContent = 'Sesion restaurada. Presiona Continuar.';
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.textContent = 'Plan recibido via MCP';
    toast.classList.add('hidden');
  }, 4000);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert manual table rows back to a minimal Markdown table for storage. */
function _tableRowsToMarkdown(rows) {
  const valid = rows.filter(r => r.name && r.name.trim());
  if (!valid.length) return '';
  const header = '| Tarea | Minutos | Descripcion | 25% | 50% | 75% |';
  const sep    = '|-------|---------|-------------|-----|-----|-----|';
  const body   = valid.map(r =>
    `| ${r.name} | ${r.minutes || 25} | ${r.description || ''} ` +
    `| ${r.m25 ? 'x' : ''} | ${r.m50 ? 'x' : ''} | ${r.m75 ? 'x' : ''} |`
  ).join('\n');
  return [header, sep, body].join('\n');
}

/** Human-readable "hace N min" from a Unix timestamp. */
function _timeAgo(unixTs) {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixTs);
  if (diffSec < 60)   return 'hace un momento';
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400)return `hace ${Math.floor(diffSec / 3600)} h`;
  return `hace ${Math.floor(diffSec / 86400)} dias`;
}

// ═══════════════════════════════════════════════════════════════ Utilities

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
