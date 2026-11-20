// Command log at the bottom of the window: every command ZawMongo sent, in mongosh syntax, with a timestamp per
// line, markers on slow commands, a find bar, and actions on a line (open in a query tab, copy, save).
import { h, fmtLogTime } from './util.js';
import { saveTextFile } from './files.js';
import { highlight } from './editor.js';
import { contextMenu } from './dialogs.js';
import { SLOW_CHOICES, fmtDuration, slowLevel, thresholdLabel, nextSlow } from './logslow.js';

const MAX_LINES = 3000;

const isComment = t => /^\/\*[\s\S]*\*\/$/.test(t.trim());

export class LogPanel {
  /**
   * opts.timestamps / setTimestamps(on), opts.slowMs / setSlowMs(ms), opts.sessionName(sid), opts.openInTab(text).
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.o = { timestamps: () => true, setTimestamps: () => {}, slowMs: () => 0, setSlowMs: () => {}, sessionName: () => null, openInTab: () => {}, ...opts };
    this.cursor = -1;
    el.classList.add('logpanel');
    el.tabIndex = 0;
    this.buildFindBar();
    this.syncTimestamps();
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, this.menu(e.target.closest?.('.log-line')));
    });
    el.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); this.save(); }
      else if (e.key === 'Escape' && this.bar.style.display !== 'none') this.closeFind();
    });
  }

  menu(line) {
    const entry = line?.$e;
    const items = [];
    if (entry && !isComment(entry.text)) {
      items.push(
        { label: 'Open in new query tab', icon: 'newtab', onClick: () => this.o.openInTab(entry.text) },
        { label: 'Copy command', icon: 'copy', onClick: () => navigator.clipboard.writeText(entry.text).catch(() => {}) },
        '-');
    }
    const slow = this.o.slowMs();
    items.push(
      { label: 'Copy all', icon: 'copy', onClick: () => navigator.clipboard.writeText(this.text()).catch(() => {}) },
      { label: 'Save log…', icon: 'save', shortcut: 'Ctrl+S', onClick: () => this.save() },
      { label: 'Find…', icon: 'filter', shortcut: 'Ctrl+F', onClick: () => this.openFind() },
      '-',
      { label: 'Show timestamps', checked: this.o.timestamps(), onClick: () => { this.o.setTimestamps(!this.o.timestamps()); this.syncTimestamps(); } },
      { label: 'Mark slow commands', submenu: SLOW_CHOICES.map(ms => ({ label: thresholdLabel(ms), checked: ms === slow, onClick: () => { this.o.setSlowMs(ms); this.markAll(); } })) },
      { label: 'Next slow command', disabled: !slow, onClick: () => this.nextSlow() },
      '-',
      { label: 'Clear', icon: 'trash', onClick: () => this.clear() });
    return items;
  }

  syncTimestamps() { this.el.classList.toggle('no-ts', !this.o.timestamps()); }

  lines() { return [...this.el.querySelectorAll('.log-line')]; }

  /** Adds lines from one API call; `meta.sid` names the session they ran on. */
  add(lines, cls = '', times = null, durations = null, meta = {}) {
    const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 20;
    const slow = this.o.slowMs();
    lines.forEach((text, i) => {
      const entry = { text, time: times?.[i] ?? Date.now(), ms: durations?.[i] ?? null, sid: meta.sid ?? null };
      const err = cls === 'err' || /^\/\* (Error|Write error|Authentication failed)/.test(text);
      const level = slowLevel(entry.ms, slow);
      const shown = text.length > 3000 ? text.slice(0, 3000) + ' …' : text;
      const row = h('div', { class: `log-line${err ? ' err' : ''}${level === 'slow' ? ' log-slow' : level === 'very' ? ' log-slow log-very-slow' : ''}`, title: entry.ms != null ? `Took ${fmtDuration(entry.ms)}` : null },
        h('span', { class: 'log-ts' }, fmtLogTime(entry.time)),
        h('span', { class: 'log-text', html: err || cls ? null : highlight(shown).replace(/\n$/, '') }, err || cls ? shown : null),
        level ? h('span', { class: 'log-dur' }, fmtDuration(entry.ms)) : null);
      row.$e = entry;
      this.el.append(row);
    });
    const all = this.el.querySelectorAll('.log-line');
    for (let k = 0; k < all.length - MAX_LINES; k++) all[k].remove();
    this.applyFilter();
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  info(msg) { this.add([`/* ${msg} */`]); }
  error(msg) { this.add([`/* Error: ${msg} */`], 'err'); }

  markAll() {
    const slow = this.o.slowMs();
    for (const row of this.lines()) {
      const level = slowLevel(row.$e?.ms, slow);
      row.classList.toggle('log-slow', !!level);
      row.classList.toggle('log-very-slow', level === 'very');
      row.querySelector('.log-dur')?.remove();
      if (level) row.append(h('span', { class: 'log-dur' }, fmtDuration(row.$e.ms)));
    }
  }

  nextSlow() {
    const rows = this.lines();
    const levels = rows.map(r => slowLevel(r.$e?.ms, this.o.slowMs()));
    const i = nextSlow(levels, this.cursor);
    if (i < 0) return;
    rows[this.cursor]?.classList.remove('log-hit');
    this.cursor = i;
    rows[i].classList.add('log-hit');
    rows[i].scrollIntoView({ block: 'nearest' });
  }

  clear() {
    for (const r of this.lines()) r.remove();
    this.cursor = -1;
  }

  text() {
    return this.lines().filter(r => !r.classList.contains('log-hidden')).map(r => (this.o.timestamps() ? `/* ${fmtLogTime(r.$e.time)} */ ` : '') + r.$e.text).join('\n');
  }

  async save() {
    const body = this.lines().filter(r => !r.classList.contains('log-hidden'))
      .map(r => (isComment(r.$e.text) ? r.$e.text : r.$e.text.replace(/;?\s*$/, ';')) + (r.$e.ms != null && slowLevel(r.$e.ms, this.o.slowMs()) ? ` /* took ${fmtDuration(r.$e.ms)} */` : ''))
      .join('\n');
    const d = new Date();
    const name = `zawmongo-log-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.js`;
    await saveTextFile(name, body + '\n', 'JavaScript files', '.js');
  }

  // ---------- find bar ----------

  buildFindBar() {
    this.q = h('input', { class: 'inp log-q', placeholder: 'Find in log', spellcheck: false });
    this.errBtn = h('button', { class: 'log-tg', title: 'Only errors' }, 'Errors');
    this.slowBtn = h('button', { class: 'log-tg', title: 'Only slow commands' }, 'Slow');
    this.countEl = h('span', { class: 'log-count muted' });
    const close = h('button', { class: 'log-tg icon', title: 'Close (Esc)', html: '×' });
    this.bar = h('div', { class: 'log-find' }, this.q, this.errBtn, this.slowBtn, this.countEl, close);
    this.bar.style.display = 'none';
    this.q.addEventListener('input', () => this.applyFilter());
    this.q.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); } });
    this.errBtn.onclick = () => { this.errBtn.classList.toggle('on'); this.applyFilter(); };
    this.slowBtn.onclick = () => { this.slowBtn.classList.toggle('on'); this.applyFilter(); };
    close.onclick = () => this.closeFind();
    this.el.before(this.bar);
  }

  openFind() {
    this.bar.style.display = '';
    this.q.focus();
    this.q.select();
  }

  closeFind() {
    this.bar.style.display = 'none';
    this.q.value = '';
    this.errBtn.classList.remove('on');
    this.slowBtn.classList.remove('on');
    this.applyFilter();
    this.el.focus();
  }

  applyFilter() {
    const q = this.q.value.toLowerCase();
    const errs = this.errBtn.classList.contains('on'), slow = this.slowBtn.classList.contains('on');
    const rows = this.lines();
    let shown = 0;
    for (const r of rows) {
      const ok = (!q || r.$e.text.toLowerCase().includes(q)) && (!errs || r.classList.contains('err')) && (!slow || r.classList.contains('log-slow'));
      r.classList.toggle('log-hidden', !ok);
      if (ok) shown++;
    }
    this.countEl.textContent = q || errs || slow ? `${shown} of ${rows.length} lines` : '';
  }
}
