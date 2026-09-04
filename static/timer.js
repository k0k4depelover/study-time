/**
 * timer.js — SessionTimer
 *
 * Manages two synchronized countdown timers:
 *   • taskRemaining   — time left for the current task
 *   • sessionRemaining — total time left in the session
 *
 * Both tick together.  Pausing one pauses both.
 * Uses Date.now() for wall-clock accuracy (immune to JS drift).
 */

'use strict';

class SessionTimer {
  /**
   * @param {Task[]} tasks  — parsed task array from parser.js
   */
  constructor(tasks) {
    // Deep-clone tasks so we can store completion state here
    this._tasks = tasks.map(t => ({ ...t, completion: 0, extraMinutes: 0 }));

    this._index   = 0;
    this._running = false;
    this._paused  = false;
    this._lastMs  = null;
    this._timerId = null;
    this._inExtra = false;

    const totalSec = this._tasks.reduce((s, t) => s + t.minutes * 60, 0);
    this._sessionRem = totalSec;
    this._taskRem    = this._tasks[0] ? this._tasks[0].minutes * 60 : 0;

    /** @type {function(sessionRem:number, taskRem:number, inExtra:boolean):void} */
    this.onTick       = null;
    /** @type {function(task:Task, nextTask:Task|null):void} */
    this.onTaskEnd    = null;
    /** @type {function(tasks:Task[]):void} */
    this.onSessionEnd = null;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  get currentTask()      { return this._tasks[this._index] || null; }
  get nextTask()         { return this._tasks[this._index + 1] || null; }
  get currentIndex()     { return this._index; }
  get isRunning()        { return this._running; }
  get isPaused()         { return this._paused; }
  get inExtra()          { return this._inExtra; }
  get sessionRemaining() { return this._sessionRem; }
  get taskRemaining()    { return this._taskRem; }
  get totalTasks()       { return this._tasks.length; }
  get tasks()            { return this._tasks; }

  // ── Control ────────────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    this._paused  = false;
    this._lastMs  = Date.now();
    this._schedule();
  }

  pause() {
    if (!this._running) return;
    this._running = false;
    this._paused  = true;
    this._clearTimer();
  }

  resume() {
    if (this._running) return;
    this._running = true;
    this._paused  = false;
    this._lastMs  = Date.now();
    this._schedule();
  }

  toggle() { this._running ? this.pause() : this.resume(); }

  // ── Task interaction ───────────────────────────────────────────────────────

  /**
   * Record the current completion percentage for the current task.
   * Does NOT advance to the next task.
   */
  setCompletion(pct) {
    if (this.currentTask) this.currentTask.completion = pct;
  }

  /**
   * Add extra minutes to the current task (extends both timers).
   * If paused, auto-resumes.
   */
  addExtraTime(minutes) {
    const secs = minutes * 60;
    this._taskRem    += secs;
    this._sessionRem += secs;
    this._inExtra     = true;
    if (this.currentTask) this.currentTask.extraMinutes += minutes;
    this._emit();
    if (!this._running) this.resume();
  }

  /**
   * Mark current task as pct% complete and advance to the next task.
   * Remaining task time is deducted from the session counter
   * (you "saved" those seconds).
   */
  completeTask(pct) {
    if (this.currentTask) this.currentTask.completion = pct;
    // Deduct whatever was left on this task
    this._sessionRem = Math.max(0, this._sessionRem - this._taskRem);
    this._advance();
  }

  /** Alias — skip without changing completion. */
  skipTask() { this.completeTask(this.currentTask?.completion ?? 0); }

  // ── Tick logic ─────────────────────────────────────────────────────────────

  _schedule() {
    this._timerId = setInterval(() => this._tick(), 200);
  }

  _clearTimer() {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  _tick() {
    if (!this._running) return;

    const now     = Date.now();
    const elapsed = (now - this._lastMs) / 1000;
    this._lastMs  = now;

    this._taskRem    = Math.max(0, this._taskRem    - elapsed);
    this._sessionRem = Math.max(0, this._sessionRem - elapsed);

    this._emit();

    // Task timer reached zero
    if (this._taskRem <= 0) {
      this._clearTimer();
      this._running = false;
      this._inExtra = false;
      if (this.onTaskEnd) this.onTaskEnd(this.currentTask, this.nextTask);
      return;
    }

    // Session timer reached zero (ran out of total time)
    if (this._sessionRem <= 0) {
      this._clearTimer();
      this._running = false;
      if (this.onSessionEnd) this.onSessionEnd(this._tasks);
    }
  }

  _emit() {
    if (this.onTick) this.onTick(this._sessionRem, this._taskRem, this._inExtra);
  }

  _advance() {
    this._clearTimer();
    this._inExtra = false;
    this._index++;

    if (this._index >= this._tasks.length) {
      this._running = false;
      if (this.onSessionEnd) this.onSessionEnd(this._tasks);
      return;
    }

    // Set up next task
    const next = this._tasks[this._index];
    this._taskRem = next.minutes * 60;
    this._emit();
    this.resume();
  }

  // ── Formatting ─────────────────────────────────────────────────────────────

  /**
   * Format total seconds as h:mm:ss or mm:ss.
   * @param {number} totalSeconds
   * @param {boolean} [forceHours=false]
   * @returns {string}
   */
  static formatTime(totalSeconds, forceHours = false) {
    const s   = Math.max(0, Math.round(totalSeconds));
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0 || forceHours) {
      return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
}
