// Collection tab: indexes (with their size and how often they were used), the schema inferred from a sample,
// statistics, validation rules and the collection's options.
import { h, esc, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { modal, confirmDlg } from '../dialogs.js';
import { CodeEditor, highlight } from '../editor.js';
import { toShell, summary, scalarShell } from '../ejson.js';

const KINDS = [['indexes', 'index', 'Indexes'], ['schema', 'schema', 'Schema'], ['stats', 'info', 'Statistics'], ['validation', 'check', 'Validation'], ['options', 'settings', 'Options']];
const num = v => (v == null ? null : typeof v === 'object' ? Number(v.$numberInt ?? v.$numberLong ?? v.$numberDouble) : Number(v));

export class CollectionView {
  constructor(app) {
    this.app = app;
    this.kind = 'indexes';
    this.btns = new Map();
    this.title = h('span', { class: 'viewtitle' });
    this.tabsEl = h('div', { class: 'subtabs' }, KINDS.map(([k, ic, label]) => {
      const b = h('button', { class: 'subtab', html: icon(ic) + label, onclick: () => { this.kind = k; this.render(); } });
      this.btns.set(k, b);
      return b;
    }));
    this.actions = h('span', { class: 'coll-actions' });
    this.body = h('div', { class: 'coll-body' });
    this.el = h('div', { class: 'view' },
      h('div', { class: 'viewbar' }, this.title, this.tabsEl, h('span', { class: 'grow' }), this.actions,
        h('button', { class: 'tbtn', title: 'Refresh (F5)', html: icon('refresh'), onclick: () => this.refresh() })),
      this.body);
  }

  open(sid, db, coll) {
    if (this.target && this.target.sid === sid && this.target.db === db && this.target.coll === coll) return;
    this.target = { sid, db, coll };
    this.data = null;
    this.schema = null;
  }

  onShow() { if (this.target && !this.data) this.refresh(); else this.render(); }

  async refresh() {
    const t = this.target;
    if (!t) return;
    this.body.replaceChildren(h('div', { class: 'placeholder' }, 'Loading…'));
    try {
      this.data = await get(`/s/${t.sid}/collection`, { db: t.db, coll: t.coll });
      this.render();
    } catch (e) {
      this.body.replaceChildren(h('div', { class: 'placeholder error' }, e.message));
    }
  }

  get ro() { return this.app.isReadOnly(this.target?.sid); }

  render() {
    const t = this.target, d = this.data;
    for (const [k, b] of this.btns) b.classList.toggle('active', k === this.kind);
    if (!t || !d) return;
    const view = d.type === 'view';
    this.title.innerHTML = icon(view ? 'view' : d.type === 'timeseries' ? 'timeseries' : 'collection') + `<span>${esc(t.db)}.${esc(t.coll)}</span>`;
    this.actions.replaceChildren();
    if (view && ['indexes', 'stats', 'validation', 'schema'].includes(this.kind) && this.kind !== 'schema') {
      this.body.replaceChildren(h('div', { class: 'placeholder' }, `A view on ${d.options.viewOn}: it has no ${this.kind === 'indexes' ? 'indexes' : this.kind === 'stats' ? 'storage of its own' : 'validation rules'}. Its definition is under Options.`));
      return;
    }
    ({ indexes: () => this.renderIndexes(), schema: () => this.renderSchema(), stats: () => this.renderStats(), validation: () => this.renderValidation(), options: () => this.renderOptions() })[this.kind]();
  }

  // ---------- indexes ----------

  renderIndexes() {
    const d = this.data;
    this.actions.append(h('button', { class: 'btn', disabled: this.ro, html: icon('plus') + ' Create index…', onclick: () => this.createIndex() }));
    const rows = d.indexes.map(ix => {
      const spec = ix.spec;
      const flags = [];
      if (spec.unique) flags.push('unique');
      if (spec.sparse) flags.push('sparse');
      if (spec.partialFilterExpression) flags.push('partial');
      if (spec.expireAfterSeconds != null) flags.push(`TTL ${summary(spec.expireAfterSeconds)} s`);
      if (spec.hidden) flags.push('hidden');
      if (spec.collation) flags.push('collation ' + spec.collation.locale);
      if (Object.values(spec.key).some(v => v === 'text')) flags.push('text');
      if (Object.values(spec.key).some(v => v === '2dsphere' || v === '2d')) flags.push('geo');
      if (ix.building) flags.push('building');
      const unused = ix.ops === 0 && ix.name !== '_id_';
      return h('tr', null,
        h('td', null, h('b', null, ix.name)),
        h('td', { class: 'mono', html: highlight(toShell(spec.key, 0)).replace(/\n$/, '') }),
        h('td', null, flags.map(f => h('span', { class: 'tag' }, f))),
        h('td', { class: 'num' }, ix.size != null ? fmtBytes(ix.size) : ''),
        h('td', { class: 'num' + (unused ? ' warn-text' : ''), title: ix.since ? `Since ${new Date(ix.since).toLocaleString()}` : '' }, ix.ops != null ? fmtNum(ix.ops) : '?'),
        h('td', null,
          h('button', { class: 'tbtn', title: 'Show definition', html: icon('doc'), onclick: () => modal({ title: `Index ${ix.name}`, width: 560, body: h('pre', { class: 'doc-json', html: highlight(toShell(spec, 2)) }) }) }),
          h('button', { class: 'tbtn', title: 'Drop index', disabled: this.ro || ix.name === '_id_', html: icon('trash'), onclick: () => this.dropIndex(ix.name) })));
    });
    const unused = d.indexes.filter(i => i.ops === 0 && i.name !== '_id_').length;
    this.body.replaceChildren(h('div', { class: 'pad' },
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Name', 'Keys', 'Properties', 'Size', 'Uses', ''].map(x => h('th', null, x)))),
        h('tbody', null, rows)),
      h('div', { class: 'muted note' }, 'Uses: how often each index was used since the server started (or since the index was built), from $indexStats. ' +
        (unused ? `${unused} index${unused === 1 ? ' was' : 'es were'} never used: if that stays so, hiding (then dropping) ${unused === 1 ? 'it' : 'them'} saves memory and makes writes faster.` : ''))));
  }

  async createIndex() {
    const t = this.target;
    const keys = new CodeEditor({ value: '{ field: 1 }' });
    const name = h('input', { class: 'inp wide', placeholder: '(default: field_1)', spellcheck: false });
    const chk = (label, title) => { const c = h('input', { type: 'checkbox' }); return [c, h('label', { class: 'chk', title }, c, label)]; };
    const [unique, uniqueL] = chk('Unique', 'No two documents may have the same key');
    const [sparse, sparseL] = chk('Sparse', 'Leave out documents that lack the field');
    const [hidden, hiddenL] = chk('Hidden', 'Kept up to date but not used by queries (to test dropping it)');
    const ttl = h('input', { class: 'inp', type: 'number', min: 0, placeholder: 'seconds', style: { width: '110px' } });
    const partial = h('input', { class: 'inp wide mono', placeholder: '{ status: "active" }', spellcheck: false });
    const r = await modal({
      title: `Create index on ${t.coll}`,
      width: 560,
      body: h('div', { class: 'form2' },
        h('div', null, h('div', { class: 'muted' }, 'Keys: 1 ascending, -1 descending, "text", "2dsphere", "hashed". Equality fields first, then sort fields, then range fields.'), h('div', { class: 'bulk-ed' }, keys.el)),
        h('label', { class: 'frow' }, h('span', null, 'Name'), name),
        h('div', { class: 'frow' }, h('span', null, 'Options'), h('div', { class: 'row-gap' }, uniqueL, sparseL, hiddenL)),
        h('label', { class: 'frow' }, h('span', null, 'Expire after (TTL)'), ttl),
        h('label', { class: 'frow' }, h('span', null, 'Partial filter'), partial)),
      buttons: [{ label: 'Create', primary: true, onClick: async () => {
        const o = [];
        if (name.value.trim()) o.push(`name: ${JSON.stringify(name.value.trim())}`);
        if (unique.checked) o.push('unique: true');
        if (sparse.checked) o.push('sparse: true');
        if (hidden.checked) o.push('hidden: true');
        if (ttl.value !== '') o.push(`expireAfterSeconds: ${parseInt(ttl.value, 10)}`);
        if (partial.value.trim()) o.push(`partialFilterExpression: ${partial.value.trim()}`);
        if (!(await this.app.confirmChange(t.sid, `Create an index on ${t.db}.${t.coll}?`))) return false;
        return await post(`/s/${t.sid}/indexes/create`, { db: t.db, coll: t.coll, keys: keys.value, options: `{ ${o.join(', ')} }` });
      } }, { label: 'Cancel', value: null }],
    });
    if (r) { this.app.setStatus(`Index ${r.name} created.`); this.refresh(); }
  }

  async dropIndex(name) {
    const t = this.target;
    if (!(await confirmDlg(`Drop the index ${name} of ${t.db}.${t.coll}?`, { ok: 'Drop', danger: true })) || !(await this.app.confirmChange(t.sid, `Drop index ${name}?`, { asked: true }))) return;
    try {
      await post(`/s/${t.sid}/indexes/drop`, { db: t.db, coll: t.coll, name });
      this.refresh();
    } catch (e) { this.app.showError(e); }
  }

  // ---------- schema ----------

  renderSchema() {
    const size = h('select', { class: 'inp' }, [100, 1000, 5000, 10000].map(n => h('option', { value: n, selected: n === (this.app.prefs.schemaSample || 1000) }, `${fmtNum(n)} documents`)));
    const filter = h('input', { class: 'inp mono', placeholder: 'filter (optional)', spellcheck: false, value: this.schemaFilter || '' });
    const run = async () => {
      const t = this.target;
      this.app.prefs.schemaSample = +size.value;
      this.schemaFilter = filter.value;
      out.replaceChildren(h('div', { class: 'placeholder' }, 'Sampling…'));
      try {
        this.schema = await post(`/s/${t.sid}/schema`, { db: t.db, coll: t.coll, size: +size.value, filter: filter.value });
        out.replaceChildren(this.schemaTable());
      } catch (e) { out.replaceChildren(h('div', { class: 'placeholder error' }, e.message)); }
    };
    filter.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    this.actions.append(h('span', { class: 'muted' }, 'Sample'), size, filter, h('button', { class: 'btn primary', onclick: run }, 'Analyze'));
    const out = h('div', { class: 'pad' }, this.schema ? this.schemaTable() : h('div', { class: 'placeholder' }, 'Analyze reads a random sample of documents and lists every field with how often it occurs, its types and example values.'));
    this.body.replaceChildren(out);
  }

  schemaTable() {
    const s = this.schema;
    if (!s.sampled) return h('div', { class: 'placeholder' }, 'The collection is empty (or nothing matched the filter).');
    const typeColors = { string: 1, int: 2, long: 2, double: 2, decimal: 2, objectId: 3, date: 4, bool: 5, object: 6, array: 7, null: 8 };
    return h('div', null,
      h('div', { class: 'muted note' }, `${fmtNum(s.sampled)} documents sampled. Presence is the share of documents (or of objects at that level) that have the field.`),
      h('table', { class: 'tbl schema' },
        h('thead', null, h('tr', null, ['Field', 'Presence', 'Types', 'Examples'].map(x => h('th', null, x)))),
        h('tbody', null, s.fields.map(f => {
          const pct = f.of ? f.count / f.of : 1;
          const name = f.path.split(/\.(?![^[]*\])/).pop();
          return h('tr', null,
            h('td', { style: { paddingLeft: 8 + f.depth * 16 + 'px' }, title: f.path }, h('span', { class: 'mono' }, name),
              f.minLength != null ? h('span', { class: 'muted' }, ` [${f.minLength}–${f.maxLength}]`) : null),
            h('td', { class: 'num' }, h('div', { class: 'presence' }, h('div', { class: 'presence-bar', style: { width: Math.round(pct * 100) + '%' } }), h('span', null, `${Math.round(pct * 1000) / 10}%`))),
            h('td', null, f.types.map(t => h('span', { class: `tag type-${typeColors[t.type] || 0}`, title: `${fmtNum(t.count)} of ${fmtNum(f.count)}` }, `${t.type}${f.types.length > 1 ? ' ' + Math.round(t.count / f.count * 100) + '%' : ''}`))),
            h('td', { class: 'mono ellipsis' }, f.examples.map(v => scalarShell(v)).join(', ')));
        }))));
  }

  // ---------- statistics ----------

  renderStats() {
    const s = this.data.stats || {};
    const n = k => num(s[k]);
    const tiles = [
      ['Documents', fmtNum(n('count'))], ['Data size', fmtBytes(n('size'))], ['Average document', fmtBytes(n('avgObjSize'))],
      ['Storage size', fmtBytes(n('storageSize'))], ['Free storage', fmtBytes(n('freeStorageSize'))], ['Indexes', fmtNum(n('nindexes'))],
      ['Index size', fmtBytes(n('totalIndexSize'))], ['Capped', s.capped ? `yes, max ${fmtBytes(n('maxSize'))}` : 'no'],
    ];
    const ratio = n('size') && n('storageSize') ? n('size') / n('storageSize') : null;
    this.body.replaceChildren(h('div', { class: 'pad' },
      h('div', { class: 'mon-tiles' }, tiles.map(([l, v]) => h('div', { class: 'mon-tile' }, h('div', { class: 'mon-tile-label' }, l), h('div', { class: 'mon-tile-value' }, v || '–')))),
      ratio ? h('div', { class: 'muted note' }, `Data takes ${fmtBytes(n('size'))} uncompressed and ${fmtBytes(n('storageSize'))} on disk (compression ratio ${ratio.toFixed(1)}×).`) : null,
      h('details', { class: 'raw' }, h('summary', null, 'All statistics ($collStats)'), h('pre', { class: 'doc-json', html: highlight(toShell(s, 2)) }))));
  }

  // ---------- validation ----------

  renderValidation() {
    const o = this.data.options || {};
    const ed = new CodeEditor({ value: o.validator ? toShell(o.validator, 2) : '{\n  $jsonSchema: {\n    bsonType: "object",\n    required: [],\n    properties: {}\n  }\n}' });
    const level = h('select', { class: 'inp' }, ['strict', 'moderate', 'off'].map(v => h('option', { value: v, selected: (o.validationLevel || 'strict') === v }, v)));
    const action = h('select', { class: 'inp' }, ['error', 'warn'].map(v => h('option', { value: v, selected: (o.validationAction || 'error') === v }, v)));
    const save = h('button', { class: 'btn primary', disabled: this.ro, onclick: async () => {
      const t = this.target;
      if (!(await this.app.confirmChange(t.sid, `Change the validation rules of ${t.db}.${t.coll}?`))) return;
      try {
        await post(`/s/${t.sid}/validation`, { db: t.db, coll: t.coll, validator: ed.value, level: level.value, action: action.value });
        this.app.setStatus('Validation rules saved.');
        this.refresh();
      } catch (e) { this.app.showError(e); }
    } }, 'Save rules');
    this.actions.append(h('span', { class: 'muted' }, 'Level'), level, h('span', { class: 'muted' }, 'Action'), action, save);
    this.body.replaceChildren(h('div', { class: 'coll-code' },
      h('div', { class: 'muted note pad' }, o.validator ? 'Documents written to this collection must match these rules. strict checks every insert and update; moderate skips updates to documents that already broke the rules; warn only logs.' : 'No validation rules. Write a $jsonSchema or query expression and save it to have the server check every write.'),
      ed.el));
  }

  // ---------- options ----------

  renderOptions() {
    const d = this.data;
    this.body.replaceChildren(h('div', { class: 'pad' },
      h('div', { class: 'muted note' }, d.type === 'view' ? 'The view\'s source collection and pipeline.' : 'Options the collection was created with (capped, collation, time series, clustered index, validation …).'),
      h('pre', { class: 'doc-json', html: highlight(toShell(d.options, 2)) })));
  }
}
