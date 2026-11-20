// Documents shown three ways: a table of top-level fields, pretty-printed JSON (shell syntax), and an expandable tree.
// When the documents are whole documents of one collection, they can be edited, cloned and deleted in place.
import { h, esc } from './util.js';
import { icon } from './icons.js';
import { post } from './api.js';
import { Grid } from './grid.js';
import { modal, contextMenu, confirmDlg } from './dialogs.js';
import { CodeEditor, highlight } from './editor.js';
import { typeOf, summary, toShell, columnsOf, columnType, kindOf, editText, editValue, isScalar, toRelaxedJson } from './ejson.js';

const MODES = [['table', 'columns', 'Table'], ['json', 'json', 'JSON'], ['tree', 'treeview', 'Tree']];
const PAGE = 100; // documents rendered at once in the JSON and tree views

/** A document editor dialog: resolves with the shell text to save, or null. `onSave(text)` may throw to keep it open. */
export function editDocumentDialog(app, { title, doc, text, readOnly = false, onSave }) {
  const ed = new CodeEditor({ value: text ?? toShell(doc, 2), readOnly });
  ed.el.classList.add('doc-editor');
  return modal({
    title,
    width: 'min(860px, 92vw)',
    className: 'doc-dialog',
    body: h('div', { class: 'doc-edit-body' }, ed.el,
      h('div', { class: 'muted doc-edit-hint' }, readOnly ? 'Read-only.' : 'Shell syntax: ObjectId("…"), ISODate("…"), NumberLong(…), NumberDecimal("…"), /regex/i. Ctrl+Enter saves.')),
    onOpen: () => { ed.focus(); ed.onRun = () => ed.el.closest('.modal')?.querySelector('.btn.primary')?.click(); },
    buttons: readOnly ? [{ label: 'Close', value: null, primary: true }] : [
      { label: 'Save', primary: true, onClick: async () => { await onSave(ed.value); return ed.value; } },
      { label: 'Cancel', value: null },
    ],
  });
}

export class DocView {
  /**
   * opts.onChanged(): documents were changed (inserted, edited, deleted) through this view.
   * opts.onFilter(field, value): "Filter by this value" from the context menu.
   * opts.layoutKey: remembers the column layout per collection.
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.o = opts;
    this.docs = [];
    this.mode = app.prefs.docView || 'table';
    this.target = null; // { sid, db, coll } when editable
    this.modeBtns = new Map();
    this.modeBar = h('div', { class: 'subtabs' }, MODES.map(([m, ic, label]) => {
      const b = h('button', { class: 'subtab', title: `${label} view`, html: icon(ic) + label, onclick: () => this.setMode(m) });
      this.modeBtns.set(m, b);
      return b;
    }));
    this.grid = new Grid({
      editable: true, arrange: true, nullText: '',
      emptyText: 'No documents.',
      editText: (r, c) => editText(this.docs[r][this.cols[c]]),
      canEdit: (r, c) => isScalar(this.docs[r][this.cols[c]]),
      onCellEdit: (r, c, v) => this.cellEdit(r, c, v),
      onActivate: r => this.openDoc(r),
      onContextMenu: (e, p) => this.menu(e, p.r, p.c),
      onKey: e => this.key(e),
    });
    this.list = h('div', { class: 'doc-list', tabindex: 0 });
    this.list.addEventListener('contextmenu', e => {
      const card = e.target.closest('[data-r]');
      if (!card) return;
      e.preventDefault();
      this.menu(e, +card.dataset.r, -1);
    });
    this.list.addEventListener('click', e => this.listClick(e));
    this.body = h('div', { class: 'doc-body' }, this.grid.el, this.list);
    this.el = h('div', { class: 'docview' }, this.body);
    this.setMode(this.mode, false);
  }

  setMode(m, save = true) {
    this.mode = m;
    for (const [k, b] of this.modeBtns) b.classList.toggle('active', k === m);
    this.grid.el.style.display = m === 'table' ? '' : 'none';
    this.list.style.display = m === 'table' ? 'none' : '';
    if (save) { this.app.prefs.docView = m; this.app.saveStateSoon(); }
    this.render();
  }

  /** `target`: { sid, db, coll } when the documents can be edited; `partial`: a projection left fields out. */
  setDocs(docs, { target = null, partial = false, keepPos = false } = {}) {
    this.docs = docs;
    this.target = target;
    this.partial = partial;
    this.shown = PAGE;
    this.render(keepPos);
  }

  get editable() { return !!this.target && !this.app.isReadOnly(this.target.sid); }

  render(keepPos = false) {
    if (this.mode === 'table') this.renderTable(keepPos);
    else this.renderList();
  }

  renderTable(keepPos) {
    const names = columnsOf(this.docs);
    this.cols = names;
    const columns = names.map(n => {
      const t = columnType(this.docs, n);
      return { name: n, kind: kindOf(t), type: t, key: n === '_id', readOnly: !this.editable || n === '_id' };
    });
    const rows = this.docs.map(d => names.map(n => (d[n] === undefined ? null : summary(d[n]))));
    this.grid.o.editable = this.editable;
    this.grid.setData(columns, rows, { keepWidths: keepPos, keepPos, layout: this.o.layoutKey ? this.app.state.docLayouts?.[this.o.layoutKey()] : null });
    this.grid.o.onLayout = layout => {
      if (!this.o.layoutKey) return;
      const all = (this.app.state.docLayouts ||= {});
      if (layout) all[this.o.layoutKey()] = layout; else delete all[this.o.layoutKey()];
      this.app.saveStateSoon();
    };
  }

  renderList() {
    const docs = this.docs.slice(0, this.shown);
    if (!this.docs.length) {
      this.list.innerHTML = '<div class="placeholder">No documents.</div>';
      return;
    }
    const ed = this.editable;
    const actions = r => ed ? `<div class="doc-actions"><button class="tbtn" data-act="edit" data-r="${r}" title="Edit document">${icon('edit')}</button><button class="tbtn" data-act="clone" data-r="${r}" title="Clone">${icon('copydoc')}</button><button class="tbtn" data-act="copy" data-r="${r}" title="Copy as JSON">${icon('copy')}</button><button class="tbtn" data-act="delete" data-r="${r}" title="Delete">${icon('trash')}</button></div>`
      : `<div class="doc-actions"><button class="tbtn" data-act="copy" data-r="${r}" title="Copy as JSON">${icon('copy')}</button></div>`;
    const html = docs.map((d, r) => this.mode === 'json'
      ? `<div class="doc-card" data-r="${r}">${actions(r)}<pre class="doc-json">${typeOf(d) === 'object' || typeOf(d) === 'array' ? highlight(toShell(d, 2)) : esc(toShell(d))}</pre></div>`
      : `<div class="doc-card" data-r="${r}">${actions(r)}<div class="doc-tree">${this.treeRows(d, '', 0, r)}</div></div>`).join('');
    const more = this.docs.length > this.shown ? `<button class="btn doc-more">Show ${Math.min(PAGE, this.docs.length - this.shown)} more (${this.docs.length - this.shown} not shown)</button>` : '';
    this.list.innerHTML = html + more;
  }

  treeRows(v, path, depth, r) {
    if (typeOf(v) !== 'object' && typeOf(v) !== 'array') return `<div class="dt-row" style="padding-left:${depth * 16}px"><span class="dt-val t-${valClass(v)}">${esc(summary(v, 2000))}</span></div>`;
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
    return entries.map(([k, x]) => {
      const t = typeOf(x);
      const p = path ? path + '.' + k : k;
      const nested = t === 'object' || t === 'array';
      const open = depth === 0 && nested && Object.keys(x).length <= 8 ? '' : ' closed';
      return `<div class="dt-node${nested ? open : ''}" data-path="${esc(p)}"><div class="dt-row" style="padding-left:${depth * 16}px"><span class="dt-tw">${nested ? '▾' : ''}</span><span class="dt-key${Array.isArray(v) ? ' idx' : ''}">${esc(k)}</span><span class="dt-val t-${valClass(x)}">${esc(summary(x, 500))}</span><span class="dt-type">${t}</span></div>${nested ? `<div class="dt-kids">${this.treeRows(x, p, depth + 1, r)}</div>` : ''}</div>`;
    }).join('');
  }

  listClick(e) {
    if (e.target.closest('.doc-more')) { this.shown += PAGE; this.renderList(); return; }
    const btn = e.target.closest('[data-act]');
    if (btn) {
      const r = +btn.dataset.r;
      ({ edit: () => this.openDoc(r), clone: () => this.clone(r), copy: () => this.copyDocs([r]), delete: () => this.deleteDocs([r]) })[btn.dataset.act]?.();
      return;
    }
    const tw = e.target.closest('.dt-row');
    if (tw && tw.parentElement.classList.contains('dt-node')) tw.parentElement.classList.toggle('closed');
  }

  // ---------- actions ----------

  selectedRows() {
    if (this.mode !== 'table') return [];
    return this.grid.selectedRowIndexes();
  }

  key(e) {
    if (e.key === 'Delete' && (e.ctrlKey || e.metaKey) && this.editable) { e.preventDefault(); this.deleteDocs(this.selectedRows()); }
    else if (e.key === 'Insert' && this.editable) { e.preventDefault(); this.insertDialog(); }
  }

  menu(e, r, c) {
    const rows = this.mode === 'table' && this.selectedRows().includes(r) ? this.selectedRows() : [r];
    const ed = this.editable;
    const field = c >= 0 ? this.cols[c] : null;
    const val = field != null ? this.docs[r]?.[field] : undefined;
    const items = [
      { label: ed ? 'Edit document…' : 'View document…', icon: ed ? 'edit' : 'doc', shortcut: 'Enter', onClick: () => this.openDoc(r) },
      ed ? { label: 'Insert document…', icon: 'plus', shortcut: 'Insert', onClick: () => this.insertDialog() } : null,
      ed ? { label: 'Clone document…', icon: 'copydoc', onClick: () => this.clone(r) } : null,
      ed ? { label: rows.length > 1 ? `Delete ${rows.length} documents` : 'Delete document', icon: 'trash', shortcut: 'Ctrl+Del', onClick: () => this.deleteDocs(rows) } : null,
      '-',
      { label: rows.length > 1 ? `Copy ${rows.length} documents as JSON` : 'Copy document as JSON', icon: 'copy', onClick: () => this.copyDocs(rows) },
      field != null && val !== undefined ? { label: 'Copy value', onClick: () => navigator.clipboard.writeText(typeof val === 'string' ? val : toShell(val, 2)).catch(() => {}) } : null,
      field != null && val !== undefined && isScalar(val) && this.o.onFilter ? { label: `Filter: ${field} = ${summary(val, 40)}`, icon: 'filter', onClick: () => this.o.onFilter(field, val) } : null,
    ];
    if (ed && field != null && field !== '_id') {
      items.push('-',
        { label: 'Set field to null', disabled: val === null, onClick: () => this.setField(r, field, 'null') },
        { label: 'Remove field', disabled: val === undefined, onClick: () => this.setField(r, field, null) });
    }
    contextMenu(e.clientX, e.clientY, items);
  }

  idOf(r) { return this.docs[r]?._id; }

  async cellEdit(r, c, text) {
    const field = this.cols[c];
    await this.setField(r, field, editValue(this.docs[r][field], text));
  }

  async setField(r, field, value) {
    const t = this.target;
    try {
      const res = await post(`/s/${t.sid}/docs/field`, { db: t.db, coll: t.coll, id: this.idOf(r), path: field, value });
      if (res.doc) this.docs[r] = this.partial ? pick(res.doc, this.docs[r]) : res.doc;
      this.render(true);
      this.o.onChanged?.({ quiet: true });
    } catch (e) {
      this.app.showError(e);
      this.render(true);
    }
  }

  async openDoc(r) {
    const d = this.docs[r];
    if (d === undefined) return;
    if (!this.editable || d?._id === undefined) {
      return editDocumentDialog(this.app, { title: 'Document', doc: d, readOnly: true });
    }
    const t = this.target;
    let full = d;
    // A projected document misses fields: edit the whole one.
    if (this.partial) {
      try { full = await post(`/s/${t.sid}/doc`, { db: t.db, coll: t.coll, id: d._id }); } catch (e) { return this.app.showError(e); }
    }
    if (!(await this.app.confirmChange(t.sid, 'Replace this document?'))) return;
    const saved = await editDocumentDialog(this.app, {
      title: `Edit document – ${t.coll}`,
      doc: full,
      onSave: async text => {
        const res = await post(`/s/${t.sid}/docs/replace`, { db: t.db, coll: t.coll, id: d._id, text });
        this.docs[r] = this.partial ? pick(res.doc, d) : res.doc;
      },
    });
    if (saved != null) {
      this.render(true);
      this.o.onChanged?.({ quiet: true });
    }
  }

  async insertDialog(doc = null) {
    const t = this.target;
    if (!t) return;
    const saved = await editDocumentDialog(this.app, {
      title: `Insert into ${t.coll}`,
      text: doc ? toShell(doc, 2) : '{\n  \n}',
      onSave: async text => {
        if (!(await this.app.confirmChange(t.sid, `Insert into ${t.db}.${t.coll}?`))) throw new Error('Cancelled.');
        const r = await post(`/s/${t.sid}/docs/insert`, { db: t.db, coll: t.coll, text });
        this.app.setStatus(`${r.inserted} document${r.inserted === 1 ? '' : 's'} inserted.`);
      },
    });
    if (saved != null) this.o.onChanged?.();
  }

  async clone(r) {
    let d = this.docs[r];
    const t = this.target;
    if (this.partial) {
      try { d = await post(`/s/${t.sid}/doc`, { db: t.db, coll: t.coll, id: d._id }); } catch (e) { return this.app.showError(e); }
    }
    const { _id, ...rest } = d;
    return this.insertDialog(rest);
  }

  async deleteDocs(rows) {
    rows = rows.filter(r => this.docs[r]?._id !== undefined);
    if (!rows.length || !this.target) return;
    const t = this.target;
    const msg = rows.length === 1 ? `Delete the document with _id ${summary(this.docs[rows[0]]._id, 60)} from ${t.coll}?` : `Delete ${rows.length} documents from ${t.coll}?`;
    if (!(await confirmDlg(msg, { ok: 'Delete', danger: true })) || !(await this.app.confirmChange(t.sid, msg, { asked: true }))) return;
    try {
      const res = await post(`/s/${t.sid}/docs/delete`, { db: t.db, coll: t.coll, ids: rows.map(r => this.docs[r]._id) });
      this.app.setStatus(`${res.deleted} document${res.deleted === 1 ? '' : 's'} deleted.`);
      const gone = new Set(rows);
      this.docs = this.docs.filter((_, i) => !gone.has(i));
      this.render(true);
      this.o.onChanged?.({ deleted: res.deleted });
    } catch (e) { this.app.showError(e); }
  }

  copyDocs(rows) {
    const docs = rows.map(r => this.docs[r]).filter(d => d !== undefined);
    const text = docs.length === 1 ? toRelaxedJson(docs[0]) : toRelaxedJson(docs);
    navigator.clipboard.writeText(text).catch(() => {});
    this.app.setStatus(`Copied ${docs.length} document${docs.length === 1 ? '' : 's'} as JSON.`);
  }
}

/** The fields of `full` that `shown` has (a projected row keeps its projection after an edit). */
function pick(full, shown) {
  const out = {};
  for (const k of Object.keys(shown)) if (k in full) out[k] = full[k];
  return out;
}

function valClass(v) {
  switch (typeOf(v)) {
    case 'string': return 'str';
    case 'int': case 'long': case 'double': case 'decimal': return 'num';
    case 'bool': case 'null': return 'kw';
    case 'objectId': case 'date': case 'uuid': case 'timestamp': return 'fn';
    case 'object': case 'array': return 'com';
    default: return 'id';
  }
}
