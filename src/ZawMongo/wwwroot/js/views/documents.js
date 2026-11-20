// Documents tab: one collection's documents, with a filter, projection and sort, paging, and in-place editing.
import { h, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { post } from '../api.js';
import { DocView } from '../docview.js';
import { modal, confirmDlg, contextMenu } from '../dialogs.js';
import { CodeEditor } from '../editor.js';
import { scalarShell } from '../ejson.js';
import { fmtDuration } from '../logslow.js';
import { exportDialog, importDialog } from './tools.js';

const HISTORY = 20;

export class DocumentsView {
  constructor(app) {
    this.app = app;
    this.key = null;
    this.skip = 0;
    const inp = (ph, title, cls = '') => h('input', { class: 'inp mono ' + cls, placeholder: ph, title, spellcheck: false });
    this.filter = inp('{ field: value }', 'Filter: a query document (Enter runs it, Alt+↓ shows recent filters)', 'doc-filter');
    this.projection = inp('{ field: 1 }', 'Projection: the fields to show (1) or leave out (0)', 'doc-proj');
    this.sort = inp('{ field: -1 }', 'Sort: 1 ascending, -1 descending', 'doc-sort');
    for (const i of [this.filter, this.projection, this.sort]) {
      i.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); this.skip = 0; this.load(); }
        else if (e.key === 'ArrowDown' && e.altKey && i === this.filter) { e.preventDefault(); this.recentMenu(); }
      });
    }
    this.limit = h('select', { class: 'inp', title: 'Documents per page' }, [20, 50, 100, 500, 1000, 5000].map(n => h('option', { value: n, selected: n === (app.prefs.pageSize || 50) }, n)));
    this.limit.addEventListener('change', () => { app.prefs.pageSize = +this.limit.value; app.saveStateSoon(); this.skip = 0; this.load(); });
    const b = (ic, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic), onclick: fn });
    this.info = h('span', { class: 'data-info' });
    this.prevBtn = b('up', 'Previous page', () => { this.skip = Math.max(0, this.skip - +this.limit.value); this.load(); });
    this.nextBtn = b('down', 'Next page', () => { this.skip += +this.limit.value; this.load(); });
    this.prevBtn.querySelector('svg').style.transform = 'rotate(-90deg)';
    this.nextBtn.querySelector('svg').style.transform = 'rotate(-90deg)';
    this.title = h('span', { class: 'viewtitle' });
    this.docView = new DocView(app, {
      onChanged: ({ quiet, deleted } = {}) => { if (!quiet && !deleted) this.load(); else if (deleted) { this.total = this.total != null ? this.total - deleted : null; this.renderInfo(); } this.app.afterChange(this.t.sid, this.t.db, { quiet: true }); },
      onFilter: (field, v) => { this.filter.value = `{ ${/^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)}: ${scalarShell(v)} }`; this.skip = 0; this.load(); },
      layoutKey: () => this.key,
    });
    this.insertBtn = b('plus', 'Insert document (Insert)', () => this.docView.insertDialog());
    this.moreBtn = b('settings', 'More: update or delete matching documents, export, import', e => this.moreMenu(e));
    const bar1 = h('div', { class: 'viewbar' },
      this.title,
      h('button', { class: 'tbtn run-btn', html: icon('filter') + '<span>Find</span>', title: 'Find (Enter)', onclick: () => { this.skip = 0; this.load(); } }),
      b('close', 'Clear filter, projection and sort', () => { this.filter.value = this.projection.value = this.sort.value = ''; this.skip = 0; this.load(); }),
      b('history', 'Recent filters (Alt+↓)', () => this.recentMenu()),
      b('explain', 'Explain this find', () => this.explain()),
      h('span', { class: 'sep' }),
      this.insertBtn, this.moreBtn,
      b('refresh', 'Refresh (F5)', () => this.load()),
      h('span', { class: 'grow' }),
      this.docView.modeBar);
    const bar2 = h('div', { class: 'viewbar small doc-query' },
      h('label', { class: 'filter-label' }, 'Filter'), this.filter,
      h('label', { class: 'filter-label' }, 'Projection'), this.projection,
      h('label', { class: 'filter-label' }, 'Sort'), this.sort,
      this.limit, this.prevBtn, this.nextBtn, this.info);
    this.el = h('div', { class: 'view' }, bar1, bar2, this.docView.el);
  }

  get t() { return this.target; }

  /** Opens a collection (keeps the filter when it is the same collection). */
  open(sid, db, coll, { filter } = {}) {
    const sameColl = this.key && this.key.split('|').slice(1).join('|') === `${db}|${coll}`;
    this.target = { sid, db, coll };
    this.key = `${this.app.conns.get(sid)?.profileId}|${db}|${coll}`;
    if (!sameColl) {
      const saved = this.app.state.docFilters?.[this.key];
      this.filter.value = saved?.filter ?? '';
      this.projection.value = saved?.projection ?? '';
      this.sort.value = saved?.sort ?? '';
      this.skip = 0;
    }
    if (filter != null) { this.filter.value = filter; this.skip = 0; }
    this.loadedKey = null;
  }

  onShow() {
    if (!this.target) return;
    const info = this.app.conns.get(this.target.sid);
    const view = this.app.tree.findColl(this.target.sid, this.target.db, this.target.coll)?.type === 'view';
    this.isView = view;
    this.title.innerHTML = icon(view ? 'view' : 'collection') + `<span>${this.target.db}.${this.target.coll}</span>`;
    const ro = !!info?.readOnly || view;
    this.insertBtn.disabled = ro;
    if (this.loadedKey !== this.key && this.loadingKey !== this.key) this.load();
  }

  refresh() { return this.load(); }

  async load() {
    const t = this.target;
    if (!t) return;
    const req = { db: t.db, coll: t.coll, filter: this.filter.value, projection: this.projection.value, sort: this.sort.value, skip: this.skip, limit: +this.limit.value };
    this.loadingKey = this.key;
    this.info.textContent = 'Loading…';
    try {
      const r = await post(`/s/${t.sid}/find`, req);
      this.loadedKey = this.key;
      this.total = r.total;
      this.estimated = r.estimated;
      this.count = r.docs.length;
      this.ms = r.ms;
      this.docView.setDocs(r.docs, { target: this.isView ? null : t, partial: r.partial });
      this.renderInfo();
      this.remember();
    } catch (e) {
      this.info.textContent = '';
      this.docView.setDocs([], {});
      this.app.showError(e);
    }
    finally { this.loadingKey = null; }
  }

  renderInfo() {
    const from = this.count ? this.skip + 1 : 0, to = this.skip + this.count;
    const total = this.total != null ? ` of ${this.estimated ? '~' : ''}${fmtNum(this.total)}` : '';
    this.info.textContent = `${fmtNum(from)}–${fmtNum(to)}${total} · ${fmtDuration(this.ms)}`;
    this.prevBtn.disabled = this.skip === 0;
    this.nextBtn.disabled = this.total != null ? to >= this.total : this.count < +this.limit.value;
  }

  /** Remembers the query per collection, and the filter in the recent list. */
  remember() {
    const f = (this.app.state.docFilters ||= {});
    f[this.key] = { filter: this.filter.value, projection: this.projection.value, sort: this.sort.value };
    const text = this.filter.value.trim();
    if (text && text !== '{}') {
      const recent = (this.app.state.recentFilters ||= {});
      const list = (recent[this.key] ||= []).filter(x => x !== text);
      list.unshift(text);
      recent[this.key] = list.slice(0, HISTORY);
    }
    this.app.saveStateSoon();
  }

  recentMenu() {
    const list = this.app.state.recentFilters?.[this.key] || [];
    const r = this.filter.getBoundingClientRect();
    contextMenu(r.left, r.bottom, list.length ? list.map(f => ({ label: f.length > 90 ? f.slice(0, 90) + '…' : f, onClick: () => { this.filter.value = f; this.skip = 0; this.load(); } }))
      : [{ label: 'No recent filters', disabled: true }]);
  }

  moreMenu(e) {
    const t = this.target;
    if (!t) return;
    const ro = this.app.isReadOnly(t.sid) || this.isView;
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom, [
      { label: 'Update matching documents…', icon: 'edit', disabled: ro, onClick: () => this.bulk(false) },
      { label: 'Delete matching documents…', icon: 'trash', disabled: ro, onClick: () => this.bulk(true) },
      '-',
      { label: 'Export matching documents…', icon: 'export', onClick: () => exportDialog(this.app, t.sid, t.db, t.coll, { filter: this.filter.value, sort: this.sort.value, projection: this.projection.value }) },
      { label: 'Import into this collection…', icon: 'import', disabled: ro, onClick: () => importDialog(this.app, t.sid, t.db, t.coll) },
      '-',
      { label: 'Open this find in a query tab', icon: 'newtab', onClick: () => this.app.openQueryTab(this.shellText(), null, { db: t.db }) },
    ]);
  }

  shellText() {
    const t = this.target;
    const ref = /^[A-Za-z_$][\w$]*$/.test(t.coll) ? `db.${t.coll}` : `db.getCollection(${JSON.stringify(t.coll)})`;
    const f = this.filter.value.trim() || '{}';
    const p = this.projection.value.trim();
    const s = this.sort.value.trim();
    return `${ref}.find(${f}${p ? ', ' + p : ''})${s ? `.sort(${s})` : ''}${this.skip ? `.skip(${this.skip})` : ''}.limit(${this.limit.value})`;
  }

  explain() {
    if (!this.target) return;
    const v = this.app.openQueryTab(this.shellText(), 'Explain', { db: this.target.db });
    v.explain(v.sql);
  }

  async bulk(del) {
    const t = this.target;
    const filter = this.filter.value.trim() || '{}';
    const ed = del ? null : new CodeEditor({ value: '{ $set: {  } }' });
    const go = await modal({
      title: del ? 'Delete matching documents' : 'Update matching documents',
      width: 560,
      body: h('div', { class: 'form' },
        h('div', null, 'Documents matching ', h('code', null, filter), ` in ${t.db}.${t.coll}${this.total != null ? ` (${this.estimated && filter === '{}' ? '~' : ''}${fmtNum(this.total)} documents)` : ''}`),
        del ? h('div', { class: 'warn-text' }, 'They are deleted for good.') : h('div', null, h('label', null, 'Update ({ $set: … }, $unset, $inc, $push … or a pipeline [ … ])'), h('div', { class: 'bulk-ed' }, ed.el))),
      buttons: [{ label: del ? 'Delete' : 'Update', primary: true, danger: del, value: true }, { label: 'Cancel', value: false }],
    });
    if (!go) return;
    if (!(await this.app.confirmChange(t.sid, `${del ? 'Delete' : 'Update'} the documents matching ${filter} in ${t.db}.${t.coll}?`, { asked: true }))) return;
    if (filter === '{}' && !(await confirmDlg(`This ${del ? 'deletes' : 'updates'} every document of ${t.coll}.`, { ok: del ? 'Delete all' : 'Update all', danger: true }))) return;
    try {
      const r = await post(`/s/${t.sid}/docs/bulk`, { db: t.db, coll: t.coll, filter, update: ed?.value, delete: del });
      this.app.setStatus(del ? `${fmtNum(r.deleted)} documents deleted.` : `${fmtNum(r.matched)} matched, ${fmtNum(r.modified)} modified.`);
      this.load();
      this.app.afterChange(t.sid, t.db, { quiet: true });
    } catch (e) { this.app.showError(e); }
  }
}
