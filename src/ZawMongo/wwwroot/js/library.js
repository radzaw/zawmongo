// Saved queries, kept in library.json in the configuration directory. Several windows can save at once: a save
// based on an older revision is refused by the backend, so the window reloads the library and applies its change again.
import { h, esc } from './util.js';
import { icon } from './icons.js';
import { get, put, LIBRARY_CONFLICT } from './api.js';
import { modal, confirmDlg } from './dialogs.js';
import { highlight } from './editor.js';

export class LibraryStore {
  constructor() {
    this.doc = { queries: [], snippets: [], revision: 0 };
  }

  async load() {
    try {
      const d = await get('/library', null, { quiet: true });
      if (d) this.doc = d;
    } catch (e) { this.loadError = e; }
  }

  get queries() { return this.doc.queries; }
  find(id) { return this.doc.queries.find(q => q.id === id) ?? null; }

  /** Applies `change` to the library and saves it; on a conflict, to the newer library. */
  async update(change) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = structuredClone(this.doc);
      change(next);
      try {
        const r = await put('/library', next, { quiet: true });
        next.revision = r.revision;
        this.doc = next;
        return;
      } catch (e) {
        if (e.code !== LIBRARY_CONFLICT) throw e;
        await this.load();
      }
    }
    throw new Error('The saved queries kept changing in another window; try again.');
  }

  /** Saves a query tab's text under a name; resolves to the saved query, or null. */
  async saveDialog(view, { asNew = false } = {}) {
    const existing = !asNew && view.savedId ? this.find(view.savedId) : null;
    if (existing) {
      await this.update(d => { const q = d.queries.find(x => x.id === existing.id); if (q) { q.sql = view.sql; q.db = view.db; q.updated = Date.now(); } });
      view.app.setStatus(`Saved "${existing.name}".`);
      return this.find(existing.id);
    }
    const name = h('input', { class: 'inp wide', value: existing?.name ?? (view.title !== 'Query' ? view.title : ''), spellcheck: false });
    const folder = h('input', { class: 'inp wide', placeholder: 'Reports/Monthly (optional)', spellcheck: false });
    const desc = h('textarea', { class: 'inp wide', rows: 2 });
    const ok = await modal({
      title: 'Save query', width: 460,
      body: h('div', { class: 'form' }, h('label', null, 'Name'), name, h('label', null, 'Folder'), folder, h('label', null, 'Description'), desc),
      buttons: [{ label: 'Save', primary: true, onClick: () => (name.value.trim() ? true : false) }, { label: 'Cancel', value: false }],
    });
    if (!ok) return null;
    const q = { id: crypto.randomUUID?.() ?? String(Date.now()), name: name.value.trim(), folder: folder.value.trim() || null, description: desc.value.trim() || null, sql: view.sql, db: view.db, created: Date.now() };
    await this.update(d => d.queries.push(q));
    view.app.setStatus(`Saved "${q.name}".`);
    return q;
  }

  /** The saved queries: open (in the given tab or a new one), run, rename, delete. */
  dialog(app, view) {
    const filter = h('input', { class: 'inp wide lib-filter', placeholder: 'Filter by name, folder or text', spellcheck: false });
    const listEl = h('div', { class: 'lib-list' });
    const preview = h('pre', { class: 'doc-json lib-preview' });
    let sel = null;
    const render = () => {
      const f = filter.value.toLowerCase();
      const qs = this.queries.filter(q => !f || [q.name, q.folder, q.description, q.sql].some(x => x?.toLowerCase().includes(f)))
        .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || a.name.localeCompare(b.name));
      let folder;
      listEl.innerHTML = qs.map(q => {
        const head = q.folder !== folder ? `<div class="lib-folder">${icon('folder')}${esc(q.folder || 'No folder')}</div>` : '';
        folder = q.folder;
        return `${head}<div class="lib-item${q === sel ? ' sel' : ''}" data-id="${esc(q.id)}">${icon('bookmark')}<span class="lib-name">${esc(q.name)}</span></div>`;
      }).join('') || '<div class="muted pad">No saved queries. Save one from a query tab with Ctrl+S.</div>';
      preview.innerHTML = sel ? highlight(sel.sql) : '';
    };
    listEl.addEventListener('mousedown', e => {
      const it = e.target.closest('.lib-item');
      if (it) { sel = this.find(it.dataset.id); render(); }
    });
    listEl.addEventListener('dblclick', e => { if (e.target.closest('.lib-item')) listEl.closest('.modal')?.querySelector('.btn.primary')?.click(); });
    filter.addEventListener('input', render);
    render();
    return modal({
      title: 'Saved queries', width: 820,
      body: h('div', { class: 'lib-dialog' }, h('div', { class: 'lib-left' }, filter, listEl), preview),
      buttons: [
        { label: 'Delete', align: 'left', onClick: async () => {
          if (!sel || !(await confirmDlg(`Delete the saved query "${sel.name}"?`, { ok: 'Delete', danger: true }))) return false;
          const id = sel.id;
          await this.update(d => { d.queries = d.queries.filter(q => q.id !== id); });
          sel = null;
          render();
          return false;
        } },
        { label: 'Open in new tab', onClick: () => { if (!sel) return false; app.openQueryTab(sel.sql, sel.name, { savedId: sel.id, db: sel.db }); return true; } },
        { label: 'Open', primary: true, onClick: () => {
          if (!sel) return false;
          if (view && !view.sql.trim()) {
            view.editor.value = sel.sql;
            view.savedId = sel.id;
            view.title = sel.name;
            app.tabs.setTitle(view.id, sel.name);
          } else app.openQueryTab(sel.sql, sel.name, { savedId: sel.id, db: sel.db });
          return true;
        } },
        { label: 'Close', value: null },
      ],
    });
  }
}
