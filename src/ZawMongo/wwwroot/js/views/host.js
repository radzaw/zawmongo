// Host tab: databases, a live monitor, running operations, users and roles, the replica set, and the server's own
// documents (serverStatus, buildInfo, hostInfo, command line, parameters).
import { h, esc, fmtBytes, fmtNum } from '../util.js';
import { icon } from '../icons.js';
import { get, post } from '../api.js';
import { Grid } from '../grid.js';
import { DocView } from '../docview.js';
import { modal, confirmDlg, contextMenu } from '../dialogs.js';
import { summary, toShell } from '../ejson.js';
import { fmtDuration } from '../logslow.js';

const KINDS = [['databases', 'database', 'Databases'], ['monitor', 'monitor', 'Monitor'], ['ops', 'ops', 'Operations'], ['users', 'user', 'Users'], ['replication', 'replica', 'Replica set'], ['server', 'info', 'Server']];
const SERVER_DOCS = [['status', 'serverStatus'], ['build', 'buildInfo'], ['host', 'hostInfo'], ['cmdline', 'Command line'], ['parameters', 'Parameters']];

function fmtUptime(s) {
  if (s == null) return '';
  const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min ${Math.floor(s % 60)} s`;
}

/** A small multi-series line chart as SVG. */
function chart(series, { height = 120, fmt = fmtNum } = {}) {
  const w = 600, hgt = height, n = Math.max(2, ...series.map(s => s.values.length));
  const max = Math.max(1e-9, ...series.flatMap(s => s.values.filter(v => v != null)));
  const lines = series.map((s, i) => {
    const pts = s.values.map((v, k) => v == null ? null : `${(k / (n - 1) * w).toFixed(1)},${(hgt - 4 - v / max * (hgt - 8)).toFixed(1)}`).filter(Boolean).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="var(--series-${i + 1})" stroke-width="1.8" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const legend = series.map((s, i) => `<span class="mon-legend-item"><span class="color-dot" style="background:var(--series-${i + 1})"></span>${esc(s.name)} <b>${fmt(s.values.at(-1) ?? 0)}</b></span>`).join('');
  return h('div', { class: 'mon-card' },
    h('div', { class: 'mon-legend', html: legend }),
    h('div', { class: 'mon-plot', html: `<svg class="mon-svg" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" style="height:${hgt}px"><line x1="0" y1="${hgt - 4}" x2="${w}" y2="${hgt - 4}" stroke="var(--line)"/>${lines}</svg><div class="mon-max muted">${fmt(max)}</div>` }));
}

export class HostView {
  constructor(app) {
    this.app = app;
    this.kind = 'databases';
    this.btns = new Map();
    this.tabsEl = h('div', { class: 'subtabs' }, KINDS.map(([k, ic, label]) => {
      const b = h('button', { class: 'subtab', html: icon(ic) + label, onclick: () => this.switchKind(k) });
      this.btns.set(k, b);
      return b;
    }));
    this.title = h('span', { class: 'viewtitle' });
    this.actions = h('span', { class: 'coll-actions' });
    this.body = h('div', { class: 'coll-body' });
    this.el = h('div', { class: 'view' }, h('div', { class: 'viewbar' }, this.title, this.tabsEl, h('span', { class: 'grow' }), this.actions,
      h('button', { class: 'tbtn', title: 'Refresh (F5)', html: icon('refresh'), onclick: () => this.refresh() })), this.body);
    this.samples = [];
  }

  switchKind(k) {
    this.kind = k;
    this.stopTimer();
    this.refresh();
  }

  get sid() { return this.app.sel.sid; }

  onShow() { this.refresh(); }
  onHide() { this.stopTimer(); }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  }

  every(ms, fn) {
    this.stopTimer();
    this.timer = setInterval(() => { if (this.app.tabs.active === 'host' && document.visibilityState === 'visible') fn(); }, ms);
  }

  async refresh() {
    for (const [k, b] of this.btns) b.classList.toggle('active', k === this.kind);
    this.actions.replaceChildren();
    const info = this.app.conns.get(this.sid);
    if (!info) {
      this.title.textContent = '';
      this.body.replaceChildren(h('div', { class: 'placeholder' }, 'Not connected. Open the session manager to connect to a server.'));
      return;
    }
    this.title.innerHTML = icon('server') + `<span>${esc(info.name)}</span>`;
    if (this.sampleSid !== this.sid) { this.samples = []; this.sampleSid = this.sid; }
    try {
      await ({ databases: () => this.databases(), monitor: () => this.monitor(), ops: () => this.ops(), users: () => this.users(), replication: () => this.replication(), server: () => this.server() })[this.kind]();
    } catch (e) {
      this.body.replaceChildren(h('div', { class: 'placeholder error' }, e.message));
    }
  }

  // ---------- databases ----------

  async databases() {
    const node = this.app.tree.sessionNode(this.sid);
    const dbs = await get(`/s/${this.sid}/databases`);
    if (node?.children) this.app.tree.load(node).catch(() => {});
    const info = this.app.conns.get(this.sid);
    this.actions.append(h('button', { class: 'btn', disabled: info.readOnly, html: icon('plus') + ' Create database…', onclick: () => this.app.createCollectionDialog(this.sid, null) }));
    const grid = new Grid({ onActivate: r => this.app.selectDatabase(this.sid, dbs[r].name), onContextMenu: (e, p) => contextMenu(e.clientX, e.clientY, this.app.databaseMenu(this.sid, dbs[p.r].name)) });
    grid.setData([{ name: 'Database', kind: 'text' }, { name: 'Size on disk', kind: 'int', fmt: fmtBytes }, { name: 'Empty', kind: 'text' }],
      dbs.map(d => [d.name, String(d.size), d.empty ? 'yes' : '']));
    const total = dbs.reduce((s, d) => s + d.size, 0);
    this.body.replaceChildren(grid.el, h('div', { class: 'q-msg' }, `${dbs.length} databases · ${fmtBytes(total)} on disk · MongoDB ${info.version}${info.replicaSet ? ` · replica set ${info.replicaSet} (${info.primary ? 'primary' : 'not primary'})` : ` · ${info.topology}`}`));
  }

  // ---------- monitor ----------

  async monitor() {
    const interval = h('select', { class: 'inp' }, [1, 2, 5, 10].map(s => h('option', { value: s, selected: s === (this.app.prefs.monitorSecs || 2) }, `every ${s} s`)));
    interval.addEventListener('change', () => { this.app.prefs.monitorSecs = +interval.value; this.app.saveStateSoon(); this.every(+interval.value * 1000, () => this.sample()); });
    this.actions.append(interval);
    this.monEl = h('div', { class: 'pad mon-body' }, h('div', { class: 'placeholder' }, 'Collecting…'));
    this.body.replaceChildren(this.monEl);
    await this.sample();
    this.every((this.app.prefs.monitorSecs || 2) * 1000, () => this.sample());
  }

  async sample() {
    const sid = this.sid;
    let s;
    try { s = await get(`/s/${sid}/monitor`, null, { quiet: true }); } catch (e) { this.monEl?.replaceChildren(h('div', { class: 'placeholder error' }, e.message)); return; }
    if (sid !== this.sid || this.kind !== 'monitor') return;
    this.samples.push(s);
    if (this.samples.length > 301) this.samples.shift();
    this.renderMonitor();
  }

  renderMonitor() {
    const S = this.samples;
    const last = S.at(-1);
    const rate = (get1) => S.map((s, i) => {
      if (!i) return null;
      const p = S[i - 1], dt = (s.time - p.time) / 1000;
      const a = get1(s), b = get1(p);
      return a == null || b == null || dt <= 0 || a < b ? null : (a - b) / dt;
    }).slice(1);
    const gauge = g => S.map(g).slice(1);
    const opsTypes = ['query', 'insert', 'update', 'delete', 'getmore', 'command'];
    const opsSeries = opsTypes.map(t => ({ name: t, values: rate(s => s.ops[t]) }));
    const qps = opsSeries.reduce((sum, s) => sum + (s.values.at(-1) ?? 0), 0);
    const lat = (k, n) => {
      const r1 = rate(s => s.latency[k]), r2 = rate(s => s.latency[n]);
      return r1.map((v, i) => (v != null && r2[i] ? v / r2[i] / 1000 : null));
    };
    const cache = last.cache.max ? last.cache.used / last.cache.max : null;
    const conns = last.connections;
    const tiles = [
      ['Operations / s', fmtNum(Math.round(qps)), 'all opcounters'],
      ['Connections', fmtNum(conns.current), `${fmtNum(conns.active)} active · ${fmtNum(conns.available)} available`],
      ['Cache', cache != null ? (cache < 0.1 ? (cache * 100).toFixed(1) : Math.round(cache * 100)) + '%' : '–', `${fmtBytes(last.cache.used)} of ${fmtBytes(last.cache.max)}, ${fmtBytes(last.cache.dirty)} dirty`],
      ['Memory (resident)', last.mem.resident != null ? fmtBytes(last.mem.resident * 1024 * 1024) : '–', `virtual ${fmtBytes((last.mem.virtual || 0) * 1024 * 1024)}`],
      ['Queued', fmtNum((last.queue.readers || 0) + (last.queue.writers || 0)), `${fmtNum(last.queue.readers)} readers · ${fmtNum(last.queue.writers)} writers`],
      ['Uptime', fmtUptime(last.uptime), last.host || ''],
    ];
    if (S.length < 3) {
      this.monEl.replaceChildren(h('div', { class: 'mon-tiles' }, tiles.map(([l, v, sub]) => h('div', { class: 'mon-tile' }, h('div', { class: 'mon-tile-label' }, l), h('div', { class: 'mon-tile-value' }, v), h('div', { class: 'mon-tile-sub' }, sub)))),
        h('div', { class: 'placeholder' }, 'Rates appear after a few samples…'));
      return;
    }
    const f1 = v => fmtNum(Math.round(v * 10) / 10);
    this.monEl.replaceChildren(
      h('div', { class: 'mon-tiles' }, tiles.map(([l, v, sub]) => h('div', { class: 'mon-tile' }, h('div', { class: 'mon-tile-label' }, l), h('div', { class: 'mon-tile-value' }, v), h('div', { class: 'mon-tile-sub' }, sub)))),
      h('div', { class: 'mon-grid' },
        h('div', null, h('div', { class: 'mon-card-title' }, 'Operations per second'), chart(opsSeries, { fmt: f1 })),
        h('div', null, h('div', { class: 'mon-card-title' }, 'Documents per second'), chart(['returned', 'inserted', 'updated', 'deleted'].map(k => ({ name: k, values: rate(s => s.docs[k]) })), { fmt: f1 })),
        h('div', null, h('div', { class: 'mon-card-title' }, 'Average latency (ms)'), chart([{ name: 'reads', values: lat('reads', 'readOps') }, { name: 'writes', values: lat('writes', 'writeOps') }, { name: 'commands', values: lat('commands', 'commandOps') }], { fmt: v => v.toFixed(2) })),
        h('div', null, h('div', { class: 'mon-card-title' }, 'Network'), chart([{ name: 'in', values: rate(s => s.network.bytesIn) }, { name: 'out', values: rate(s => s.network.bytesOut) }], { fmt: v => fmtBytes(v) + '/s' })),
        h('div', null, h('div', { class: 'mon-card-title' }, 'Connections and queues'), chart([{ name: 'connections', values: gauge(s => s.connections.current) }, { name: 'active', values: gauge(s => s.connections.active) }, { name: 'queued', values: gauge(s => (s.queue.readers || 0) + (s.queue.writers || 0)) }])),
        h('div', null, h('div', { class: 'mon-card-title' }, 'Scanned per second'), chart([{ name: 'index keys', values: rate(s => s.scanned.keys) }, { name: 'documents', values: rate(s => s.scanned.objects) }], { fmt: f1 }))),
      h('div', { class: 'muted note' }, `The monitor's own requests count too (one serverStatus per sample). Not written to the log.`));
  }

  // ---------- operations ----------

  async ops() {
    const all = h('input', { type: 'checkbox', checked: !!this.opsAll });
    const auto = h('input', { type: 'checkbox', checked: this.opsAuto !== false });
    const minSecs = h('select', { class: 'inp' }, [0, 1, 5, 30, 60].map(s => h('option', { value: s, selected: s === (this.opsMin || 0) }, s ? `running ≥ ${s} s` : 'any duration')));
    const killBtn = h('button', { class: 'btn', disabled: this.app.isReadOnly(this.sid), html: icon('stop') + ' Kill' });
    all.onchange = () => { this.opsAll = all.checked; load(); };
    minSecs.onchange = () => { this.opsMin = +minSecs.value; load(); };
    auto.onchange = () => { this.opsAuto = auto.checked; if (auto.checked) this.every(2000, load); else this.stopTimer(); };
    this.actions.append(minSecs, h('label', { class: 'chk', title: 'Idle connections and internal operations too' }, all, 'All'), h('label', { class: 'chk' }, auto, 'Refresh every 2 s'), killBtn);
    let ops = [];
    const grid = new Grid({ arrange: true, onActivate: r => modal({ title: `Operation ${summary(ops[r].opid)}`, width: 640, body: h('pre', { class: 'doc-json' }, toShell(ops[r].raw, 2)) }) });
    const msg = h('div', { class: 'q-msg' });
    this.body.replaceChildren(grid.el, msg);
    const load = async () => {
      let list;
      try { list = await get(`/s/${this.sid}/ops`, { all: !!this.opsAll }, { quiet: true }); } catch (e) { msg.textContent = e.message; return; }
      if (this.kind !== 'ops') return;
      ops = list.filter(o => (o.secs ?? 0) >= (this.opsMin || 0));
      grid.setData([
        { name: 'opid', kind: 'int' }, { name: 'Op', kind: 'text' }, { name: 'Namespace', kind: 'text' }, { name: 'Running', kind: 'int' }, { name: 'Client', kind: 'text' },
        { name: 'App', kind: 'text' }, { name: 'User', kind: 'text' }, { name: 'Plan', kind: 'text' }, { name: 'Waiting for lock', kind: 'text' }, { name: 'Command', kind: 'text' },
      ], ops.map(o => [summary(o.opid), o.op || o.desc, o.ns, o.micros != null ? fmtDuration(o.micros / 1000) : '', o.client, o.app, o.user, o.planSummary, o.waitingForLock ? 'yes' : '', o.command ? toShell(o.command, 0).slice(0, 300) : o.msg || '']),
        { keepWidths: true, keepPos: true });
      msg.textContent = `${ops.length} operation${ops.length === 1 ? '' : 's'}${list.length !== ops.length ? ` (${list.length - ops.length} shorter ones hidden)` : ''} · double-click for details`;
    };
    killBtn.onclick = async () => {
      const rows = grid.selectedRowIndexes().map(r => ops[r]).filter(Boolean);
      if (!rows.length) return;
      if (!(await confirmDlg(`Kill ${rows.length === 1 ? `operation ${summary(rows[0].opid)} (${rows[0].op} on ${rows[0].ns || 'no namespace'})` : rows.length + ' operations'}?`, { ok: 'Kill', danger: true }))) return;
      if (!(await this.app.confirmChange(this.sid, 'Kill operations?', { asked: true }))) return;
      for (const o of rows) {
        try { await post(`/s/${this.sid}/killop`, { op: o.opid }); } catch (e) { this.app.showError(e); break; }
      }
      load();
    };
    await load();
    if (this.opsAuto !== false) this.every(2000, load);
  }

  // ---------- users ----------

  async users() {
    const scope = h('select', { class: 'inp', title: 'Users defined in' }, h('option', { value: '' }, 'All databases'),
      (this.app.tree.sessionNode(this.sid)?.children || []).map(d => h('option', { value: d.db, selected: d.db === this.userDb }, d.db)));
    scope.onchange = () => { this.userDb = scope.value || null; this.users(); };
    const ro = this.app.isReadOnly(this.sid);
    this.actions.append(scope, h('button', { class: 'btn', disabled: ro, html: icon('plus') + ' Add user…', onclick: () => this.userDialog() }));
    let users;
    try {
      users = await get(`/s/${this.sid}/users`, { db: this.userDb || '' });
    } catch (e) {
      if (!this.userDb && /not authorized|Unauthorized/i.test(e.message)) { this.body.replaceChildren(h('div', { class: 'placeholder' }, 'Listing the users of every database needs privileges on admin. Pick a database above.')); return; }
      throw e;
    }
    const list = h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['User', 'Database', 'Roles', 'Mechanisms', ''].map(x => h('th', null, x)))),
      h('tbody', null, users.map(u => h('tr', null,
        h('td', null, h('b', null, u.user)), h('td', null, u.db),
        h('td', null, u.roles.map(r => h('span', { class: 'tag', title: `${r.role} on ${r.db}` }, r.db === u.db ? r.role : `${r.role}@${r.db}`))),
        h('td', { class: 'muted' }, u.mechanisms.join(', ')),
        h('td', null,
          h('button', { class: 'tbtn', title: 'Roles…', disabled: ro, html: icon('key'), onclick: () => this.rolesDialog(u) }),
          h('button', { class: 'tbtn', title: 'Change password…', disabled: ro || u.db === '$external', html: icon('edit'), onclick: () => this.passwordDialog(u) }),
          h('button', { class: 'tbtn', title: 'Drop user', disabled: ro, html: icon('trash'), onclick: () => this.dropUser(u) }))))));
    this.body.replaceChildren(h('div', { class: 'pad' }, users.length ? list : h('div', { class: 'placeholder' }, 'No users. Without users (and with authorization off) anyone who can reach the server can do anything.')));
  }

  rolePicker(db, selected = []) {
    const box = h('div', { class: 'role-picker' }, h('div', { class: 'muted' }, 'Loading roles…'));
    const extra = h('input', { class: 'inp wide mono', placeholder: 'other roles: readWrite@shop, read@reports', spellcheck: false });
    const own = new Set(selected.filter(r => r.db === db).map(r => r.role));
    extra.value = selected.filter(r => r.db !== db).map(r => `${r.role}@${r.db}`).join(', ');
    get(`/s/${this.sid}/roles`, { db }).then(roles => {
      box.replaceChildren(...roles.filter(r => r.db === db).map(r => h('label', { class: 'chk', title: r.builtin ? 'Built-in role' : 'User-defined role' }, h('input', { type: 'checkbox', value: r.role, checked: own.has(r.role) }), r.role)));
    }).catch(e => box.replaceChildren(h('div', { class: 'muted' }, e.message)));
    const value = () => [
      ...[...box.querySelectorAll('input:checked')].map(c => ({ role: c.value, db })),
      ...extra.value.split(',').map(s => s.trim()).filter(Boolean).map(s => { const [role, rdb] = s.split('@'); return { role: role.trim(), db: (rdb || db).trim() }; }),
    ];
    return { el: h('div', null, box, extra), value };
  }

  async userDialog() {
    const db = this.userDb || 'admin';
    const name = h('input', { class: 'inp wide', spellcheck: false });
    const pwd = h('input', { class: 'inp wide', type: 'password', autocomplete: 'new-password' });
    const dbIn = h('input', { class: 'inp wide', value: db, spellcheck: false });
    const roles = this.rolePicker(db);
    const ok = await modal({
      title: 'Add user', width: 560,
      body: h('div', { class: 'form2' },
        h('label', { class: 'frow' }, h('span', null, 'User name'), name),
        h('label', { class: 'frow' }, h('span', null, 'Password'), pwd),
        h('label', { class: 'frow' }, h('span', null, 'Defined in'), dbIn),
        h('div', { class: 'frow' }, h('span', null, `Roles on ${db}`), roles.el)),
      buttons: [{ label: 'Create', primary: true, onClick: async () => {
        if (!(await this.app.confirmChange(this.sid, `Create user ${name.value}?`))) return false;
        await post(`/s/${this.sid}/users/create`, { db: dbIn.value.trim(), user: name.value, password: pwd.value, roles: roles.value() });
        return true;
      } }, { label: 'Cancel', value: false }],
    });
    if (ok) this.users();
  }

  async rolesDialog(u) {
    const roles = this.rolePicker(u.db, u.roles);
    const ok = await modal({
      title: `Roles of ${u.user}@${u.db}`, width: 560,
      body: h('div', { class: 'form2' }, roles.el),
      buttons: [{ label: 'Save', primary: true, onClick: async () => {
        const want = roles.value(), key = r => `${r.role}@${r.db}`;
        const have = new Set(u.roles.map(key)), next = new Set(want.map(key));
        const grant = want.filter(r => !have.has(key(r))), revoke = u.roles.filter(r => !next.has(key(r)));
        if (!grant.length && !revoke.length) return true;
        if (!(await this.app.confirmChange(this.sid, `Change the roles of ${u.user}?`))) return false;
        await post(`/s/${this.sid}/users/roles`, { db: u.db, user: u.user, grant, revoke });
        return true;
      } }, { label: 'Cancel', value: false }],
    });
    if (ok) this.users();
  }

  async passwordDialog(u) {
    const pwd = h('input', { class: 'inp wide', type: 'password', autocomplete: 'new-password' });
    const ok = await modal({
      title: `Password of ${u.user}`, width: 420,
      body: h('div', { class: 'form' }, h('label', null, 'New password'), pwd),
      buttons: [{ label: 'Change', primary: true, onClick: async () => {
        if (!(await this.app.confirmChange(this.sid, `Change the password of ${u.user}?`))) return false;
        await post(`/s/${this.sid}/users/password`, { db: u.db, user: u.user, password: pwd.value });
        return true;
      } }, { label: 'Cancel', value: false }],
    });
    if (ok) this.app.setStatus(`Password of ${u.user} changed.`);
  }

  async dropUser(u) {
    if (!(await confirmDlg(`Drop the user ${u.user}@${u.db}?`, { ok: 'Drop', danger: true })) || !(await this.app.confirmChange(this.sid, `Drop user ${u.user}?`, { asked: true }))) return;
    try { await post(`/s/${this.sid}/users/drop`, { db: u.db, user: u.user }); this.users(); } catch (e) { this.app.showError(e); }
  }

  // ---------- replica set ----------

  async replication() {
    const load = async () => {
      const r = await get(`/s/${this.sid}/replication`, null, { quiet: true });
      if (this.kind !== 'replication') return;
      if (!r.replicaSet) { this.body.replaceChildren(h('div', { class: 'placeholder' }, r.message)); this.stopTimer(); return; }
      const stateCls = s => (s === 'PRIMARY' ? 'ok' : s === 'SECONDARY' ? '' : s === 'ARBITER' ? 'muted' : 'bad');
      const maxLag = Math.max(0, ...r.members.map(m => m.lagSeconds ?? 0));
      const unhealthy = r.members.filter(m => m.health !== 1).length;
      const verdict = unhealthy ? `${unhealthy} member${unhealthy === 1 ? ' is' : 's are'} down` : !r.members.some(m => m.state === 'PRIMARY') ? 'No primary: writes are not possible' : maxLag > 10 ? `Secondaries up to ${Math.round(maxLag)} s behind` : 'Healthy';
      this.body.replaceChildren(h('div', { class: 'pad' },
        h('div', { class: 'rp-head' }, h('b', null, `Replica set ${r.set}`), h('span', { class: 'tag ' + (verdict === 'Healthy' ? 'ok' : 'bad') }, verdict), r.term != null ? h('span', { class: 'muted' }, `term ${r.term}`) : null),
        h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, ['Member', 'State', 'Health', 'Behind primary', 'Ping', 'Syncs from', 'Uptime', 'Priority / votes', 'Message'].map(x => h('th', null, x)))),
          h('tbody', null, r.members.map(m => h('tr', null,
            h('td', null, h('b', null, m.name), m.self ? h('span', { class: 'tag' }, 'this connection') : null, m.hidden ? h('span', { class: 'tag' }, 'hidden') : null, m.delaySecs ? h('span', { class: 'tag' }, `delayed ${m.delaySecs} s`) : null),
            h('td', null, h('span', { class: 'tag ' + stateCls(m.state) }, m.state)),
            h('td', null, m.health === 1 ? 'up' : 'down'),
            h('td', { class: 'num' + ((m.lagSeconds ?? 0) > 10 ? ' warn-text' : '') }, m.state === 'PRIMARY' || m.lagSeconds == null ? '' : `${Math.round(m.lagSeconds)} s`),
            h('td', { class: 'num' }, m.pingMs != null ? `${m.pingMs} ms` : ''),
            h('td', null, m.syncSource),
            h('td', null, fmtUptime(m.uptime)),
            h('td', null, m.priority != null ? `${m.priority} / ${m.votes}` : ''),
            h('td', { class: 'muted ellipsis' }, m.message))))),
        r.config ? h('details', { class: 'raw' }, h('summary', null, 'Configuration (replSetGetConfig)'), h('pre', { class: 'doc-json' }, toShell(r.config, 2))) : null));
    };
    await load();
    this.every(5000, () => load().catch(() => {}));
  }

  // ---------- server documents ----------

  async server() {
    const which = h('select', { class: 'inp' }, SERVER_DOCS.map(([k, l]) => h('option', { value: k, selected: k === (this.serverDoc || 'status') }, l)));
    which.onchange = () => { this.serverDoc = which.value; this.server(); };
    this.actions.append(which);
    const doc = await get(`/s/${this.sid}/server`, { kind: this.serverDoc || 'status' });
    const dv = new DocView(this.app);
    dv.setMode('tree', false);
    dv.modeBar.style.display = 'none';
    dv.setDocs([doc]);
    this.body.replaceChildren(dv.el);
    dv.list.querySelectorAll('.dt-node').forEach(n => n.classList.add('closed'));
  }
}
