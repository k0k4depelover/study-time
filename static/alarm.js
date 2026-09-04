/**
 * alarm.js — Audio alerts & browser notifications
 * Uses Web Audio API only (no audio files needed).
 */

'use strict';

let _audioCtx = null;

/** Lazily initialise AudioContext (must be after user interaction). */
function _getCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

/**
 * Play a single tone.
 * @param {number} freq      Hz
 * @param {number} duration  seconds
 * @param {number} volume    0–1
 * @param {'sine'|'square'|'sawtooth'|'triangle'} type
 * @param {number} [delay=0] seconds from now
 */
function _tone(freq, duration, volume = 0.3, type = 'sine', delay = 0) {
  try {
    const ctx = _getCtx();
    const osc = ctx.createOscillator();
    const env = ctx.createGain();

    osc.connect(env);
    env.connect(ctx.destination);

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);

    const t0 = ctx.currentTime + delay;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(volume, t0 + 0.015);
    env.gain.setValueAtTime(volume, t0 + duration - 0.04);
    env.gain.linearRampToValueAtTime(0, t0 + duration);

    osc.start(t0);
    osc.stop(t0 + duration);
  } catch (_) { /* AudioContext blocked */ }
}

/** Three-tone alarm for task end. */
function playAlarm() {
  _tone(880,  0.28, 0.45, 'sine',  0.00);
  _tone(1108, 0.28, 0.45, 'sine',  0.33);
  _tone(880,  0.45, 0.45, 'sine',  0.66);
}

/** Double alarm for session end. */
function playSessionAlarm() {
  playAlarm();
  setTimeout(playAlarm, 1400);
}

/** Soft start chime. */
function playStartTone() {
  _tone(660, 0.12, 0.22, 'sine', 0.00);
  _tone(880, 0.14, 0.20, 'sine', 0.13);
}

/** Ascending arpeggio for task completion. */
function playTaskCompleteTone() {
  _tone(523, 0.12, 0.22, 'sine', 0.00);
  _tone(659, 0.12, 0.22, 'sine', 0.13);
  _tone(784, 0.12, 0.22, 'sine', 0.26);
  _tone(1046,0.22, 0.22, 'sine', 0.39);
}

/** Warning tick when < 60 s remain on a task. */
function playTickTone() {
  _tone(440, 0.07, 0.12, 'sine');
}

// ── Browser notifications ─────────────────────────────────────────────────

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

function showNotification(title, body) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body, silent: true }); } catch (_) {}
  }
}
