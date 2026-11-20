// Dialogs: session manager, import and export, create collection, preferences, about.
import { h, esc, fmtBytes, fmtNum, NATIVE, ZOOM_STEPS } from '../util.js';
import { pickFile, NATIVE_DIALOGS } from '../files.js';
import { icon } from '../icons.js';
import { get, post, del, upload, urlWithToken, SSH_HOSTKEY_UNKNOWN } from '../api.js';
import { modal, confirmDlg, alertError } from '../dialogs.js';
import { SLOW_CHOICES, thresholdLabel, slowThreshold } from '../logslow.js';
import { toShell } from '../ejson.js';
import { highlight } from '../editor.js';

// ---------------------------------------------------------------- session manager

const SESSION_COLORS = ['', '#d13438', '#ca5010', '#c19c00', '#107c10', '#0078d4', '#8764b8', '#69797e'];
const MECHANISMS = [['', 'Default (SCRAM)'], ['SCRAM-SHA-256', 'SCRAM-SHA-256'], ['SCRAM-SHA-1', 'SCRAM-SHA-1'], ['MONGODB-X509', 'X.509 certificate'], ['PLAIN', 'LDAP (PLAIN)']];
const READ_PREFS = ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'];

export async function sessionManager(app) {
  let sessions = [];
  try { sessions = await get('/sessions'); } catch (e) { return app.showError(e); }
  let cur = null, dirty = false, pwdDirty = false, sshDirty = false;

  const f = {
    name: h('input', { class: 'inp', spellcheck: false }),
    mode: h('select', { class: 'inp' }, h('option', { value: 'fields' }, 'Host and port'), h('option', { value: 'uri' }, 'Connection string (mongodb:// or mongodb+srv://)')),
    uri: h('textarea', { class: 'inp mono', rows: 3, spellcheck: false, placeholder: 'mongodb+srv://user@cluster0.example.mongodb.net/?retryWrites=true' }),
    host: h('input', { class: 'inp', spellcheck: false }),
    port: h('input', { class: 'inp', type: 'number', min: 1, max: 65535 }),
    srv: h('input', { type: 'checkbox' }),
    user: h('input', { class: 'inp', spellcheck: false, placeholder: 'empty: no authentication' }),
    password: h('input', { class: 'inp', type: 'password' }),
    savePassword: h('input', { type: 'checkbox' }),
    authDatabase: h('input', { class: 'inp', spellcheck: false, placeholder: 'admin' }),
    authMechanism: h('select', { class: 'inp' }, MECHANISMS.map(([v, l]) => h('option', { value: v }, l))),
    replicaSet: h('input', { class: 'inp', spellcheck: false, placeholder: 'empty: connect to this server only' }),
    directConnection: h('input', { type: 'checkbox' }),
    tls: h('input', { type: 'checkbox' }),
    tlsInsecure: h('input', { type: 'checkbox' }),
    readPreference: h('select', { class: 'inp' }, READ_PREFS.map(v => h('option', { value: v }, v))),
    defaultDatabase: h('input', { class: 'inp', spellcheck: false, placeholder: 'test' }),
    databases: h('input', { class: 'inp', spellcheck: false, placeholder: 'Separated by semicolon; empty = all' }),
    connectTimeout: h('input', { class: 'inp', type: 'number', min: 1, max: 600 }),
    readOnly: h('input', { type: 'checkbox' }),
    production: h('input', { type: 'checkbox' }),
    sshEnabled: h('input', { type: 'checkbox' }),
    sshHost: h('input', { class: 'inp', spellcheck: false, placeholder: 'ssh.example.com' }),
    sshPort: h('input', { class: 'inp', type: 'number', min: 1, max: 65535 }),
    sshUser: h('input', { class: 'inp', spellcheck: false }),
    sshAuth: h('select', { class: 'inp' }, h('option', { value: 'password' }, 'Password'), h('option', { value: 'key' }, 'Private key')),
    sshKeyFile: h('input', { class: 'inp', spellcheck: false, placeholder: '~/.ssh/id_ed25519 – or paste the key text' }),
    sshSecret: h('input', { class: 'inp', type: 'password' }),
    comment: h('textarea', { class: 'inp', rows: 3 }),
  };
  let colorVal = '';
  const custom = h('input', { type: 'color', class: 'color-custom', title: 'Custom color' });
  const swatches = h('div', { class: 'swatches' });
  const setColor = (c, markDirty = true) => {
    colorVal = c;
    for (const s of swatches.querySelectorAll('.swatch')) s.classList.toggle('sel', s.dataset.c === c);
    custom.classList.toggle('sel', !!c && !SESSION_COLORS.includes(c));
    if (c) custom.value = c;
    if (markDirty) dirty = true;
  };
  swatches.append(...SESSION_COLORS.map(c => h('button', {
    class: 'swatch' + (c ? '' : ' none'), type: 'button', 'data-c': c, title: c || 'No color',
    style: c ? { background: c } : null, onclick: () => setColor(c),
  })), custom);
  custom.addEventListener('input', () => setColor(custom.value));
  f.production.addEventListener('change', () => { if (f.production.checked && !colorVal) setColor('#d13438'); });

  const row = (label, input, title) => h('label', { class: 'frow', title }, h('span', null, label), input);
  const hostKeyText = h('code', { class: 'sm-hostkey' });
  const forgetBtn = h('button', {
    class: 'tbtn', type: 'button', title: 'Forget the trusted host key; you will be asked to confirm it on the next connection',
    onclick: async () => {
      if (!cur) return;
      if (cur.id) await post(`/sessions/${cur.id}/hostkey`, { fingerprint: null }).catch(e => alertError(e.message));
      cur.sshHostKey = null;
      sync();
    },
  }, 'Forget');
  const fieldRows = {
    host: row('Host:', f.host), port: row('Port:', f.port),
    srv: row('', h('label', { class: 'chk', title: 'mongodb+srv:// – the host is a DNS seed list name (Atlas); TLS is on and the port is not used' }, f.srv, ' DNS seed list (SRV)')),
    user: row('User:', f.user), authDatabase: row('Auth database:', f.authDatabase), authMechanism: row('Mechanism:', f.authMechanism),
    replicaSet: row('Replica set:', f.replicaSet),
    directConnection: row('', h('label', { class: 'chk', title: 'Talk to this server only, even if it is a secondary of a replica set' }, f.directConnection, ' Direct connection')),
    tls: row('', h('label', { class: 'chk' }, f.tls, ' TLS / SSL')),
    tlsInsecure: row('', h('label', { class: 'chk', title: 'Accept self-signed or mismatched certificates (test servers only)' }, f.tlsInsecure, ' Allow invalid certificates')),
    readPreference: row('Read preference:', f.readPreference),
  };
  const uriRow = row('Connection string:', f.uri, 'The password typed here is stored encrypted, apart from the string.');
  const sshRows = {
    host: row('SSH host:', f.sshHost), port: row('SSH port:', f.sshPort), user: row('SSH user:', f.sshUser), auth: row('Authentication:', f.sshAuth),
    key: row('Private key:', f.sshKeyFile), secret: row('SSH password:', f.sshSecret),
    hostKey: h('div', { class: 'frow' }, h('span', null, 'Host key:'), h('div', { class: 'sm-hostkey-row' }, hostKeyText, forgetBtn)),
  };
  function sync() {
    const uri = f.mode.value === 'uri';
    uriRow.style.display = uri ? '' : 'none';
    for (const r of Object.values(fieldRows)) r.style.display = uri ? 'none' : '';
    const srv = f.srv.checked;
    fieldRows.port.style.display = uri || srv ? 'none' : '';
    fieldRows.directConnection.style.display = uri || srv ? 'none' : '';
    const on = f.sshEnabled.checked;
    for (const r of Object.values(sshRows)) r.style.display = on ? '' : 'none';
    const key = f.sshAuth.value === 'key';
    sshRows.key.style.display = on && key ? '' : 'none';
    sshRows.secret.firstChild.textContent = key ? 'Key passphrase:' : 'SSH password:';
    f.sshSecret.placeholder = cur?.hasSshSecret ? '(saved – type to change)' : key ? 'Only if the key is encrypted' : '';
    hostKeyText.textContent = cur?.sshHostKey || 'not trusted yet – you will be asked to confirm it';
    forgetBtn.style.display = cur?.sshHostKey ? '' : 'none';
    f.host.placeholder = on ? 'As seen from the SSH server, usually 127.0.0.1' : srv ? 'cluster0.example.mongodb.net' : '127.0.0.1 or hostname';
  }
  for (const k of ['mode', 'srv', 'sshEnabled', 'sshAuth']) f[k].addEventListener('change', sync);

  const list = h('div', { class: 'sm-list', tabindex: 0 });
  const form = h('div', { class: 'form2 sm-form' },
    row('Session name:', f.name),
    h('div', { class: 'sm-sep' }, 'Server'),
    row('Connect with:', f.mode),
    uriRow,
    ...Object.values(fieldRows).slice(0, 3),
    fieldRows.user,
    row('Password:', f.password),
    row('', h('label', { class: 'chk' }, f.savePassword, ' Save passwords')),
    ...Object.values(fieldRows).slice(4),
    row('Default database:', f.defaultDatabase, 'The database new query tabs start in'),
    row('Databases:', f.databases, 'Show only these databases in the tree (also lets users without listDatabases see theirs)'),
    row('Connect timeout (s):', f.connectTimeout),
    row('', h('label', { class: 'chk', title: 'Only reading commands can run; inserts, updates, deletes, index and collection changes are blocked.' }, f.readOnly, ' Read-only mode (no changes possible)')),
    row('', h('label', { class: 'chk', title: 'Highlights the session everywhere and asks for confirmation before any change.' }, f.production, ' Production server (confirm every change)')),
    row('Color:', swatches),
    h('div', { class: 'sm-sep' }, 'SSH tunnel'),
    row('', h('label', { class: 'chk' }, f.sshEnabled, ' Connect through an SSH tunnel')),
    ...Object.values(sshRows),
    h('div', { class: 'sm-sep' }, 'Notes'),
    row('Comment:', f.comment));
  const empty = h('div', { class: 'placeholder' }, 'Create a session with the "New" button.');
  const right = h('div', { class: 'sm-right' });

  for (const [k, el] of Object.entries(f)) {
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      dirty = true;
      if (k === 'password') pwdDirty = true;
      if (k === 'sshSecret') sshDirty = true;
      if (k === 'name' && cur) { cur.name = f.name.value; renderList(); }
    });
  }

  function renderList() {
    list.innerHTML = sessions.map((s, i) => `<div class="sm-item${s === cur ? ' sel' : ''}" data-i="${i}">${s.color ? `<span class="color-dot" style="background:${s.color}"></span>` : '<span class="color-dot"></span>'}${icon('server')}<span>${esc(s.name || '(unnamed)')}</span>${s.sshEnabled ? '<span class="um-tag" title="SSH tunnel">ssh</span>' : ''}${s.production ? '<span class="prod-badge">prod</span>' : ''}${s.readOnly ? '<span class="ro-badge">read-only</span>' : ''}</div>`).join('')
      || '<div class="muted pad">No saved sessions</div>';
  }

  function fill(s) {
    cur = s;
    dirty = !!s && !s.id;
    pwdDirty = sshDirty = false;
    right.replaceChildren(s ? form : empty);
    if (!s) return renderList();
    f.name.value = s.name ?? '';
    f.mode.value = s.mode === 'uri' ? 'uri' : 'fields';
    f.uri.value = s.uri ?? '';
    f.host.value = s.host ?? '';
    f.port.value = s.port ?? 27017;
    f.srv.checked = !!s.srv;
    f.user.value = s.user ?? '';
    f.password.value = '';
    f.password.placeholder = s.hasPassword ? '(saved – type to change)' : '';
    f.savePassword.checked = s.savePassword ?? true;
    f.authDatabase.value = s.authDatabase ?? 'admin';
    f.authMechanism.value = s.authMechanism ?? '';
    f.replicaSet.value = s.replicaSet ?? '';
    f.directConnection.checked = s.directConnection ?? true;
    f.tls.checked = !!s.tls;
    f.tlsInsecure.checked = !!s.tlsInsecure;
    f.readPreference.value = s.readPreference || 'primary';
    f.defaultDatabase.value = s.defaultDatabase ?? '';
    f.databases.value = s.databases ?? '';
    f.connectTimeout.value = s.connectTimeout ?? 15;
    f.readOnly.checked = !!s.readOnly;
    f.production.checked = !!s.production;
    setColor(s.color || '', false);
    f.sshEnabled.checked = !!s.sshEnabled;
    f.sshHost.value = s.sshHost ?? '';
    f.sshPort.value = s.sshPort ?? 22;
    f.sshUser.value = s.sshUser ?? '';
    f.sshAuth.value = s.sshAuth === 'key' ? 'key' : 'password';
    f.sshKeyFile.value = s.sshKeyFile ?? '';
    f.sshSecret.value = '';
    f.comment.value = s.comment ?? '';
    sync();
    renderList();
  }

  function collect() {
    return {
      ...cur,
      name: f.name.value.trim() || 'Unnamed',
      mode: f.mode.value,
      uri: f.uri.value.trim() || null,
      host: f.host.value.trim() || '127.0.0.1',
      port: parseInt(f.port.value, 10) || 27017,
      srv: f.srv.checked,
      user: f.user.value.trim() || null,
      password: pwdDirty ? f.password.value : null,
      savePassword: f.savePassword.checked,
      authDatabase: f.authDatabase.value.trim() || 'admin',
      authMechanism: f.authMechanism.value || null,
      replicaSet: f.replicaSet.value.trim() || null,
      directConnection: f.directConnection.checked,
      tls: f.tls.checked,
      tlsInsecure: f.tlsInsecure.checked,
      readPreference: f.readPreference.value,
      defaultDatabase: f.defaultDatabase.value.trim() || null,
      databases: f.databases.value.trim() || null,
      connectTimeout: parseInt(f.connectTimeout.value, 10) || 15,
      readOnly: f.readOnly.checked,
      production: f.production.checked,
      color: colorVal || null,
      sshEnabled: f.sshEnabled.checked,
      sshHost: f.sshHost.value.trim() || null,
      sshPort: parseInt(f.sshPort.value, 10) || 22,
      sshUser: f.sshUser.value.trim() || null,
      sshAuth: f.sshAuth.value,
      sshKeyFile: f.sshKeyFile.value.trim() || null,
      sshSecret: sshDirty ? f.sshSecret.value : null,
      sshHostKey: cur.sshHostKey ?? null,
      comment: f.comment.value || null,
    };
  }

  async function save() {
    if (!cur) return null;
    if (!dirty) return cur;
    const typed = pwdDirty ? f.password.value : null;
    const typedSsh = sshDirty ? f.sshSecret.value : null;
    const saved = await post('/sessions', collect());
    saved.$typedPassword = typed;
    saved.$typedSsh = typedSsh;
    sessions[sessions.indexOf(cur)] = saved;
    sessions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    cur = saved;
    dirty = pwdDirty = sshDirty = false;
    f.uri.value = saved.uri ?? '';
    f.password.placeholder = saved.hasPassword ? '(saved – type to change)' : '';
    f.password.value = '';
    sync();
    renderList();
    return saved;
  }

  list.addEventListener('mousedown', async e => {
    const it = e.target.closest('.sm-item');
    if (!it) return;
    const s = sessions[+it.dataset.i];
    if (s === cur) return;
    try { await save(); } catch (err) { return alertError(err.message); }
    fill(s);
  });
  let ctxRef;
  list.addEventListener('dblclick', e => { if (e.target.closest('.sm-item')) ctxRef.dialog.querySelector('.btn.primary').click(); });
  list.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = sessions.indexOf(cur) + (e.key === 'ArrowDown' ? 1 : -1);
    if (sessions[i]) save().then(() => fill(sessions[i])).catch(err => alertError(err.message));
  });

  fill(sessions.find(s => s.id === app.state.lastSession) || sessions[0] || null);

  await modal({
    title: 'Session manager',
    width: 800,
    className: 'session-manager',
    body: c => { ctxRef = c; return h('div', { class: 'sm' }, list, right); },
    buttons: [
      { label: 'New', align: 'left', onClick: async () => {
        await save();
        const s = { id: null, name: 'Unnamed', mode: 'fields', host: '127.0.0.1', port: 27017, savePassword: true, authDatabase: 'admin', directConnection: true, readPreference: 'primary', connectTimeout: 15, sshPort: 22, sshAuth: 'password' };
        sessions.push(s);
        fill(s);
        f.name.select();
        return false;
      } },
      { label: 'Save', align: 'left', onClick: async () => { await save(); app.setStatus('Session saved.'); return false; } },
      { label: 'Delete', align: 'left', onClick: async () => {
        if (!cur) return false;
        if (!(await confirmDlg(`Delete session "${cur.name}"?`, { ok: 'Delete', danger: true }))) return false;
        if (cur.id) await del('/sessions/' + cur.id);
        sessions.splice(sessions.indexOf(cur), 1);
        fill(sessions[0] || null);
        return false;
      } },
      { label: 'Test', align: 'left', onClick: async () => {
        if (!cur) return false;
        for (;;) {
          try {
            const r = await post('/test', { profile: collect(), sessionId: cur.id, password: pwdDirty ? f.password.value : null, sshSecret: sshDirty ? f.sshSecret.value : null });
            await modal({ title: 'Connection test', body: `Connection successful${r.ssh ? ' (through the SSH tunnel)' : ''}.\nMongoDB ${r.version}` });
            return false;
          } catch (e) {
            if (e.code !== SSH_HOSTKEY_UNKNOWN) throw e;
            if (!(await confirmHostKey(e.data))) return false;
            cur.sshHostKey = e.data.fingerprint;
            if (cur.id) await post(`/sessions/${cur.id}/hostkey`, { fingerprint: e.data.fingerprint });
            else dirty = true;
            sync();
          }
        }
      } },
      { label: 'Open', primary: true, onClick: async () => {
        if (!cur) return false;
        let pwd = pwdDirty ? f.password.value : cur.$typedPassword ?? null;
        let ssh = sshDirty ? f.sshSecret.value : cur.$typedSsh ?? null;
        const s = await save();
        const hasUser = s.mode === 'uri' ? /^mongodb(\+srv)?:\/\/[^@/]+@/.test(s.uri || '') : !!s.user && s.authMechanism !== 'MONGODB-X509';
        const needPwd = hasUser && !s.savePassword && pwd == null;
        const needSsh = !s.savePassword && s.sshEnabled && ssh == null;
        if (needPwd || needSsh) {
          const r = await passwordPrompt(s, needPwd, needSsh);
          if (!r) return false;
          pwd = r.password ?? pwd;
          ssh = r.sshSecret ?? ssh;
        }
        app.state.lastSession = s.id;
        app.saveStateSoon();
        return (await app.connect(s.id, pwd, ssh)) !== false;
      } },
      { label: 'Cancel', value: null },
    ],
  });
}

/** Asks the user to trust an SSH server's host key on first contact. */
export async function confirmHostKey({ host, port, fingerprint }) {
  return confirmDlg(
    `The authenticity of SSH host ${host}:${port} can't be established.\n\nKey fingerprint:\n${fingerprint}\n\n` +
    'Compare it with the fingerprint shown by the server administrator (e.g. ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). ' +
    'Only continue if they match; ZawMongo will remember this key and refuse to connect if it ever changes.',
    { title: 'Unknown SSH host key', ok: 'Trust and connect', kind: 'warning' });
}

async function passwordPrompt(s, askPassword = true, askSsh = false) {
  const pwd = h('input', { class: 'inp wide', type: 'password' });
  const ssh = h('input', { class: 'inp wide', type: 'password' });
  return modal({
    title: 'Password',
    width: 400,
    body: h('div', { class: 'form' },
      askPassword ? h('label', null, `Password for ${s.user || 'the connection string user'}:`) : null, askPassword ? pwd : null,
      askSsh ? h('label', null, s.sshAuth === 'key' ? 'Passphrase for the SSH key (empty if none):' : `SSH password for ${s.sshUser}@${s.sshHost}:`) : null, askSsh ? ssh : null),
    buttons: [{ label: 'OK', primary: true, onClick: () => ({ password: askPassword ? pwd.value : null, sshSecret: askSsh ? ssh.value : null }) }, { label: 'Cancel', value: null }],
  });
}

// ---------------------------------------------------------------- export / import

/** Exports a collection (optionally only the documents matching a filter) as JSON, NDJSON or CSV. */
export async function exportDialog(app, sid, db, coll, { filter = '', sort = '', projection = '' } = {}) {
  const fmt = h('select', { class: 'inp' }, h('option', { value: 'json' }, 'JSON array'), h('option', { value: 'ndjson' }, 'NDJSON (one document per line, like mongoexport)'), h('option', { value: 'csv' }, 'CSV'));
  fmt.value = app.prefs.exportFormat || 'json';
  const canonical = h('input', { type: 'checkbox', checked: !!app.prefs.exportCanonical });
  const fields = h('input', { class: 'inp wide mono', placeholder: 'CSV columns: name,address.city (empty: from the documents)', spellcheck: false });
  const filt = h('input', { class: 'inp wide mono', value: filter, placeholder: '{ } – all documents', spellcheck: false });
  const limit = h('input', { class: 'inp', type: 'number', min: 0, placeholder: 'all', style: { width: '120px' } });
  const sync = () => { fields.parentElement.style.display = fmt.value === 'csv' ? '' : 'none'; canonical.closest('.frow').style.display = fmt.value === 'csv' ? 'none' : ''; };
  const go = await modal({
    title: `Export ${db}.${coll}`, width: 560,
    body: h('div', { class: 'form2' },
      h('label', { class: 'frow' }, h('span', null, 'Format'), fmt),
      h('label', { class: 'frow' }, h('span', null, 'Filter'), filt),
      h('label', { class: 'frow' }, h('span', null, 'Limit'), limit),
      h('label', { class: 'frow' }, h('span', null, 'Fields'), fields),
      h('label', { class: 'frow', title: 'Canonical Extended JSON keeps every type exactly ({"$numberLong": …}); relaxed is easier to read and is what mongoexport writes by default.' }, h('span', null, 'Types'), h('label', { class: 'chk' }, canonical, ' Canonical Extended JSON'))),
    onOpen: () => { fmt.onchange = sync; sync(); },
    buttons: [{ label: 'Export', primary: true, value: true }, { label: 'Cancel', value: false }],
  });
  if (!go) return;
  app.prefs.exportFormat = fmt.value;
  app.prefs.exportCanonical = canonical.checked;
  app.saveStateSoon();
  const q = { db, coll, format: fmt.value, filter: filt.value, sort, projection, canonical: canonical.checked, fields: fmt.value === 'csv' ? fields.value : '', limit: limit.value || '' };
  if (NATIVE_DIALOGS) {
    try {
      const r = await get(`/s/${sid}/export`, { ...q, toFile: true });
      if (r) app.setStatus(`Exported to ${r.name}.`);
    } catch (e) { app.showError(e); }
    return;
  }
  const a = h('a', { href: urlWithToken(`/s/${sid}/export`, q), download: '' });
  document.body.append(a);
  a.click();
  a.remove();
  app.setStatus(`Exporting ${db}.${coll}…`);
}

/** Imports a JSON, NDJSON or CSV file into a collection (new or existing). */
export async function importDialog(app, sid, db, coll) {
  const file = await pickFile('.json,.ndjson,.jsonl,.csv,.tsv,.txt');
  if (!file) return;
  let up;
  try {
    app.setStatus(`Uploading ${file.name}…`);
    up = await upload(`/import/upload?name=${encodeURIComponent(file.name)}`, file);
  } catch (e) { return app.showError(e); }
  const dbIn = h('input', { class: 'inp wide', value: db || '', spellcheck: false });
  const collIn = h('input', { class: 'inp wide', value: coll || file.name.replace(/\.[^.]+$/, ''), spellcheck: false });
  const format = h('select', { class: 'inp' }, h('option', { value: 'json' }, 'JSON / NDJSON (Extended JSON understood)'), h('option', { value: 'csv' }, 'CSV'));
  format.value = up.format;
  const delim = h('select', { class: 'inp' }, [['auto', 'Detect'], [',', 'Comma'], [';', 'Semicolon'], ['tab', 'Tab'], ['|', 'Pipe']].map(([v, l]) => h('option', { value: v }, l)));
  const typed = h('input', { type: 'checkbox', checked: true });
  const mode = h('select', { class: 'inp' }, [['insert', 'Insert (an existing _id is an error)'], ['upsert', 'Replace documents with the same _id'], ['skip', 'Skip documents whose _id exists']].map(([v, l]) => h('option', { value: v }, l)));
  const drop = h('input', { type: 'checkbox' });
  const stop = h('input', { type: 'checkbox' });
  const preview = h('div', { class: 'imp-preview' });
  const csvRows = [h('label', { class: 'frow' }, h('span', null, 'Delimiter'), delim), h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk', title: 'Numbers, true/false and ISO dates become numbers, booleans and dates; codes with leading zeros stay text. Dotted headers (address.city) become nested fields.' }, typed, ' Detect types'))];
  const refresh = async () => {
    for (const r of csvRows) r.style.display = format.value === 'csv' ? '' : 'none';
    try {
      const p = await post('/import/preview', { fileId: up.id, format: format.value, delimiter: delim.value, typedCsv: typed.checked });
      preview.innerHTML = `<div class="muted">First ${p.docs.length} documents:</div><pre class="doc-json">${highlight(p.docs.map(d => toShell(d, 0)).join('\n'))}</pre>`;
    } catch (e) { preview.innerHTML = `<div class="placeholder error">${esc(e.message)}</div>`; }
  };
  for (const el of [format, delim, typed]) el.addEventListener('change', refresh);
  const result = await modal({
    title: `Import ${file.name} (${fmtBytes(up.size)})`, width: 720,
    body: h('div', { class: 'form2' },
      h('label', { class: 'frow' }, h('span', null, 'Database'), dbIn),
      h('label', { class: 'frow' }, h('span', null, 'Collection'), collIn),
      h('label', { class: 'frow' }, h('span', null, 'Format'), format), ...csvRows,
      h('label', { class: 'frow' }, h('span', null, 'Existing _id'), mode),
      h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk' }, drop, ' Drop the collection first')),
      h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk' }, stop, ' Stop at the first error')),
      preview),
    onOpen: refresh,
    buttons: [{ label: 'Import', primary: true, onClick: async () => {
      if (!dbIn.value.trim() || !collIn.value.trim()) throw new Error('Enter the database and collection.');
      if (drop.checked && !(await confirmDlg(`Drop ${dbIn.value}.${collIn.value} before importing? Its documents are deleted.`, { ok: 'Drop and import', danger: true }))) return false;
      if (!(await app.confirmChange(sid, `Import ${file.name} into ${dbIn.value}.${collIn.value}?`))) return false;
      app.setStatus('Importing…');
      return await post(`/s/${sid}/import/run`, { fileId: up.id, db: dbIn.value.trim(), coll: collIn.value.trim(), format: format.value, delimiter: delim.value, typedCsv: typed.checked, mode: mode.value, dropFirst: drop.checked, stopOnError: stop.checked });
    } }, { label: 'Cancel', value: null }],
  });
  del(`/import/${up.id}`).catch(() => {});
  if (!result) return;
  app.afterChange(sid, dbIn.value.trim());
  await modal({
    title: 'Import finished', width: 520,
    body: h('div', { class: 'form' },
      h('div', null, `${fmtNum(result.read)} read · ${fmtNum(result.inserted)} inserted${result.updated ? ` · ${fmtNum(result.updated)} replaced` : ''}${result.skipped ? ` · ${fmtNum(result.skipped)} skipped` : ''}${result.failed ? ` · ${fmtNum(result.failed)} failed` : ''}`),
      result.errors.length ? h('pre', { class: 'confirm-stmt' }, result.errors.join('\n')) : null),
  });
}

// ---------------------------------------------------------------- create collection

/** Creates a collection (and with it, the database when `db` is null). */
export async function createCollectionDialog(app, sid, db) {
  const dbIn = h('input', { class: 'inp wide', value: db || '', spellcheck: false, placeholder: 'new or existing database' });
  const name = h('input', { class: 'inp wide', spellcheck: false });
  const kind = h('select', { class: 'inp' }, [['plain', 'Collection'], ['capped', 'Capped collection'], ['timeseries', 'Time series'], ['clustered', 'Clustered (by _id)']].map(([v, l]) => h('option', { value: v }, l)));
  const size = h('input', { class: 'inp', type: 'number', min: 4096, placeholder: 'bytes', value: 104857600 });
  const timeField = h('input', { class: 'inp', placeholder: 'timestamp', spellcheck: false });
  const metaField = h('input', { class: 'inp', placeholder: 'metadata (optional)', spellcheck: false });
  const extra = h('input', { class: 'inp wide mono', placeholder: '{ collation: { locale: "en" } } – more options (optional)', spellcheck: false });
  const rows = { capped: h('label', { class: 'frow' }, h('span', null, 'Maximum size'), size), ts: h('div', { class: 'frow' }, h('span', null, 'Time / meta field'), h('div', { class: 'row-gap' }, timeField, metaField)) };
  const sync = () => { rows.capped.style.display = kind.value === 'capped' ? '' : 'none'; rows.ts.style.display = kind.value === 'timeseries' ? '' : 'none'; };
  kind.onchange = sync;
  const r = await modal({
    title: db ? `Create collection in ${db}` : 'Create database', width: 520,
    body: h('div', { class: 'form2' },
      h('label', { class: 'frow' }, h('span', null, 'Database'), dbIn),
      h('label', { class: 'frow' }, h('span', null, 'Collection'), name),
      h('label', { class: 'frow' }, h('span', null, 'Type'), kind), rows.capped, rows.ts,
      h('label', { class: 'frow' }, h('span', null, 'Options'), extra),
      db ? null : h('div', { class: 'muted' }, 'MongoDB creates a database with its first collection.')),
    onOpen: () => { sync(); (db ? name : dbIn).focus(); },
    buttons: [{ label: 'Create', primary: true, onClick: async () => {
      const o = [];
      if (kind.value === 'capped') o.push(`capped: true, size: ${parseInt(size.value, 10) || 104857600}`);
      if (kind.value === 'timeseries') o.push(`timeseries: { timeField: ${JSON.stringify(timeField.value.trim() || 'timestamp')}${metaField.value.trim() ? `, metaField: ${JSON.stringify(metaField.value.trim())}` : ''} }`);
      if (kind.value === 'clustered') o.push('clusteredIndex: { key: { _id: 1 }, unique: true }');
      const more = extra.value.trim().replace(/^\{|\}$/g, '').trim();
      if (more) o.push(more);
      if (!(await app.confirmChange(sid, `Create ${dbIn.value}.${name.value}?`))) return false;
      await post(`/s/${sid}/collections/create`, { db: dbIn.value.trim(), name: name.value.trim(), options: `{ ${o.join(', ')} }` });
      return { db: dbIn.value.trim(), name: name.value.trim() };
    } }, { label: 'Cancel', value: null }],
  });
  if (!r) return;
  await app.afterChange(sid, r.db);
  app.selectCollection(sid, r.db, r.name, 'documents');
}

// ---------------------------------------------------------------- preferences and about

export async function preferencesDialog(app) {
  const p = app.prefs;
  const opt = (pairs, v) => h('select', { class: 'inp' }, pairs.map(([k, l]) => h('option', { value: k, selected: k === String(v) }, l)));
  const pageSize = opt([20, 50, 100, 500, 1000].map(n => [String(n), String(n)]), p.pageSize || 50);
  const maxDocs = opt([100, 1000, 5000, 20000].map(n => [String(n), fmtNum(n)]), p.maxDocs || 1000);
  const theme = opt([['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']], p.theme);
  const zoom = opt(ZOOM_STEPS.map(z => [String(z), z + '%']), p.uiZoom);
  const font = h('input', { class: 'inp', type: 'number', min: 9, max: 24, value: p.editorFontSize });
  const autoClose = h('input', { type: 'checkbox', checked: p.autoCloseBrackets !== false });
  const changesAll = h('input', { type: 'checkbox', checked: p.confirmChangesAll !== false });
  const checkUpdates = h('input', { type: 'checkbox', checked: p.checkUpdates !== false });
  const showWhatsNew = h('input', { type: 'checkbox', checked: p.showWhatsNew !== false });
  const slowMs = opt(SLOW_CHOICES.map(ms => [String(ms), thresholdLabel(ms)]), slowThreshold(p.slowLogMs));
  const ok = await modal({
    title: 'Preferences',
    width: 460,
    body: h('div', { class: 'form2' },
      h('label', { class: 'frow' }, h('span', null, 'Documents per page:'), pageSize),
      h('label', { class: 'frow' }, h('span', null, 'Query results up to:'), maxDocs),
      h('label', { class: 'frow' }, h('span', null, 'Theme:'), theme),
      NATIVE
        ? h('label', { class: 'frow', title: 'Scales the whole interface. Also Ctrl+= / Ctrl+- / Ctrl+0 and Ctrl+wheel.' }, h('span', null, 'Interface zoom:'), zoom)
        : h('div', { class: 'frow' }, h('span', null, 'Interface zoom:'), h('span', { class: 'muted' }, "Use the browser's zoom (Ctrl+= / Ctrl+-).")),
      h('label', { class: 'frow' }, h('span', null, 'Editor font size:'), font),
      h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk' }, autoClose, ' Auto-close brackets and quotes')),
      h('label', { class: 'frow' }, h('span', null, 'Safety:'), h('label', { class: 'chk' }, changesAll, ' Confirm updates and deletes with an empty filter')),
      h('label', { class: 'frow', title: 'Commands that took longer are highlighted in the log, with their duration.' }, h('span', null, 'Mark slow commands:'), slowMs),
      h('label', { class: 'frow' }, h('span', null, 'Updates:'), h('label', { class: 'chk' }, checkUpdates, ' Check for new versions once a day')),
      h('label', { class: 'frow' }, h('span', null, ''), h('label', { class: 'chk' }, showWhatsNew, " Show what's new after an update"))),
    buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
  });
  if (!ok) return;
  Object.assign(p, {
    pageSize: Number(pageSize.value),
    maxDocs: Number(maxDocs.value),
    theme: theme.value,
    uiZoom: Number(zoom.value),
    editorFontSize: Math.max(9, parseInt(font.value, 10) || 13),
    autoCloseBrackets: autoClose.checked,
    confirmChangesAll: changesAll.checked,
    checkUpdates: checkUpdates.checked,
    showWhatsNew: showWhatsNew.checked,
    slowLogMs: Number(slowMs.value),
  });
  app.applyPrefs();
  app.saveStateSoon();
}

export function aboutDialog(version) {
  return modal({
    title: 'About ZawMongo',
    width: 420,
    body: h('div', { class: 'about' },
      h('div', { class: 'about-logo' }, h('img', { src: 'logo.svg', width: 64, height: 64, alt: 'ZawMongo' })),
      h('div', null, h('h2', null, 'ZawMongo'), h('p', null, 'A lightweight MongoDB client.'),
        version ? h('p', null, `Version ${version.version} (${version.rid})${version.signer ? ` · signed by ${version.signer}` : ''}`) : '', h('p', { class: 'muted' }, 'C# / ASP.NET Core backend with a browser-hosted UI. Runs on Windows, Linux and macOS.'))),
  });
}

