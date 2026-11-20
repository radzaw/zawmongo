// Database tab: the collections and views of a database with their counts and sizes, and the database's totals.
import { h, esc, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { Grid } from '../grid.js';
import { contextMenu } from '../dialogs.js';

export class DatabaseView {
  constructor(app) {
    this.app = app;
    this.title = h('span', { class: 'viewtitle' });
    this.totals = h('span', { class: 'data-info' });
    const b = (ic, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic), onclick: fn });
    this.grid = new Grid({
      emptyText: 'No collections. Create one with the + button, or by inserting into it from a query tab.',
      onActivate: r => this.open(r, 'documents'),
      onContextMenu: (e, p) => this.menu(e, p.r),
      onSort: c => this.sortBy(c),
    });
    this.el = h('div', { class: 'view' },
      h('div', { class: 'viewbar' }, this.title,
        b('plus', 'Create collection…', () => this.app.createCollectionDialog(this.sid, this.db)),
        b('export', 'Export collections…', () => this.app.exportCollection(this.sid, this.db, this.selected()[0])),
        b('import', 'Import into a collection…', () => this.app.importInto(this.sid, this.db, this.selected()[0])),
        b('refresh', 'Refresh (F5)', () => this.refresh()),
        h('span', { class: 'grow' }), this.totals),
      this.grid.el);
  }

  open(r, tab) {
    const c = this.rows[r];
    if (c) this.app.selectCollection(this.sid, this.db, c.name, tab);
  }

  selected() {
    return this.grid.selectedRowIndexes().map(r => this.rows[r]?.name).filter(Boolean);
  }

  menu(e, r) {
    const c = this.rows[r];
    if (!c) return;
    contextMenu(e.clientX, e.clientY, this.app.collectionMenu(this.sid, this.db, c.name, c.type));
  }

  async onShow() {
    const { sid, db } = this.app.sel;
    if (!sid || !db) return;
    if (sid !== this.sid || db !== this.db) { this.sid = sid; this.db = db; this.sort = null; }
    await this.refresh();
  }

  async refresh() {
    if (!this.sid) return;
    this.title.innerHTML = icon('database') + `<span>${esc(this.db)}</span>`;
    try {
      const node = this.app.tree.findDb(this.sid, this.db);
      const list = await get(`/s/${this.sid}/collections`, { db: this.db });
      if (node) { node.colls = list; await this.app.tree.load(node).catch(() => {}); }
      this.list = list;
      this.render();
    } catch (e) { this.app.showError(e); }
  }

  sortBy(c) {
    const name = this.cols[c].name;
    this.sort = this.sort?.name === name ? { name, dir: -this.sort.dir } : { name, dir: c === 0 ? 1 : -1 };
    this.render();
  }

  render() {
    const cols = [
      { name: 'Name', kind: 'text' }, { name: 'Type', kind: 'text' }, { name: 'Documents', kind: 'int', fmt: fmtNum }, { name: 'Data size', kind: 'int', fmt: fmtBytes },
      { name: 'Storage', kind: 'int', fmt: fmtBytes }, { name: 'Avg. document', kind: 'int', fmt: fmtBytes }, { name: 'Indexes', kind: 'int' }, { name: 'Index size', kind: 'int', fmt: fmtBytes }, { name: 'Notes', kind: 'text' },
    ];
    this.cols = cols;
    const key = ['name', 'type', 'count', 'size', 'storageSize', 'avgObjSize', 'indexes', 'indexSize'];
    let rows = this.list.slice();
    if (this.sort) {
      const i = cols.findIndex(c => c.name === this.sort.name);
      const k = key[i] ?? 'name';
      rows.sort((a, b) => ((a[k] ?? -1) < (b[k] ?? -1) ? -1 : (a[k] ?? -1) > (b[k] ?? -1) ? 1 : 0) * this.sort.dir);
    }
    this.rows = rows;
    const notes = c => [c.capped && 'capped', c.timeseries && 'time series', c.validator && 'validation', c.viewOn && `view on ${c.viewOn}`].filter(Boolean).join(', ');
    this.grid.sort = this.sort ? { c: cols.findIndex(c => c.name === this.sort.name), dir: this.sort.dir > 0 ? "asc" : "desc" } : null;
    this.grid.setData(cols, rows.map(c => [c.name, c.type, c.count, c.size, c.storageSize, c.avgObjSize != null ? Math.round(c.avgObjSize) : null, c.indexes, c.indexSize, notes(c)].map(v => (v == null ? null : String(v)))), { keepWidths: true });
    const sum = k => this.list.reduce((s, c) => s + (c[k] || 0), 0);
    this.totals.textContent = `${this.list.length} collection${this.list.length === 1 ? '' : 's'} · ${fmtNum(sum('count'))} documents · ${fmtBytes(sum('storageSize') + sum('indexSize'))} on disk`;
  }
}
