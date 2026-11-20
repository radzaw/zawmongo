// Left-hand object tree: sessions > databases > collections and views.
import { esc, fmtBytes, fmtNum } from './util.js';
import { icon } from './icons.js';
import { get } from './api.js';

export class Tree {
  constructor(app, host) {
    this.app = app;
    this.roots = [];
    this.vis = [];
    this.sel = null;
    this.dbFilter = '';
    this.collFilter = '';
    this.el = document.createElement('div');
    this.el.className = 'tree';
    this.el.tabIndex = 0;
    host.append(this.el);
    this.el.addEventListener('mousedown', e => this.onMouse(e));
    this.el.addEventListener('dblclick', e => this.onDbl(e));
    this.el.addEventListener('contextmenu', e => this.onCtx(e));
    this.el.addEventListener('keydown', e => this.onKey(e));
  }

  addSession(info) {
    const n = { type: 'session', sid: info.sid, label: info.name, info, children: null, expanded: false, depth: 0 };
    this.roots.push(n);
    this.render();
    return n;
  }

  removeSession(sid) {
    this.roots = this.roots.filter(n => n.sid !== sid);
    if (this.sel?.sid === sid) this.sel = null;
    this.render();
  }

  sessionNode(sid) { return this.roots.find(n => n.sid === sid); }
  findDb(sid, db) { return this.sessionNode(sid)?.children?.find(d => d.db === db) || null; }
  findColl(sid, db, name) { return this.findDb(sid, db)?.children?.find(o => o.name === name) || null; }

  /** Collection names of a loaded database (for completion), or []. */
  collectionNames(sid, db) { return this.findDb(sid, db)?.children?.map(c => c.name) ?? []; }

  async load(node) {
    node.loading = true;
    this.render();
    try {
      if (node.type === 'session') {
        const dbs = await get(`/s/${node.sid}/databases`);
        const old = new Map((node.children || []).map(c => [c.db, c]));
        node.children = dbs.map(d => Object.assign(old.get(d.name) || { type: 'db', sid: node.sid, db: d.name, label: d.name, parent: node, children: null, expanded: false, depth: 1 }, { size: d.size }));
      } else if (node.type === 'db') {
        const colls = await get(`/s/${node.sid}/collections`, { db: node.db });
        node.colls = colls;
        node.children = colls.map(c => ({ type: c.type === 'view' ? 'view' : c.timeseries ? 'timeseries' : 'collection', sid: node.sid, db: node.db, name: c.name, label: c.name, info: c, parent: node, depth: 2 }));
        // Keep the selection pointing at the freshly loaded node.
        if (this.sel?.parent === node) this.sel = node.children.find(c => c.name === this.sel.name) || node;
      }
    } finally {
      node.loading = false;
      this.render();
    }
  }

  async toggle(node) {
    if (node.depth >= 2) return;
    if (node.expanded) {
      node.expanded = false;
      this.render();
      return;
    }
    node.expanded = true;
    if (!node.children) {
      try {
        await this.load(node);
      } catch (e) {
        node.expanded = false;
        this.render();
        this.app.showError(e);
        return;
      }
    }
    this.render();
  }

  async expand(node) {
    if (!node.expanded) await this.toggle(node);
  }

  async refresh(node) {
    if (!node) return;
    if (node.depth === 2) node = node.parent;
    await this.load(node);
  }

  visible() {
    const out = [];
    const df = this.dbFilter.toLowerCase(), cf = this.collFilter.toLowerCase();
    const walk = nodes => {
      for (const n of nodes) {
        if (n.type === 'db' && df && !n.db.toLowerCase().includes(df) && n !== this.sel) continue;
        if (n.depth === 2 && cf && !n.name.toLowerCase().includes(cf)) continue;
        out.push(n);
        if (n.expanded && n.children) walk(n.children);
      }
    };
    walk(this.roots);
    return out;
  }

  render() {
    this.vis = this.visible();
    this.el.innerHTML = this.vis.map((n, i) => {
      const leaf = n.depth === 2;
      const tw = leaf ? '' : n.loading ? '<span class="spin"></span>' : n.expanded ? '▾' : '▸';
      const ic = n.type === 'session' ? 'server' : n.type === 'db' ? 'database' : n.type;
      let right = '';
      if (n.type === 'db' && n.size) right = fmtBytes(n.size);
      else if (leaf && n.info?.count != null) right = fmtNum(n.info.count);
      const title = n.type === 'session'
        ? `${n.info.user ? n.info.user + ' @ ' : ''}${n.info.host}${n.info.ssh ? ` via SSH (${n.info.ssh})` : ''} – MongoDB ${n.info.version}${n.info.replicaSet ? `, replica set ${n.info.replicaSet}` : ''}`
        : leaf ? (n.type === 'view' ? `View on ${n.info.viewOn}` : `${fmtNum(n.info.count)} documents, ${fmtBytes(n.info.size)} data, ${fmtBytes(n.info.storageSize)} on disk, ${n.info.indexes ?? '?'} indexes`) : '';
      const root = n.type === 'session' ? n : n.depth === 1 ? n.parent : n.parent.parent;
      const color = root.info.color; // validated #rrggbb (backend only stores that format)
      let badges = '';
      if (n.type === 'session' && n.info.production) badges += '<span class="prod-badge">prod</span>';
      if (n.type === 'session' && n.info.readOnly) badges += '<span class="ro-badge">read-only</span>';
      const cls = `tn${n === this.sel ? ' sel' : ''}${n.type === 'session' ? ' session' : ''}${color ? ' colored' : ''}`;
      return `<div class="${cls}" data-i="${i}" style="padding-left:${n.depth * 16 + 2}px${color ? ';--sc:' + color : ''}" title="${esc(title)}"><span class="tw">${tw}</span>${icon(ic)}<span class="tl">${esc(n.label)}</span>${badges}<span class="ts">${right}</span></div>`;
    }).join('');
  }

  nodeFromEvent(e) {
    const el = e.target.closest('.tn');
    return el ? this.vis[+el.dataset.i] : null;
  }

  onMouse(e) {
    const n = this.nodeFromEvent(e);
    if (!n) return;
    if (e.button === 0 && e.target.closest('.tw')) { this.toggle(n); return; }
    this.select(n);
  }

  onDbl(e) {
    const n = this.nodeFromEvent(e);
    if (!n || e.target.closest('.tw')) return;
    if (n.depth < 2) this.toggle(n);
    else this.app.openDocuments(n);
  }

  onCtx(e) {
    e.preventDefault();
    this.app.treeContextMenu(e, this.nodeFromEvent(e));
  }

  select(n, { silent = false } = {}) {
    if (this.sel === n) return;
    this.sel = n;
    this.render();
    this.scrollTo(n);
    if (!silent) this.app.onTreeSelect(n);
  }

  scrollTo(n) {
    const i = this.vis.indexOf(n);
    if (i >= 0) this.el.children[i]?.scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    const vis = this.vis;
    let i = vis.indexOf(this.sel);
    const s = this.sel;
    switch (e.key) {
      case 'ArrowDown': i = Math.min(vis.length - 1, i + 1); break;
      case 'ArrowUp': i = Math.max(0, i - 1); break;
      case 'Home': i = 0; break;
      case 'End': i = vis.length - 1; break;
      case 'ArrowRight':
        if (s && s.depth < 2 && !s.expanded) { e.preventDefault(); this.toggle(s); return; }
        i = Math.min(vis.length - 1, i + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (s?.expanded) this.toggle(s);
        else if (s?.parent) this.select(s.parent);
        return;
      case 'Enter':
        e.preventDefault();
        if (s?.depth === 2) this.app.openDocuments(s);
        else if (s) this.toggle(s);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (vis[i]) this.select(vis[i]);
  }
}
