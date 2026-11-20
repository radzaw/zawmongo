// ZawMongo main module: layout, menus, toolbar, tabs and the glue between tree and views.
import { get, post, put, setLogSink, startHeartbeat, SSH_HOSTKEY_UNKNOWN } from './api.js';
import { h, debounce, makeSplitter, fmtElapsed, NATIVE, openExternal, ZOOM_STEPS, nextZoom } from './util.js';
import { icon } from './icons.js';
import { Tree } from './tree.js';
import { LogPanel } from './log.js';
import { CodeEditor } from './editor.js';
import { contextMenu, closeMenus, menuIsOpen, alertError, confirmDlg, promptDlg, modal, modalIsOpen } from './dialogs.js';
import { HostView } from './views/host.js';
import { DatabaseView } from './views/database.js';
import { CollectionView } from './views/collection.js';
import { DocumentsView } from './views/documents.js';
import { QueryView, SAMPLE } from './views/query.js';
import { LibraryStore } from './library.js';
import { updateDialog, autoCheckUpdates, whatsNewAfterUpdate, whatsNewDialog } from './views/update.js';
import { DEFAULT_SLOW_MS, slowThreshold } from './logslow.js';
import { sessionManager, confirmHostKey, preferencesDialog, aboutDialog, exportDialog, importDialog, createCollectionDialog } from './views/tools.js';

const DEFAULT_PREFS = { pageSize: 50, maxDocs: 1000, theme: 'system', uiZoom: 100, editorFontSize: 13, autoCloseBrackets: true, confirmChangesAll: true, checkUpdates: true, showWhatsNew: true, logTimestamps: true, slowLogMs: DEFAULT_SLOW_MS, docView: 'table' };
const HISTORY_MAX = 200;

// ---------------------------------------------------------------- tabs

class Tabs {
  constructor(app, bar, content) {
    this.app = app;
    this.bar = bar;
    this.content = content;
    this.tabs = new Map();
    this.active = null;
    this.addBtn = h('button', { class: 'tab-add', title: 'New query tab (Ctrl+T)', html: icon('plus'), onclick: () => app.openQueryTab() });
    bar.append(this.addBtn);
    bar.addEventListener('wheel', e => { bar.scrollLeft += e.deltaY; }, { passive: true });
  }

  add({ id, title, iconName, view, closable = false, onClose }) {
    const tab = { id, view, closable, onClose, disabled: false };
    tab.titleEl = h('span', { class: 'tab-title' }, title);
    tab.el = h('div', { class: 'tab', title }, h('span', { class: 'tab-ic', html: icon(iconName) }), tab.titleEl,
      closable ? h('span', { class: 'tab-x', title: 'Close (middle click)', html: '×' }) : null);
    tab.el.addEventListener('mousedown', e => {
      if (e.button === 1 && closable) { e.preventDefault(); this.close(id); }
      else if (e.button === 0 && !e.target.closest('.tab-x')) this.activate(id);
    });
    tab.el.querySelector('.tab-x')?.addEventListener('click', e => { e.stopPropagation(); this.close(id); });
    tab.pane = h('div', { class: 'tab-pane' }, view.el);
    this.bar.insertBefore(tab.el, this.addBtn);
    this.content.append(tab.pane);
    this.tabs.set(id, tab);
    return tab;
  }

  activate(id) {
    const t = this.tabs.get(id);
    if (!t || t.disabled) return;
    if (this.active && this.active !== id) {
      const p = this.tabs.get(this.active);
      if (p) {
        p.el.classList.remove('active');
        p.pane.classList.remove('active');
        p.view.onHide?.();
      }
    }
    this.active = id;
    t.el.classList.add('active');
    t.pane.classList.add('active');
    t.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    t.view.onShow?.();
  }

  close(id) {
    const t = this.tabs.get(id);
    if (!t?.closable) return;
    if (t.onClose?.() === false) return;
    const ids = [...this.tabs.keys()];
    const i = ids.indexOf(id);
    t.el.remove();
    t.pane.remove();
    this.tabs.delete(id);
    if (this.active === id) {
      this.active = null;
      this.activate(ids[i + 1] && this.tabs.has(ids[i + 1]) ? ids[i + 1] : ids[i - 1]);
    }
  }

  setTitle(id, title) {
    const t = this.tabs.get(id);
    if (!t) return;
    t.titleEl.textContent = title;
    t.el.title = title;
  }

  setDisabled(id, disabled) {
    const t = this.tabs.get(id);
    if (!t) return;
    t.disabled = disabled;
    t.el.classList.toggle('disabled', disabled);
  }

  setModified(id, on) { this.tabs.get(id)?.el.classList.toggle('modified', !!on); }
  setBusy(id, on) { this.tabs.get(id)?.el.classList.toggle('busy', !!on); }
  activeView() { return this.tabs.get(this.active)?.view; }
}

// ---------------------------------------------------------------- app

class App {
  constructor() {
    this.sel = { sid: null, db: null, coll: null };
    this.conns = new Map();
    this.prodAllowed = new Set(); // production sessions where the user chose not to be asked again
    this.queryViews = [];
    this.queryCounter = 0;
    this.saveStateSoon = debounce(() => this.saveState(), 800);
  }

  async init() {
    try {
      this.state = (await get('/state')) || {};
    } catch (e) {
      this.state = {};
      document.body.textContent = e.message;
      return;
    }
    this.prefs = Object.assign({}, DEFAULT_PREFS, this.state.prefs);
    this.state.prefs = this.prefs;
    this.applyPrefs();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyPrefs());

    this.log = new LogPanel(document.getElementById('log'), {
      timestamps: () => this.prefs.logTimestamps !== false,
      setTimestamps: on => { this.prefs.logTimestamps = on; this.saveStateSoon(); },
      slowMs: () => slowThreshold(this.prefs.slowLogMs),
      setSlowMs: ms => { this.prefs.slowLogMs = ms; this.saveStateSoon(); },
      sessionName: sid => this.conns.get(sid)?.name ?? null,
      openInTab: text => this.openQueryTab(text).editor.focus(),
    });
    setLogSink((lines, times, durations, meta) => this.log.add(lines, '', times, durations, meta));
    try { this.version = await get('/version', null, { quiet: true }); } catch { this.version = null; }
    this.library = new LibraryStore();
    await this.library.load();
    if (this.library.loadError) this.log.error(`Saved queries could not be loaded: ${this.library.loadError.message}`);
    this.buildMenu();
    this.buildToolbar();
    this.buildLayout();
    this.buildStatusbar();

    this.tree = new Tree(this, document.getElementById('tree-host'));
    this.tabs = new Tabs(this, document.getElementById('tabbar'), document.getElementById('tabcontent'));
    this.views = { host: new HostView(this), database: new DatabaseView(this), collection: new CollectionView(this), documents: new DocumentsView(this) };
    this.tabs.add({ id: 'host', title: 'Host', iconName: 'host', view: this.views.host });
    this.tabs.add({ id: 'database', title: 'Database', iconName: 'database', view: this.views.database });
    this.tabs.add({ id: 'collection', title: 'Collection', iconName: 'collection', view: this.views.collection });
    this.tabs.add({ id: 'documents', title: 'Documents', iconName: 'doc', view: this.views.documents });
    const saved = this.state.queryTabs?.length ? this.state.queryTabs : [{ title: 'Query', sql: SAMPLE }];
    for (const q of saved) this.openQueryTab(q.sql, q.title, { activate: false, savedId: q.savedId, db: q.db });
    this.updateTabs();
    this.tabs.activate('host');

    document.getElementById('db-filter').addEventListener('input', e => { this.tree.dbFilter = e.target.value; this.tree.render(); });
    document.getElementById('tbl-filter').addEventListener('input', e => { this.tree.collFilter = e.target.value; this.tree.render(); });
    document.addEventListener('keydown', e => this.globalKey(e));
    if (NATIVE) {
      let lastWheelZoom = 0;
      document.addEventListener('wheel', e => {
        if (!e.ctrlKey || !e.deltaY) return;
        e.preventDefault();
        if (e.timeStamp - lastWheelZoom < 150) return;
        lastWheelZoom = e.timeStamp;
        this.setZoom(nextZoom(this.prefs.uiZoom, -e.deltaY));
      }, { passive: false });
      window.external.receiveMessage(m => { if (m === 'close-request') this.closeNativeWindow(); });
      window.external.sendMessage('ready');
      const external = e => {
        const a = e.target.closest?.('a[target=_blank]');
        if (a && /^https?:/.test(a.href)) { e.preventDefault(); openExternal(a.href); }
      };
      document.addEventListener('click', external);
      document.addEventListener('auxclick', external);
    }
    window.addEventListener('beforeunload', () => this.saveState());
    // A file dropped where nothing takes it would make the browser navigate away from the app.
    const refuseFiles = e => {
      if (e.defaultPrevented || !e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', refuseFiles);
    window.addEventListener('drop', refuseFiles);

    startHeartbeat();
    setTimeout(() => autoCheckUpdates(this), 15_000);
    this.log.info('ZawMongo started. Configuration is stored on the local machine.');
    sessionManager(this);
    whatsNewAfterUpdate(this);
  }

  applyPrefs() {
    const p = this.prefs;
    const dark = p.theme === 'dark' || (p.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--ed-font-size', p.editorFontSize + 'px');
    CodeEditor.autoClose = p.autoCloseBrackets !== false;
    if (NATIVE) window.external.sendMessage('zoom:' + p.uiZoom);
    this.log?.markAll();
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#14161b' : '#f3f4f7');
    if (NATIVE) window.external.sendMessage(dark ? 'theme:dark' : 'theme:light');
    try { sessionStorage.setItem('zawmongo-theme', p.theme); } catch { /* storage unavailable */ }
    if (this.themeBtn) {
      this.themeBtn.innerHTML = icon(dark ? 'sun' : 'moon');
      this.themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }

  setZoom(z) {
    if (z === this.prefs.uiZoom) return;
    this.prefs.uiZoom = z;
    this.applyPrefs();
    this.saveStateSoon();
    this.setStatus(`Zoom ${z}%`);
  }

  toggleTheme() {
    this.prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    this.applyPrefs();
    this.saveStateSoon();
  }

  async saveState() {
    if (!this.state) return;
    this.state.queryTabs = this.queryViews.map(v => ({ title: v.title, sql: v.sql, db: v.db || undefined, savedId: v.savedId || undefined }));
    try { await put('/state', this.state, { quiet: true }); } catch { /* backend gone */ }
  }

  // ---------- layout ----------

  buildLayout() {
    const left = document.getElementById('left');
    const logEl = document.getElementById('log');
    const layout = this.state.layout || {};
    left.style.width = (layout.leftWidth || 260) + 'px';
    logEl.style.height = (layout.logHeight || 110) + 'px';
    makeSplitter(document.getElementById('split-left'), {
      axis: 'x',
      get: () => left.offsetWidth,
      set: v => { left.style.width = Math.max(140, Math.min(v, innerWidth - 300)) + 'px'; },
      onEnd: () => { this.state.layout = { ...this.state.layout, leftWidth: left.offsetWidth }; this.saveStateSoon(); },
    });
    makeSplitter(document.getElementById('split-log'), {
      axis: 'y',
      get: () => -logEl.offsetHeight,
      set: v => { logEl.style.height = Math.max(24, Math.min(-v, innerHeight - 200)) + 'px'; },
      onEnd: () => { this.state.layout = { ...this.state.layout, logHeight: logEl.offsetHeight }; this.saveStateSoon(); },
    });
  }

  buildStatusbar() {
    const sb = document.getElementById('statusbar');
    this.sbMsg = h('div', { class: 'sb-cell grow' }, 'Idle.');
    this.sbConn = h('div', { class: 'sb-cell' });
    this.sbVer = h('div', { class: 'sb-cell' });
    this.sbSel = h('div', { class: 'sb-cell' });
    this.sbRo = h('div', { class: 'sb-cell sb-ro', style: { display: 'none' }, title: 'This session is in read-only mode; changes are blocked.' }, 'READ-ONLY');
    this.sbProd = h('div', { class: 'sb-cell sb-prod', style: { display: 'none' }, title: 'Production server: every change asks for confirmation.' }, 'PRODUCTION');
    this.sbUpdate = h('button', { class: 'sb-cell sb-update', style: { display: 'none' }, title: 'Show what is new and update' });
    sb.append(this.sbMsg, this.sbUpdate, this.sbProd, this.sbRo, this.sbSel, this.sbConn, this.sbVer);
    setInterval(() => this.updateStatus(), 1000);
  }

  setStatus(msg) {
    this.sbMsg.textContent = msg;
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => { this.sbMsg.textContent = 'Idle.'; }, 8000);
  }

  updateStatus() {
    const info = this.sel.sid ? this.conns.get(this.sel.sid) : null;
    this.sbConn.textContent = info ? `Connected: ${fmtElapsed(Date.now() - info.connectedAt)}` : 'Disconnected';
    this.sbVer.textContent = info ? `MongoDB ${info.version}${info.replicaSet ? ` · ${info.replicaSet}${info.primary ? '' : ' (secondary)'}` : ''}` : '';
    this.sbSel.textContent = info ? `${info.user ?? '(no user)'}${this.sel.db ? ' › ' + this.sel.db : ''}${this.sel.coll ? '.' + this.sel.coll : ''}` : '';
    this.sbRo.style.display = info?.readOnly ? '' : 'none';
    this.sbProd.style.display = info?.production ? '' : 'none';
    this.sbSel.style.boxShadow = info?.color ? `inset 4px 0 0 ${info.color}` : '';
    const title = `ZawMongo${info ? ' – ' + info.name : ''}${info?.production ? ' [PRODUCTION]' : ''}`;
    if (document.title !== title) document.title = title;
  }

  isReadOnly(sid) { return !!this.conns.get(sid)?.readOnly; }

  /**
   * On a production session, asks before a change (unless the user said not to ask again until reconnecting).
   * `msg` may be text or an element. Always true elsewhere.
   */
  async confirmChange(sid, msg) {
    const info = this.conns.get(sid);
    if (!info?.production || this.prodAllowed.has(sid)) return true;
    const again = h('input', { type: 'checkbox' });
    const r = await modal({
      title: `Production: ${info.name}`, width: 520,
      body: h('div', { class: 'form' }, h('div', { class: 'prod-banner' }, 'This is a production server.'), typeof msg === 'string' ? h('div', null, msg) : msg,
        h('label', { class: 'chk' }, again, " Don't ask again until I reconnect")),
      buttons: [{ label: 'Run on production', primary: true, danger: true, value: true }, { label: 'Cancel', value: false }],
    });
    if (r && again.checked) this.prodAllowed.add(sid);
    return !!r;
  }

  // ---------- menus & toolbar ----------

  menuDefs() {
    const s = this.sel;
    const ro = this.isReadOnly(s.sid);
    const q = () => this.queryForRun();
    return [
      ['File', () => [
        { label: 'Session manager…', icon: 'sessions', onClick: () => sessionManager(this) },
        { label: 'Disconnect', icon: 'disconnect', disabled: !s.sid, onClick: () => this.disconnect(s.sid) },
        '-',
        { label: 'New query tab', icon: 'newtab', shortcut: 'Ctrl+T', onClick: () => this.openQueryTab() },
        { label: 'Close query tab', shortcut: 'Ctrl+W', disabled: !this.activeQuery(), onClick: () => this.tabs.close(this.tabs.active) },
        '-',
        { label: 'Load script…', icon: 'open', onClick: () => this.openQueryTab('').loadFile() },
        { label: 'Save script…', icon: 'save', disabled: !this.activeQuery(), onClick: () => this.activeQuery().saveFile() },
        { label: 'Import JSON / CSV…', icon: 'import', disabled: !s.sid || ro, onClick: () => this.importInto(s.sid, s.db, s.coll) },
        { label: 'Export collection…', icon: 'export', disabled: !s.coll, onClick: () => this.exportCollection(s.sid, s.db, s.coll) },
        '-',
        { label: 'Exit', onClick: () => this.exit() },
      ]],
      ['Edit', () => [
        { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => this.refresh() },
        { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', onClick: () => document.execCommand('copy') },
        '-',
        { label: 'Preferences…', icon: 'settings', onClick: () => preferencesDialog(this) },
      ]],
      ['Query', () => [
        { label: 'Run', icon: 'play', shortcut: 'F9', disabled: !s.sid, onClick: () => q()?.run('all') },
        { label: 'Run selection', icon: 'playsel', shortcut: 'Ctrl+F9', disabled: !s.sid, onClick: () => q()?.run('selection') },
        { label: 'Run statement at caret', icon: 'playline', shortcut: 'Ctrl+Enter', disabled: !s.sid, onClick: () => q()?.run('current') },
        { label: 'Stop', icon: 'stop', disabled: !s.sid, onClick: () => this.activeQuery()?.stop() },
        { label: 'Explain statement at caret', icon: 'explain', shortcut: 'Ctrl+Shift+E', disabled: !s.sid, onClick: () => q()?.explain() },
        '-',
        { label: 'History…', icon: 'history', onClick: () => this.historyDialog(q()) },
        { label: 'Save query…', icon: 'bookmark', shortcut: 'Ctrl+S', onClick: () => q()?.saveToLibrary() },
        { label: 'Save query as new…', shortcut: 'Ctrl+Shift+S', onClick: () => q()?.saveToLibrary({ asNew: true }) },
        { label: 'Saved queries…', icon: 'library', onClick: () => this.libraryDialog(this.activeQuery()) },
      ]],
      ['Tools', () => [
        { label: 'Create database…', icon: 'database', disabled: !s.sid || ro, onClick: () => this.createCollectionDialog(s.sid, null) },
        { label: 'Create collection…', icon: 'plus', disabled: !s.db || ro, onClick: () => this.createCollectionDialog(s.sid, s.db) },
        '-',
        { label: 'Server monitor', icon: 'monitor', disabled: !s.sid, onClick: () => this.showHost('monitor') },
        { label: 'Running operations', icon: 'ops', disabled: !s.sid, onClick: () => this.showHost('ops') },
        { label: 'Users and roles', icon: 'user', disabled: !s.sid, onClick: () => this.showHost('users') },
        { label: 'Replica set', icon: 'replica', disabled: !s.sid, onClick: () => this.showHost('replication') },
        '-',
        { label: 'Theme', submenu: [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => ({ label: l, checked: this.prefs.theme === v, onClick: () => { this.prefs.theme = v; this.applyPrefs(); this.saveStateSoon(); } })) },
        ...(NATIVE ? [{ label: 'Zoom', submenu: [
          { label: 'Zoom in', shortcut: 'Ctrl+=', onClick: () => this.setZoom(nextZoom(this.prefs.uiZoom, 1)) },
          { label: 'Zoom out', shortcut: 'Ctrl+-', onClick: () => this.setZoom(nextZoom(this.prefs.uiZoom, -1)) },
          { label: 'Actual size', shortcut: 'Ctrl+0', onClick: () => this.setZoom(100) },
          '-',
          ...ZOOM_STEPS.map(z => ({ label: z + '%', checked: this.prefs.uiZoom === z, onClick: () => this.setZoom(z) })),
        ] }] : []),
        { label: 'Preferences…', icon: 'settings', onClick: () => preferencesDialog(this) },
      ]],
      ['Help', () => [
        { label: 'Keyboard shortcuts', icon: 'info', onClick: () => this.shortcutsDialog() },
        { label: 'Shell syntax', icon: 'info', onClick: () => this.syntaxDialog() },
        { label: "What's new…", icon: 'info', onClick: () => whatsNewDialog(this) },
        { label: 'Check for updates…', icon: 'next', onClick: () => updateDialog(this) },
        { label: 'About ZawMongo', icon: 'question', onClick: () => aboutDialog(this.version) },
      ]],
    ];
  }

  buildMenu() {
    const bar = document.getElementById('menubar');
    const open = (el, i) => {
      for (const x of bar.children) x.classList.remove('open');
      el.classList.add('open');
      const r = el.getBoundingClientRect();
      contextMenu(r.left, r.bottom, this.menuDefs()[i][1](), { onClose: () => el.classList.remove('open') });
    };
    this.menuDefs().forEach(([label], i) => {
      const el = h('div', { class: 'menubar-item' }, label);
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        if (el.classList.contains('open')) closeMenus();
        else open(el, i);
      });
      el.addEventListener('mouseenter', () => {
        if (menuIsOpen() && bar.querySelector('.open') && !el.classList.contains('open')) open(el, i);
      });
      bar.append(el);
    });
  }

  buildToolbar() {
    const tb = document.getElementById('toolbar');
    const b = (ic, title, fn) => h('button', { class: 'tbtn', title, html: icon(ic), onclick: fn });
    tb.append(
      h('button', { class: 'tbtn new-btn', title: 'New query tab (Ctrl+T)', onclick: () => this.openQueryTab(), html: icon('plus') + '<span>New query</span>' }),
      b('sessions', 'Session manager', () => sessionManager(this)),
      b('disconnect', 'Disconnect', () => this.sel.sid && this.disconnect(this.sel.sid)),
      b('refresh', 'Refresh (F5)', () => this.refresh()),
      h('span', { class: 'sep' }),
      b('play', 'Run (F9)', () => this.queryForRun()?.run('all')),
      b('playline', 'Run statement at caret (Ctrl+Enter)', () => this.queryForRun()?.run('current')),
      b('stop', 'Stop', () => this.activeQuery()?.stop()),
      h('span', { class: 'sep' }),
      b('database', 'Create database', () => this.sel.sid && this.createCollectionDialog(this.sel.sid, null)),
      b('collection', 'Create collection', () => this.sel.db && this.createCollectionDialog(this.sel.sid, this.sel.db)),
      b('import', 'Import JSON / CSV', () => this.sel.sid && this.importInto(this.sel.sid, this.sel.db, this.sel.coll)),
      b('export', 'Export collection', () => this.sel.coll && this.exportCollection(this.sel.sid, this.sel.db, this.sel.coll)),
      b('monitor', 'Server monitor', () => this.sel.sid && this.showHost('monitor')),
      b('user', 'Users and roles', () => this.sel.sid && this.showHost('users')),
      h('span', { class: 'grow' }),
      b('settings', 'Preferences', () => preferencesDialog(this)),
      (this.themeBtn = b('moon', 'Switch to dark mode', () => this.toggleTheme())),
    );
    this.applyPrefs();
  }

  shortcutsDialog() {
    const rows = [
      ['F5', 'Refresh tree / current tab'], ['F9', 'Run everything in the query tab'], ['Ctrl+F9', 'Run the selection'],
      ['Ctrl+Enter', 'Run the statement at the caret'], ['Ctrl+Shift+E', 'Explain the statement at the caret'], ['Ctrl+Space', 'Autocomplete (collections, methods, operators)'],
      ['Ctrl+/', 'Toggle line comment'], ['Tab / Shift+Tab', 'Indent / outdent'], ['Ctrl+S', 'Save query'], ['Ctrl+T', 'New query tab'], ['Ctrl+W', 'Close query tab'],
      ['F2 / Enter / typing', 'Edit a field in the document table'], ['Double-click / Enter', 'Edit the whole document'], ['Insert', 'Insert document'], ['Ctrl+Delete', 'Delete selected documents'],
      ['Alt+↓ in the filter', 'Recent filters'], ['Ctrl+C', 'Copy selected cells'], ['Ctrl+= / Ctrl+- / Ctrl+0', 'Zoom in / out / actual size'],
    ];
    return modal({ title: 'Keyboard shortcuts', width: 500, body: h('table', { class: 'kbd-table' }, rows.map(([k, d]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, d)))) });
  }

  syntaxDialog() {
    const ex = [
      ['use shop', 'Switch the tab to a database'], ['show dbs / show collections', 'List databases or collections'],
      ['db.orders.find({ status: "open" }, { total: 1 }).sort({ total: -1 }).limit(10)', 'Find with projection, sort and limit'],
      ['db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])', 'Aggregation pipeline'],
      ['db.orders.updateMany({ status: "open" }, { $set: { checked: ISODate() } })', 'Update'],
      ['db.orders.insertOne({ _id: ObjectId(), total: NumberDecimal("9.99") })', 'Insert with BSON types'],
      ['db.orders.find({ total: { $gt: 100 } }).explain("executionStats")', 'Query plan'],
      ['db.runCommand({ collStats: "orders" }) · db.adminCommand({ currentOp: 1 })', 'Any database command'],
      ['db.getSiblingDB("admin").getCollection("system.version").find()', 'Another database, any collection name'],
    ];
    return modal({
      title: 'Shell syntax', width: 760,
      body: h('div', null,
        h('p', { class: 'muted' }, 'Query tabs read mongosh-style statements, one per line or separated by semicolons. Arguments are literal values: JSON with unquoted keys and single quotes, ObjectId(), ISODate(), NumberLong(), NumberDecimal(), UUID(), Timestamp(), /regex/i. JavaScript (variables, functions, loops) is not run.'),
        h('table', { class: 'kbd-table' }, ex.map(([c, d]) => h('tr', null, h('td', null, h('code', null, c)), h('td', null, d))))),
    });
  }

  globalKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (NATIVE && ctrl && !e.altKey && ['=', '+', '-', '0'].includes(e.key)) {
      e.preventDefault();
      this.setZoom(e.key === '0' ? 100 : nextZoom(this.prefs.uiZoom, e.key === '-' ? -1 : 1));
      return;
    }
    if (modalIsOpen()) {
      if (e.key === 'F5' || (ctrl && ['r', 's'].includes(e.key.toLowerCase()))) e.preventDefault();
      return;
    }
    if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) { e.preventDefault(); this.refresh(); }
    else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); this.openQueryTab(); }
    else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'w' && this.activeQuery()) { e.preventDefault(); this.tabs.close(this.tabs.active); }
    else if (ctrl && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); this.activeQuery()?.saveToLibrary({ asNew: e.shiftKey }); }
    else if (e.key === 'F9' && !this.activeQuery()) { e.preventDefault(); this.queryForRun()?.run(e.ctrlKey ? 'selection' : 'all'); }
  }

  // ---------- connections ----------

  async connect(profileId, password, sshSecret) {
    this.setStatus('Connecting…');
    let info;
    for (;;) {
      try {
        info = await post('/connect', { sessionId: profileId, password, sshSecret });
        break;
      } catch (e) {
        if (e.code !== SSH_HOSTKEY_UNKNOWN) throw e;
        if (!(await confirmHostKey(e.data))) { this.setStatus('Connection cancelled.'); return false; }
        await post(`/sessions/${profileId}/hostkey`, { fingerprint: e.data.fingerprint });
      }
    }
    info.connectedAt = Date.now();
    this.conns.set(info.sid, info);
    const node = this.tree.addSession(info);
    this.tree.select(node);
    await this.tree.expand(node);
    this.tree.el.focus();
    this.setStatus(`Connected to ${info.name}.`);
  }

  async disconnect(sid) {
    if (!sid) return;
    try { await post(`/s/${sid}/disconnect`); } catch { /* already gone */ }
    this.conns.delete(sid);
    this.prodAllowed.delete(sid);
    this.tree.removeSession(sid);
    const next = this.tree.roots[0];
    if (next) this.tree.select(next);
    else {
      this.sel = { sid: null, db: null, coll: null };
      this.updateTabs();
      this.tabs.activate('host');
    }
  }

  async closeNativeWindow() {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.saveState();
      window.external.sendMessage('close');
    } finally { this.closing = false; }
  }

  async exit() {
    await this.saveState();
    try { await post('/exit'); } catch { /* ignore */ }
    window.close();
    document.body.innerHTML = '<div class="placeholder">ZawMongo has exited. You can close this window.</div>';
  }

  showError(e) {
    const msg = e?.message || String(e);
    if (msg === 'Cancelled.') return;
    this.log.error(msg);
    return alertError(msg);
  }

  // ---------- selection & tabs ----------

  onTreeSelect(node) {
    this.sel = { sid: node.sid, db: node.db ?? null, coll: node.depth === 2 ? node.name : null };
    if (node.depth === 2) {
      this.views.collection.open(node.sid, node.db, node.name);
      this.views.documents.open(node.sid, node.db, node.name);
    }
    this.updateTabs();
    let target = this.tabs.active;
    if (!target?.startsWith('q')) {
      if (node.type === 'session') target = 'host';
      else if (node.type === 'db') target = 'database';
      else if (!['collection', 'documents'].includes(target)) target = 'documents';
    }
    this.updateStatus();
    clearTimeout(this.showTimer);
    const from = this.tabs.active;
    this.showTimer = setTimeout(() => {
      if (this.tabs.active !== from) return;
      if (this.tabs.active === target) this.tabs.activeView()?.onShow?.();
      else this.tabs.activate(target);
    }, 120);
  }

  updateTabs() {
    const { sid, db, coll } = this.sel;
    const info = sid ? this.conns.get(sid) : null;
    const t = this.tabs;
    t.setTitle('host', info ? `Host: ${info.name}` : 'Host');
    t.setTitle('database', db ? `Database: ${db}` : 'Database');
    t.setTitle('collection', coll ? `Collection: ${coll}` : 'Collection');
    t.setTitle('documents', coll ? `Documents: ${coll}` : 'Documents');
    t.setDisabled('database', !db);
    t.setDisabled('collection', !coll);
    t.setDisabled('documents', !coll);
    const bar = document.getElementById('tabbar');
    bar.style.boxShadow = info?.color ? `inset 0 2px 0 ${info.color}` : '';
    for (const q of this.queryViews) if (this.tabs.active === q.id) q.onShow();
  }

  showHost(kind) {
    const node = this.tree.sessionNode(this.sel.sid);
    if (node && this.tree.sel !== node) this.tree.select(node, { silent: true });
    if (node) { this.sel = { sid: node.sid, db: null, coll: null }; this.updateTabs(); }
    this.views.host.kind = kind;
    if (this.tabs.active === 'host') this.views.host.refresh();
    else this.tabs.activate('host');
  }

  async selectDatabase(sid, db) {
    const s = this.tree.sessionNode(sid);
    if (!s) return;
    await this.tree.expand(s);
    const node = this.tree.findDb(sid, db);
    if (node) this.tree.select(node);
  }

  async selectCollection(sid, db, coll, tab) {
    const s = this.tree.sessionNode(sid);
    if (!s) return;
    await this.tree.expand(s);
    const dbNode = this.tree.findDb(sid, db);
    if (!dbNode) return;
    await this.tree.expand(dbNode);
    const node = this.tree.findColl(sid, db, coll);
    if (!node) return;
    if (this.tree.sel !== node) this.tree.select(node);
    if (tab) setTimeout(() => this.tabs.activate(tab), 140);
  }

  openDocuments(node) {
    this.selectCollection(node.sid, node.db, node.name, 'documents');
  }

  async refresh() {
    const n = this.tree.sel;
    if (document.activeElement === this.tree.el || !this.tabs.activeView()?.refresh) {
      if (n) {
        try { await this.tree.refresh(n.depth === 2 ? n.parent : n); } catch (e) { this.showError(e); }
      }
    }
    await this.tabs.activeView()?.refresh?.();
  }

  /** Something changed on a session (documents, collections, databases): refresh what shows it. */
  async afterChange(sid, db, { quiet = false } = {}) {
    try {
      const s = this.tree.sessionNode(sid);
      if (s?.children && !quiet) await this.tree.load(s);
      const d = db ? this.tree.findDb(sid, db) : null;
      if (d?.children) await this.tree.load(d);
    } catch { /* best effort */ }
  }

  // ---------- query tabs ----------

  openQueryTab(sql = '', title, { activate = true, savedId, db } = {}) {
    const id = 'q' + ++this.queryCounter;
    const v = new QueryView(this, { id, title: title || 'Query', sql, db: db ?? (this.sel.db || null), savedId });
    this.queryViews.push(v);
    this.tabs.add({
      id, title: v.title, iconName: 'query', view: v, closable: true,
      onClose: () => {
        this.queryViews.splice(this.queryViews.indexOf(v), 1);
        v.running?.abort();
        this.saveStateSoon();
      },
    });
    if (activate) this.tabs.activate(id);
    this.saveStateSoon();
    return v;
  }

  activeQuery() { return this.queryViews.find(v => v.id === this.tabs.active) || null; }

  /** The query tab to run in: the active one, else the last used, else a new one. */
  queryForRun() {
    const a = this.activeQuery();
    if (a) return a;
    const last = this.queryViews.at(-1) || this.openQueryTab();
    this.tabs.activate(last.id);
    return last;
  }

  addHistory(text, sid, db) {
    const list = (this.state.history ||= []);
    const name = this.conns.get(sid)?.name;
    const i = list.findIndex(x => x.text === text);
    if (i >= 0) list.splice(i, 1);
    list.unshift({ text, session: name, db, at: Date.now() });
    list.length = Math.min(list.length, HISTORY_MAX);
    this.saveStateSoon();
  }

  historyDialog(view) {
    const list = this.state.history || [];
    const filter = h('input', { class: 'inp wide', placeholder: 'Filter', spellcheck: false });
    const box = h('div', { class: 'hist-list' });
    let pick = null;
    const render = () => {
      const f = filter.value.toLowerCase();
      box.replaceChildren(...list.filter(x => !f || x.text.toLowerCase().includes(f)).slice(0, 200).map(x => {
        const el = h('div', { class: 'hist-item' }, h('div', { class: 'hist-meta muted' }, `${new Date(x.at).toLocaleString()} · ${x.session ?? ''}${x.db ? ' › ' + x.db : ''}`), h('pre', { class: 'hist-sql' }, x.text.length > 600 ? x.text.slice(0, 600) + '…' : x.text));
        el.onclick = () => { for (const s of box.children) s.classList.remove('sel'); el.classList.add('sel'); pick = x; };
        el.ondblclick = () => el.closest('.modal').querySelector('.btn.primary').click();
        return el;
      }));
    };
    filter.oninput = render;
    render();
    return modal({
      title: 'History', width: 760,
      body: h('div', { class: 'hist' }, filter, box),
      buttons: [{ label: 'Open', primary: true, onClick: () => {
        if (!pick) return false;
        if (view) { view.editor.insert((view.sql.trim() ? '\n' : '') + pick.text); this.tabs.activate(view.id); }
        else this.openQueryTab(pick.text, null, { db: pick.db });
        return true;
      } }, { label: 'Close', value: null }],
    });
  }

  libraryDialog(view) { return this.library.dialog(this, view); }

  // ---------- tree context menus and object actions ----------

  treeContextMenu(e, node) {
    if (!node) {
      contextMenu(e.clientX, e.clientY, [{ label: 'Session manager…', icon: 'sessions', onClick: () => sessionManager(this) }]);
      return;
    }
    this.tree.select(node);
    let items;
    if (node.type === 'session') {
      const ro = this.isReadOnly(node.sid);
      items = [
        { label: 'Refresh', icon: 'refresh', onClick: () => this.tree.refresh(node) },
        { label: 'Create database…', icon: 'database', disabled: ro, onClick: () => this.createCollectionDialog(node.sid, null) },
        { label: 'New query tab', icon: 'newtab', onClick: () => this.openQueryTab() },
        '-',
        { label: 'Server monitor', icon: 'monitor', onClick: () => this.showHost('monitor') },
        { label: 'Running operations', icon: 'ops', onClick: () => this.showHost('ops') },
        { label: 'Users and roles', icon: 'user', onClick: () => this.showHost('users') },
        { label: 'Replica set', icon: 'replica', onClick: () => this.showHost('replication') },
        '-',
        { label: 'Disconnect', icon: 'disconnect', onClick: () => this.disconnect(node.sid) },
      ];
    } else if (node.type === 'db') items = this.databaseMenu(node.sid, node.db);
    else items = this.collectionMenu(node.sid, node.db, node.name, node.type);
    contextMenu(e.clientX, e.clientY, items);
  }

  databaseMenu(sid, db) {
    const ro = this.isReadOnly(sid);
    return [
      { label: 'Refresh', icon: 'refresh', onClick: () => { const n = this.tree.findDb(sid, db); if (n) this.tree.load(n); } },
      { label: 'Create collection…', icon: 'plus', disabled: ro, onClick: () => this.createCollectionDialog(sid, db) },
      { label: 'Import JSON / CSV…', icon: 'import', disabled: ro, onClick: () => this.importInto(sid, db, null) },
      { label: 'New query tab here', icon: 'newtab', onClick: () => this.openQueryTab(`db.getCollectionNames()\n`, db, { db }) },
      { label: 'Statistics', icon: 'info', onClick: async () => {
        try {
          const s = await get(`/s/${sid}/dbstats`, { db });
          const { toShell } = await import('./ejson.js');
          modal({ title: `Statistics of ${db}`, width: 560, body: h('pre', { class: 'doc-json' }, toShell(s, 2)) });
        } catch (e) { this.showError(e); }
      } },
      '-',
      { label: 'Drop database…', icon: 'trash', disabled: ro, onClick: () => this.dropDatabase(sid, db) },
    ];
  }

  collectionMenu(sid, db, coll, type) {
    const ro = this.isReadOnly(sid);
    const view = type === 'view';
    const ref = /^[A-Za-z_$][\w$]*$/.test(coll) ? `db.${coll}` : `db.getCollection(${JSON.stringify(coll)})`;
    return [
      { label: 'Open documents', icon: 'doc', onClick: () => this.selectCollection(sid, db, coll, 'documents') },
      { label: 'Indexes and schema', icon: 'index', onClick: () => this.selectCollection(sid, db, coll, 'collection') },
      { label: 'New query tab', icon: 'newtab', onClick: () => this.openQueryTab(`${ref}.find({})\n`, coll, { db }) },
      { label: 'Aggregate in a query tab', icon: 'explain', onClick: () => this.openQueryTab(`${ref}.aggregate([\n  { $match: {} },\n  { $group: { _id: null, count: { $sum: 1 } } }\n])\n`, coll, { db }) },
      '-',
      { label: 'Insert document…', icon: 'plus', disabled: ro || view, onClick: async () => { await this.selectCollection(sid, db, coll, 'documents'); setTimeout(() => this.views.documents.docView.insertDialog(), 300); } },
      { label: 'Export…', icon: 'export', onClick: () => this.exportCollection(sid, db, coll) },
      { label: 'Import into…', icon: 'import', disabled: ro || view, onClick: () => this.importInto(sid, db, coll) },
      '-',
      { label: 'Rename…', icon: 'edit', disabled: ro || view, onClick: () => this.renameCollection(sid, db, coll) },
      { label: view ? 'Drop view…' : 'Drop collection…', icon: 'trash', disabled: ro, onClick: () => this.dropCollection(sid, db, coll) },
    ];
  }

  createCollectionDialog(sid, db) { return createCollectionDialog(this, sid, db); }
  exportCollection(sid, db, coll) {
    if (!coll) return this.showError(new Error('Select a collection to export.'));
    return exportDialog(this, sid, db, coll);
  }
  importInto(sid, db, coll) { return importDialog(this, sid, db, coll); }

  async renameCollection(sid, db, coll) {
    const to = await promptDlg('Rename collection', `New name for ${db}.${coll}:`, coll);
    if (!to || to === coll) return;
    if (!(await this.confirmChange(sid, `Rename ${db}.${coll} to ${to}?`))) return;
    try {
      await post(`/s/${sid}/collections/rename`, { db, coll, to });
      await this.afterChange(sid, db);
      this.selectCollection(sid, db, to);
    } catch (e) { this.showError(e); }
  }

  async dropCollection(sid, db, coll) {
    if (!(await confirmDlg(`Drop ${db}.${coll}? Its documents and indexes are deleted for good.`, { ok: 'Drop', danger: true }))) return;
    if (!(await this.confirmChange(sid, `Drop ${db}.${coll}?`))) return;
    try {
      await post(`/s/${sid}/collections/drop`, { db, coll });
      await this.afterChange(sid, db);
      this.selectDatabase(sid, db);
    } catch (e) { this.showError(e); }
  }

  async dropDatabase(sid, db) {
    const typed = await promptDlg('Drop database', `This deletes every collection of ${db}. Type the database name to confirm:`, '');
    if (typed !== db) { if (typed != null) alertError('The name did not match; nothing was dropped.'); return; }
    if (!(await this.confirmChange(sid, `Drop the database ${db}?`))) return;
    try {
      await post(`/s/${sid}/databases/drop`, { db });
      const s = this.tree.sessionNode(sid);
      if (s) { await this.tree.load(s); this.tree.select(s); }
    } catch (e) { this.showError(e); }
  }
}

const app = new App();
window.zawmongo = app;
app.init();
