// Query tab: a shell editor (db.coll.find(…), aggregate, updates, use, show, runCommand) and its results.
import { h, esc, fmtNum, makeSplitter } from '../util.js';
import { icon } from '../icons.js';
import { post } from '../api.js';
import { CodeEditor, highlight } from '../editor.js';
import { DocView } from '../docview.js';
import { renderExplain } from '../explain.js';
import { statementAt, splitStatements } from '../shelllex.js';
import { isWrite, changesAll } from '../shellcheck.js';
import { toShell, typeOf } from '../ejson.js';
import { fmtDuration } from '../logslow.js';
import { pickFile, saveTextFile } from '../files.js';
import { confirmDlg } from '../dialogs.js';

export const SAMPLE = `// Shell syntax: db.<collection>.<method>(…). F9 runs everything, Ctrl+Enter the statement at the caret.
db.getCollectionNames()
`;

export class QueryView {
  constructor(app, { id, title, sql, db, savedId }) {
    this.app = app;
    this.id = id;
    this.title = title;
    this.db = db || null;
    this.savedId = savedId || null;
    this.results = [];
    this.active = 0;
    this.editor = new CodeEditor({
      value: sql ?? SAMPLE,
      collections: () => (this.app.sel.sid ? this.app.tree.collectionNames(this.app.sel.sid, this.database()) : []),
      onChange: () => { this.app.saveStateSoon(); this.markModified(); },
      onRun: () => this.run('current'),
      placeholder: 'db.collection.find({ field: value })',
    });
    const b = (ic, title, fn, cls = '') => h('button', { class: 'tbtn ' + cls, title, html: icon(ic), onclick: fn });
    this.dbInput = h('input', { class: 'inp q-db', placeholder: 'database', spellcheck: false, title: 'The database "db" stands for (use <name> changes it)', list: 'db-list-' + id });
    this.dbList = h('datalist', { id: 'db-list-' + id });
    this.dbInput.addEventListener('change', () => { this.db = this.dbInput.value.trim() || null; this.app.saveStateSoon(); });
    this.dbInput.addEventListener('focus', () => this.fillDbList());
    this.maxDocs = h('select', { class: 'inp', title: 'Most documents shown per result' }, [100, 1000, 5000, 20000].map(n => h('option', { value: n, selected: n === (app.prefs.maxDocs || 1000) }, fmtNum(n) + ' docs')));
    this.maxDocs.addEventListener('change', () => { app.prefs.maxDocs = +this.maxDocs.value; app.saveStateSoon(); });
    this.sessionLabel = h('span', { class: 'data-info' });
    const bar = h('div', { class: 'viewbar' },
      h('button', { class: 'tbtn run-btn', title: 'Run all (F9)', html: icon('play') + '<span>Run</span>', onclick: () => this.run('all') }),
      b('playline', 'Run the statement at the caret (Ctrl+Enter)', () => this.run('current')),
      b('playsel', 'Run the selection (Ctrl+F9)', () => this.run('selection')),
      (this.stopBtn = b('stop', 'Stop', () => this.stop())),
      b('explain', 'Explain the statement at the caret (Ctrl+Shift+E)', () => this.explain()),
      h('span', { class: 'sep' }),
      this.sessionLabel, this.dbInput, this.dbList, this.maxDocs,
      h('span', { class: 'grow' }),
      b('bookmark', 'Save to saved queries (Ctrl+S)', () => this.saveToLibrary()),
      b('library', 'Saved queries', () => this.app.libraryDialog(this)),
      b('history', 'History', () => this.app.historyDialog(this)),
      b('open', 'Load file…', () => this.loadFile()),
      b('save', 'Save as file…', () => this.saveFile()));
    this.stopBtn.disabled = true;
    this.editorBox = h('div', { class: 'q-editor' }, this.editor.el);
    this.editorBox.style.height = (app.state.layout?.queryEditor || 220) + 'px';
    const split = h('div', { class: 'splitter-h' });
    makeSplitter(split, {
      axis: 'y',
      get: () => this.editorBox.offsetHeight,
      set: v => { this.editorBox.style.height = Math.max(60, Math.min(v, this.el.offsetHeight - 120)) + 'px'; },
      onEnd: () => { app.state.layout = { ...app.state.layout, queryEditor: this.editorBox.offsetHeight }; app.saveStateSoon(); },
    });
    this.tabList = h('div', { class: 'res-tab-list' });
    this.resBody = h('div', { class: 'q-res-body' });
    this.msg = h('div', { class: 'q-msg' }, 'Ready.');
    this.docView = new DocView(app, { onChanged: () => {} });
    this.resBar = h('div', { class: 'res-tabs' }, this.tabList, this.docView.modeBar);
    this.el = h('div', { class: 'view query-view' }, bar, this.editorBox, split, h('div', { class: 'q-results' }, this.resBar, this.resBody, this.msg));
    this.el.addEventListener('keydown', e => this.key(e));
    this.renderResults();
  }

  get sql() { return this.editor.value; }

  database() {
    const info = this.app.conns.get(this.app.sel.sid);
    return this.db || this.app.sel.db || info?.defaultDatabase || 'test';
  }

  onShow() {
    const info = this.app.conns.get(this.app.sel.sid);
    this.sessionLabel.textContent = info ? info.name : 'Not connected';
    this.sessionLabel.title = info ? `Runs on ${info.name}` : 'Connect to a server in the session manager first.';
    this.dbInput.value = this.database();
    this.editor.focus();
  }

  fillDbList() {
    const s = this.app.tree.sessionNode(this.app.sel.sid);
    this.dbList.replaceChildren(...(s?.children || []).map(d => h('option', { value: d.db })));
  }

  key(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'F9') { e.preventDefault(); this.run(ctrl && e.shiftKey ? 'current' : ctrl ? 'selection' : 'all'); }
    else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); this.explain(); }
    else if (ctrl && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); this.saveToLibrary({ asNew: e.shiftKey }); }
  }

  markModified() {
    const saved = this.savedId ? this.app.library.find(this.savedId) : null;
    this.app.tabs.setModified(this.id, !!saved && saved.sql !== this.sql);
  }

  /** The text to run: everything, the selection, or the statement at the caret (with its offset in the editor). */
  pick(what) {
    const v = this.editor.value;
    const sel = this.editor.selection();
    if (what === 'selection' && sel.text.trim()) return { text: sel.text, offset: sel.start };
    if (what === 'current' || what === 'selection') {
      if (sel.text.trim() && what === 'current') return { text: sel.text, offset: sel.start };
      const st = statementAt(v, sel.start);
      return st ? { text: st.text, offset: st.start } : null;
    }
    return { text: v, offset: 0 };
  }

  async run(what = 'all', { script } = {}) {
    const sid = this.app.sel.sid;
    if (!sid) return this.app.showError(new Error('Connect to a server first (File › Session manager).'));
    if (this.running) return;
    const p = script != null ? { text: script, offset: 0 } : this.pick(what);
    if (!p || !p.text.trim()) return;
    const stmts = splitStatements(p.text).map(s => s.text);
    const writes = stmts.filter(isWrite);
    const all = stmts.filter(changesAll);
    if (all.length && this.app.prefs.confirmChangesAll !== false
      && !(await confirmDlg(h('div', null, 'This changes every document of the collection (empty filter):', h('pre', { class: 'confirm-stmt' }, all.join('\n'))), { ok: 'Run anyway', danger: true }))) return;
    if (writes.length && !(await this.app.confirmChange(sid, h('div', null, `Run ${writes.length} statement${writes.length === 1 ? '' : 's'} that change data?`, h('pre', { class: 'confirm-stmt' }, writes.slice(0, 10).join('\n'))), { list: writes }))) return;

    this.running = new AbortController();
    this.stopBtn.disabled = false;
    this.app.tabs.setBusy(this.id, true);
    this.msg.className = 'q-msg';
    this.msg.textContent = 'Running…';
    const t0 = performance.now();
    const db = this.database();
    try {
      const r = await post(`/s/${sid}/exec`, { script: p.text, database: db, maxDocs: +this.maxDocs.value, tab: this.id }, { signal: this.running.signal });
      this.app.addHistory(p.text, sid, db);
      if (r.database !== db) {
        this.db = r.database;
        this.dbInput.value = r.database;
        this.app.saveStateSoon();
      }
      this.results = r.results.map(x => ({ ...x, sid }));
      this.active = this.results.findLastIndex(x => x.kind !== 'text');
      if (this.active < 0) this.active = this.results.length - 1;
      this.renderResults();
      const ms = performance.now() - t0;
      if (r.errors.length) {
        const er = r.errors[0];
        this.msg.className = 'q-msg err';
        this.msg.textContent = `Error in statement ${er.statement + 1}: ${er.message}`;
        this.editor.selectRange(p.offset + er.start, p.offset + er.end);
      } else {
        const last = this.results[this.results.length - 1];
        this.msg.textContent = `${r.executed} of ${r.statements} statement${r.statements === 1 ? '' : 's'} run in ${fmtDuration(ms)}${last?.message ? ' · ' + last.message : ''}`;
      }
      if (writes.length) this.app.afterChange(sid, db);
    } catch (e) {
      if (e.name === 'AbortError') { this.msg.textContent = 'Stopped.'; return; }
      this.msg.className = 'q-msg err';
      this.msg.textContent = e.message;
      this.app.log.error(e.message);
    } finally {
      this.running = null;
      this.stopBtn.disabled = true;
      this.app.tabs.setBusy(this.id, false);
    }
  }

  async stop() {
    const sid = this.app.sel.sid;
    try { if (sid) await post(`/s/${sid}/cancel?tab=${encodeURIComponent(this.id)}`, {}, { quiet: true }); } catch { /* gone */ }
    this.running?.abort();
  }

  /** Explains the statement at the caret: find, aggregate, count, distinct, update or delete. */
  async explain(text) {
    const p = text != null ? { text, offset: 0 } : this.pick('current');
    if (!p) return;
    let s = p.text.trim().replace(/;$/, '');
    if (/\.explain\s*\(/.test(s)) return this.run('current', { script: s });
    const m = /^(db\.(?:getSiblingDB\([^)]*\)\.)?(?:getCollection\([^)]*\)|\[[^\]]*\]|[\w$]+(?:\.[\w$]+)*?))\.(find|aggregate|countDocuments|count|distinct|updateOne|updateMany|deleteOne|deleteMany)\s*\(/.exec(s);
    if (!m) return this.app.showError(new Error('Put the caret on a find, aggregate, count, distinct, update or delete statement to explain it.'));
    s = `${m[1]}.explain("executionStats").${s.slice(m[1].length + 1)}`;
    return this.run('current', { script: s });
  }

  renderResults() {
    const res = this.results;
    this.tabList.replaceChildren(...res.map((r, i) => {
      const n = r.kind === 'docs' ? ` (${fmtNum(r.docs.length)}${r.truncated ? '+' : ''})` : '';
      const label = r.explain ? 'Plan' : r.text.replace(/\s+/g, ' ').slice(0, 40);
      return h('button', { class: 'res-tab' + (i === this.active ? ' active' : ''), title: r.text, onclick: () => { this.active = i; this.renderResults(); } }, `${i + 1}: ${label}${n}`);
    }));
    const r = res[this.active];
    this.docView.modeBar.style.visibility = r?.kind === 'docs' ? '' : 'hidden';
    if (!r) {
      this.resBody.replaceChildren(h('div', { class: 'placeholder' }, 'Results appear here. Run with F9, or Ctrl+Enter for the statement at the caret.'));
      return;
    }
    if (r.explain) { this.resBody.replaceChildren(renderExplain(r.value)); return; }
    if (r.kind === 'docs') {
      const target = r.editable && r.collection ? { sid: r.sid, db: r.db, coll: r.collection } : null;
      this.docView.o.onChanged = () => this.app.afterChange(r.sid, r.db, { quiet: true });
      this.docView.setDocs(r.docs, { target });
      const note = r.truncated ? h('div', { class: 'q-note' }, `Only the first ${fmtNum(r.docs.length)} documents are shown; add .limit() or raise the limit in the toolbar.`) : null;
      this.resBody.replaceChildren(...[note, this.docView.el].filter(Boolean));
      return;
    }
    if (r.kind === 'value') {
      const v = r.value;
      const text = toShell(v, 2);
      this.resBody.replaceChildren(h('div', { class: 'q-value' },
        r.message ? h('div', { class: 'q-value-msg' }, r.message) : null,
        h('pre', { class: 'doc-json', html: typeOf(v) === 'object' || typeOf(v) === 'array' ? highlight(text) : esc(text) })));
      return;
    }
    this.resBody.replaceChildren(h('div', { class: 'placeholder' }, r.message || 'Done.'));
  }

  async saveToLibrary({ asNew = false } = {}) {
    const saved = await this.app.library.saveDialog(this, { asNew });
    if (saved) {
      this.savedId = saved.id;
      this.title = saved.name;
      this.app.tabs.setTitle(this.id, saved.name);
      this.markModified();
      this.app.saveStateSoon();
    }
  }

  async loadFile() {
    const f = await pickFile('.js,.mongodb,.txt,.json');
    if (!f) return;
    this.editor.value = await f.text();
    this.title = f.name;
    this.app.tabs.setTitle(this.id, f.name);
    this.app.saveStateSoon();
  }

  async saveFile() {
    const name = (this.title || 'query').replace(/[^\w.-]+/g, '_').replace(/(\.js)?$/, '.js');
    await saveTextFile(name, this.sql, 'JavaScript files', '.js');
  }

  showHistoryPick(entry) {
    this.editor.value = entry.text;
    this.editor.focus();
  }
}

