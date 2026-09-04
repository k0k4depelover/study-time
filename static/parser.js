/**
 * parser.js — Study plan parser
 *
 * Supports two Markdown formats:
 *   1. Table:    | Tarea | Minutos | Descripción | 25% | 50% | 75% |
 *   2. Headings: ## Task name (45 min) \n Description
 *
 * And a programmatic format for the manual UI table:
 *   parseTableRows([{ name, minutes, description, m25, m50, m75 }, ...])
 *
 * Every returned Task has shape:
 *   { id, name, minutes, description, milestones: number[], completion: 0, extraMinutes: 0 }
 */

'use strict';

// ── helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 0;
function _makeId() { return `task-${Date.now()}-${_idCounter++}`; }

/**
 * Split a markdown table row string into trimmed cell strings.
 * "| Foo | Bar | Baz |" → ["Foo", "Bar", "Baz"]
 */
function _rowCells(line) {
  return line.split('|').slice(1, -1).map(c => c.trim());
}

/** True if a cell value counts as "checked" / present. */
function _hasValue(cell) {
  if (!cell) return false;
  const s = cell.trim().toLowerCase();
  return s.length > 0 && s !== '-' && s !== 'no' && s !== 'false' && s !== '×';
}

/** Parse "45", "1h 30min", "1:30", "90m" → minutes as float. */
function _parseMinutes(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Plain number
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);

  // "1h 30min", "1h30m", "1 h 30 min"
  const hm = s.match(/(\d+)\s*h(?:r|rs|our|ours)?\s*(\d+)?\s*m?i?n?/i);
  if (hm) return parseInt(hm[1]) * 60 + (hm[2] ? parseInt(hm[2]) : 0);

  // "1:30"
  const colon = s.match(/^(\d+):(\d{2})$/);
  if (colon) return parseInt(colon[1]) * 60 + parseInt(colon[2]);

  // "90m" / "90min"
  const mOnly = s.match(/^(\d+)\s*m(?:in)?/i);
  if (mOnly) return parseInt(mOnly[1]);

  // "1h"
  const hOnly = s.match(/^(\d+)\s*h/i);
  if (hOnly) return parseInt(hOnly[1]) * 60;

  return parseFloat(s) || null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a markdown string into a Task array.
 * Auto-detects table vs heading format.
 * @param {string} text
 * @returns {Task[]}
 */
function parseMarkdown(text) {
  if (!text || !text.trim()) return [];

  // Detect table format: any line that starts with |
  const hasTable = text.split('\n').some(l => l.trim().startsWith('|'));
  if (hasTable) {
    const tasks = _parseMarkdownTable(text);
    if (tasks.length > 0) return tasks;
  }

  // Fallback: heading format
  return _parseMarkdownHeadings(text);
}

/**
 * Parse tasks from the manual UI table rows.
 * @param {{ name:string, minutes:string|number, description:string, m25:boolean, m50:boolean, m75:boolean }[]} rows
 * @returns {Task[]}
 */
function parseTableRows(rows) {
  return rows
    .filter(r => r.name && String(r.name).trim())
    .map(r => {
      const minutes = _parseMinutes(r.minutes) || 25;
      return _makeTask(r.name.trim(), minutes, r.description || '', {
        m25: !!r.m25, m50: !!r.m50, m75: !!r.m75,
      });
    });
}

// ── Internal parsers ──────────────────────────────────────────────────────────

function _makeTask(name, minutes, description, flags = {}) {
  const milestones = [];
  if (flags.m25) milestones.push(25);
  if (flags.m50) milestones.push(50);
  if (flags.m75) milestones.push(75);
  milestones.push(100); // always present

  return {
    id:          _makeId(),
    name:        name.replace(/\*+/g, '').trim(),
    minutes:     Math.max(0.5, minutes),
    description: description.trim(),
    milestones,          // which intermediate % buttons to show
    completion:  0,
    extraMinutes: 0,
  };
}

/**
 * Parse a Markdown table.
 * Accepted column headers (case-insensitive, flexible):
 *   name/tarea/task/nombre, min/minutos/tiempo/time/duración/duration,
 *   desc/descripción/description, 25%/25, 50%/50, 75%/75, 100%/100
 */
function _parseMarkdownTable(text) {
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('|'));

  if (lines.length < 2) return [];

  // ── Detect header ──
  const headerRow = lines[0];
  const headers   = _rowCells(headerRow);

  // Map canonical column key → index
  const col = {};
  headers.forEach((h, i) => {
    const k = h.toLowerCase().replace(/[^a-z0-9%]/g, '');
    if (/^(tarea|task|nombre|name)/.test(k))        col.name = i;
    else if (/^(min|minuto|tiempo|time|dur)/.test(k)) col.min = i;
    else if (/^(desc)/.test(k))                     col.desc = i;
    else if (k === '25' || k === '25%')              col.m25  = i;
    else if (k === '50' || k === '50%')              col.m50  = i;
    else if (k === '75' || k === '75%')              col.m75  = i;
    // 100% column is implicit — always tracked
  });

  // Fallback positional mapping if headers not recognised
  if (col.name === undefined) col.name = 0;
  if (col.min  === undefined) col.min  = 1;
  if (col.desc === undefined) col.desc = 2;

  // Skip separator row (---|---|...)
  const dataLines = lines.filter(l => !/^\|[\s\-:|]+\|$/.test(l)).slice(1);

  const tasks = [];
  dataLines.forEach((line, i) => {
    const cells = _rowCells(line);
    if (cells.length === 0) return;

    const name = cells[col.name] || '';
    if (!name) return;

    const rawMin  = cells[col.min]  || '25';
    const minutes = _parseMinutes(rawMin);
    if (!minutes) return;

    const desc = col.desc !== undefined ? (cells[col.desc] || '') : '';
    const flags = {
      m25: col.m25 !== undefined ? _hasValue(cells[col.m25]) : false,
      m50: col.m50 !== undefined ? _hasValue(cells[col.m50]) : false,
      m75: col.m75 !== undefined ? _hasValue(cells[col.m75]) : false,
    };

    tasks.push(_makeTask(name, minutes, desc, flags));
  });

  return tasks;
}

/**
 * Parse heading format:
 *   ## Task name (45 min)
 *   Optional description paragraph.
 *
 *   Also supports:
 *   ## Task name — 45 min
 *   ## Task name · 1h30m
 */
function _parseMarkdownHeadings(text) {
  const tasks = [];
  // Split on heading lines (## …)
  const blocks = text.split(/\n(?=#{1,3}\s)/);

  blocks.forEach(block => {
    const firstLine = block.split('\n')[0];

    // Match "## Name (45 min)" or "## Name – 45m" etc.
    let name = null, rawMin = null;

    // Pattern A: ## Name (N unit)
    const matchA = firstLine.match(/^#{1,3}\s+(.+?)\s*[(\[]\s*(.+?)\s*[\)\]]/);
    if (matchA) {
      name   = matchA[1].trim();
      rawMin = matchA[2].trim();
    }

    // Pattern B: ## Name — N unit  or  ## Name · N unit  or  ## Name - N unit
    if (!name) {
      const matchB = firstLine.match(/^#{1,3}\s+(.+?)\s+[—–\-·|]\s+(\d[\w\s:]*)/);
      if (matchB) {
        name   = matchB[1].trim();
        rawMin = matchB[2].trim();
      }
    }

    if (!name || !rawMin) return;

    const minutes = _parseMinutes(rawMin);
    if (!minutes) return;

    // Everything after the heading line is the description
    const rest = block.split('\n').slice(1).join(' ').trim();
    const desc = rest.replace(/^[>\-*#\s]+/, '').trim();

    // Headings format defaults to all milestones enabled
    tasks.push(_makeTask(name, minutes, desc, { m25: true, m50: true, m75: true }));
  });

  return tasks;
}
