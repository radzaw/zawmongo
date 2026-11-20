// Code editor for shell statements and documents: a textarea over a highlighted copy of its text, with line
// numbers, autocompletion (collections, methods, operators), auto-indent, bracket closing and line comments.
import { h, esc } from './util.js';
import { lex, completionContext } from './shelllex.js';

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'new', 'use', 'show', 'db']);
const CONSTRUCTORS = new Set(['ObjectId', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'UUID', 'BinData', 'Timestamp', 'MinKey', 'MaxKey', 'Long', 'Int32', 'Double', 'Decimal128']);

export const COLLECTION_METHODS = [
  ['find', '(filter, projection)'], ['findOne', '(filter, projection)'], ['aggregate', '([stages], options)'], ['countDocuments', '(filter)'],
  ['estimatedDocumentCount', '()'], ['distinct', '(field, filter)'], ['insertOne', '(doc)'], ['insertMany', '([docs])'],
  ['updateOne', '(filter, update, options)'], ['updateMany', '(filter, update, options)'], ['replaceOne', '(filter, doc, options)'],
  ['deleteOne', '(filter)'], ['deleteMany', '(filter)'], ['findOneAndUpdate', '(filter, update, options)'], ['findOneAndReplace', '(filter, doc, options)'],
  ['findOneAndDelete', '(filter, options)'], ['createIndex', '(keys, options)'], ['dropIndex', '(name)'], ['getIndexes', '()'],
  ['drop', '()'], ['renameCollection', '(newName)'], ['stats', '()'], ['explain', '(verbosity)'],
];
export const CURSOR_METHODS = [['sort', '({ field: 1 })'], ['limit', '(n)'], ['skip', '(n)'], ['projection', '({ field: 1 })'], ['hint', '(index)'], ['collation', '({ locale })'],
  ['maxTimeMS', '(ms)'], ['comment', '(text)'], ['count', '()'], ['explain', '(verbosity)'], ['toArray', '()'], ['allowDiskUse', '()']];
export const DB_METHODS = [['getCollection', '(name)'], ['getSiblingDB', '(name)'], ['runCommand', '({ … })'], ['adminCommand', '({ … })'], ['getCollectionNames', '()'],
  ['getCollectionInfos', '(filter)'], ['stats', '()'], ['createCollection', '(name, options)'], ['createView', '(name, source, [pipeline])'], ['dropDatabase', '()'],
  ['serverStatus', '()'], ['currentOp', '(filter)'], ['killOp', '(opid)'], ['getUsers', '()'], ['createUser', '({ user, pwd, roles })'], ['aggregate', '([stages])'],
  ['getProfilingStatus', '()'], ['setProfilingLevel', '(level)'], ['version', '()'], ['hello', '()']];
export const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options', '$expr', '$elemMatch', '$size', '$all', '$text', '$search', '$mod', '$where', '$jsonSchema',
  '$set', '$unset', '$inc', '$mul', '$rename', '$min', '$max', '$push', '$pull', '$pullAll', '$addToSet', '$pop', '$each', '$position', '$slice', '$sort', '$currentDate', '$setOnInsert',
  '$match', '$group', '$project', '$addFields', '$sort', '$limit', '$skip', '$unwind', '$lookup', '$facet', '$bucket', '$bucketAuto', '$count', '$sortByCount', '$replaceRoot', '$replaceWith', '$sample', '$out', '$merge', '$unionWith', '$graphLookup', '$setWindowFields', '$densify', '$fill', '$documents', '$collStats', '$indexStats', '$redact', '$geoNear',
  '$sum', '$avg', '$first', '$last', '$push', '$addToSet', '$min', '$max', '$cond', '$ifNull', '$switch', '$concat', '$substr', '$toLower', '$toUpper', '$dateToString', '$year', '$month', '$dayOfMonth', '$toString', '$toInt', '$toDate', '$arrayElemAt', '$filter', '$map', '$reduce', '$size', '$mergeObjects', '$objectToArray', '$literal',
];
const SNIPPET_WORDS = ['ObjectId()', 'ISODate()', 'NumberLong()', 'NumberDecimal()', 'UUID()', 'db', 'use', 'show dbs', 'show collections', 'true', 'false', 'null'];

/** Highlighted HTML of shell text. */
export function highlight(text) {
  const toks = lex(text);
  let out = '';
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const s = text.slice(t.start, t.end);
    let cls = null;
    if (t.type === 'str' || t.type === 'regex') cls = /^["']\$/.test(s) ? 't-var' : 't-str';
    else if (t.type === 'num') cls = 't-num';
    else if (t.type === 'com') cls = 't-com';
    else if (t.type === 'id') {
      let n = k + 1;
      while (n < toks.length && toks[n].type === 'ws') n++;
      const next = toks[n] ? text[toks[n].start] : '';
      if (s.startsWith('$')) cls = 't-var';
      else if (LITERALS.has(s)) cls = 't-kw';
      else if (CONSTRUCTORS.has(s)) cls = 't-fn';
      else if (next === '(') cls = 't-fn';
      else if (next === ':') cls = 't-id';
    }
    out += cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s);
  }
  return out + '\n';
}

export class CodeEditor {
  /** Typing an opening bracket or quote adds the closing one (Preferences; the same for every editor). */
  static autoClose = true;

  /** `collections`: () => names for completion after "db.". `onRun`: Ctrl+Enter. */
  constructor({ value = '', collections = null, onChange = null, onRun = null, readOnly = false, placeholder = '' } = {}) {
    this.collections = collections;
    this.onChange = onChange;
    this.onRun = onRun;
    this.gutterInner = h('div', { class: 'sqled-lines' });
    this.gutter = h('div', { class: 'sqled-gutter' }, this.gutterInner);
    this.code = h('code');
    this.pre = h('pre', { class: 'sqled-hl', 'aria-hidden': 'true' }, this.code);
    this.ta = h('textarea', { class: 'sqled-ta', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', wrap: 'off', placeholder });
    this.main = h('div', { class: 'sqled-main' }, this.pre, this.ta);
    this.el = h('div', { class: 'sqled' }, this.gutter, this.main);
    this.ta.value = value;
    this.ta.readOnly = readOnly;
    this.lines = 0;
    this.ta.addEventListener('input', () => {
      this.scheduleUpdate();
      this.onChange?.();
      if (this.popup) this.refreshCompletion();
      else if (/[.$]/.test(this.ta.value[this.ta.selectionStart - 1] ?? '')) this.openCompletion(false);
    });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', e => this.onKey(e));
    this.ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.ta) this.closeCompletion(); }, 150));
    this.ta.addEventListener('mousedown', () => this.closeCompletion());
    new ResizeObserver(() => this.syncScroll()).observe(this.ta);
    this.update();
  }

  get value() { return this.ta.value; }
  set value(v) {
    this.ta.value = v;
    this.update();
  }

  focus() { this.ta.focus({ preventScroll: true }); }

  selection() {
    const { selectionStart: start, selectionEnd: end, value } = this.ta;
    return { start, end, text: value.slice(start, end) };
  }

  selectRange(start, end) {
    this.ta.focus();
    this.ta.setSelectionRange(start, end);
    const line = this.ta.value.slice(0, start).split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 19;
    const top = line * lh;
    if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - lh * 2) this.ta.scrollTop = Math.max(0, top - this.ta.clientHeight / 3);
  }

  /** Replaces a range keeping the browser's undo history. */
  replaceRange(start, end, text, caret = start + text.length) {
    this.ta.focus();
    this.ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      this.ta.setRangeText(text, start, end, 'end');
      this.ta.dispatchEvent(new Event('input'));
    }
    this.ta.setSelectionRange(caret, caret);
  }

  insert(text) {
    const { start, end } = this.selection();
    this.replaceRange(start, end, text);
  }

  scheduleUpdate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); });
  }

  update() {
    const v = this.ta.value;
    this.code.innerHTML = highlight(v);
    const n = v.split('\n').length;
    if (n !== this.lines) {
      this.lines = n;
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      this.gutterInner.textContent = s;
    }
    this.syncScroll();
  }

  syncScroll() {
    this.pre.scrollTop = this.ta.scrollTop;
    this.pre.scrollLeft = this.ta.scrollLeft;
    this.gutterInner.style.transform = `translateY(${-this.ta.scrollTop}px)`;
  }

  lineStart(pos) { return this.ta.value.lastIndexOf('\n', pos - 1) + 1; }

  onKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.popup && this.popupKey(e)) return;
    const ta = this.ta;
    const v = ta.value;
    const { start, end } = this.selection();
    if (ctrl && e.key === ' ') { e.preventDefault(); this.openCompletion(true); return; }
    if (ctrl && e.key === 'Enter') { e.preventDefault(); this.onRun?.(); return; }
    if (ctrl && e.key === '/') { e.preventDefault(); this.toggleComment(); return; }
    if (e.key === 'Tab' && !ctrl && !e.altKey) {
      e.preventDefault();
      if (start === end && !e.shiftKey) { this.insert('  '); return; }
      const ls = this.lineStart(start);
      const block = v.slice(ls, end);
      const out = e.shiftKey ? block.replace(/^( {1,2}|\t)/gm, '') : block.replace(/^/gm, '  ');
      this.replaceRange(ls, end, out, ls + out.length);
      ta.setSelectionRange(ls, ls + out.length);
      return;
    }
    if (e.key === 'Enter' && !ctrl && !e.shiftKey && !e.altKey) {
      // Keep the indent; one more level after an opening bracket, and the closer on its own line.
      e.preventDefault();
      const ls = this.lineStart(start);
      const indent = /^[ \t]*/.exec(v.slice(ls, start))[0];
      const prev = v[start - 1], next = v[end];
      if ('{[('.includes(prev) && prev) {
        const inner = indent + '  ';
        if (next && '}])'.includes(next)) this.replaceRange(start, end, '\n' + inner + '\n' + indent, start + 1 + inner.length);
        else this.replaceRange(start, end, '\n' + inner);
      } else this.replaceRange(start, end, '\n' + indent);
      return;
    }
    if (CodeEditor.autoClose && !ctrl && !e.altKey) {
      const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
      if (pairs[e.key] && !ta.readOnly) {
        const quote = e.key === '"' || e.key === "'";
        if (quote && v[start] === e.key && start === end) { e.preventDefault(); ta.setSelectionRange(start + 1, start + 1); return; }
        if (quote && start === end && /[\w$]/.test(v[start - 1] ?? '')) return;
        if (start === end && v[start] && /[\w$]/.test(v[start])) return;
        e.preventDefault();
        const sel = v.slice(start, end);
        this.replaceRange(start, end, e.key + sel + pairs[e.key], start + 1 + sel.length);
        if (sel) ta.setSelectionRange(start + 1, start + 1 + sel.length);
        return;
      }
      if (')]}'.includes(e.key) && e.key && start === end && v[start] === e.key) { e.preventDefault(); ta.setSelectionRange(start + 1, start + 1); return; }
      if (e.key === 'Backspace' && start === end && start > 0 && pairs[v[start - 1]] === v[start] && v[start]) {
        e.preventDefault();
        this.replaceRange(start - 1, start + 1, '');
      }
    }
  }

  toggleComment() {
    const v = this.ta.value;
    const { start, end } = this.selection();
    const ls = this.lineStart(start);
    let le = v.indexOf('\n', end > start && v[end - 1] === '\n' ? end - 1 : end);
    if (le < 0) le = v.length;
    const lines = v.slice(ls, le).split('\n');
    const all = lines.every(l => !l.trim() || /^\s*\/\//.test(l));
    const out = lines.map(l => (all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1// ') : l)).join('\n');
    this.replaceRange(ls, le, out, ls + out.length);
    this.ta.setSelectionRange(ls, ls + out.length);
  }

  // ---------- completion ----------

  candidates() {
    const v = this.ta.value, pos = this.ta.selectionStart;
    const cx = completionContext(v, pos);
    if (!cx) return null;
    const m = (list, kind) => list.map(([label, hint]) => ({ label, hint, kind }));
    let items;
    if (cx.kind === 'dbmember') items = [...(this.collections?.() || []).map(n => ({ label: n, hint: 'collection', kind: 'coll', insert: /^[A-Za-z_$][\w$]*$/.test(n) ? n : `getCollection(${JSON.stringify(n)})` })), ...m(DB_METHODS, 'method')];
    else if (cx.kind === 'method') items = m(COLLECTION_METHODS, 'method');
    else if (cx.kind === 'cursor') items = m(CURSOR_METHODS, 'method');
    else if (cx.kind === 'operator') items = [...new Set(OPERATORS)].map(o => ({ label: o, hint: '', kind: 'op' }));
    else items = SNIPPET_WORDS.map(w => ({ label: w, hint: '', kind: 'word' }));
    const p = cx.prefix.toLowerCase();
    const filtered = items.filter(i => i.label.toLowerCase().startsWith(p) && i.label !== cx.prefix);
    return { cx, items: filtered.slice(0, 200) };
  }

  openCompletion(explicit) {
    const c = this.candidates();
    if (!c || !c.items.length || (!explicit && c.cx.kind === 'word')) return this.closeCompletion();
    this.ctx = c.cx;
    this.items = c.items;
    this.sel = 0;
    if (!this.popup) {
      this.popup = h('div', { class: 'sqled-pop' });
      this.popup.addEventListener('mousedown', e => {
        e.preventDefault();
        const el = e.target.closest('.pi');
        if (el) { this.sel = +el.dataset.i; this.accept(); }
      });
      this.main.append(this.popup);
    }
    this.renderPopup();
  }

  refreshCompletion() { this.openCompletion(true); }

  renderPopup() {
    this.popup.innerHTML = this.items.map((it, i) => `<div class="pi${i === this.sel ? ' sel' : ''}" data-i="${i}"><span class="pl">${esc(it.label)}</span><span class="pk">${esc(it.hint || '')}</span></div>`).join('');
    // Place it under the caret: measure with a mirror of the text up to the caret.
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    const cs = getComputedStyle(this.ta);
    const lh = parseFloat(cs.lineHeight) || 19;
    const cw = this.charWidth ??= (() => { const c = document.createElement('canvas').getContext('2d'); c.font = `${cs.fontSize} ${cs.fontFamily}`; return c.measureText('0').width; })();
    this.popup.style.left = Math.min(Math.max(0, 10 + col * cw - this.ta.scrollLeft), Math.max(0, this.main.clientWidth - 250)) + 'px';
    this.popup.style.top = (6 + (line + 1) * lh - this.ta.scrollTop) + 'px';
    this.popup.children[this.sel]?.scrollIntoView({ block: 'nearest' });
  }

  popupKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
      this.renderPopup();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.accept(); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeCompletion(); return true; }
    return false;
  }

  accept() {
    const it = this.items[this.sel];
    if (!it) return this.closeCompletion();
    const pos = this.ta.selectionStart;
    const prefix = this.ctx.prefix;
    let text = it.insert ?? it.label;
    if (it.kind === 'method' && !it.label.includes('(')) text += '()';
    this.closeCompletion();
    this.replaceRange(pos - prefix.length, pos, text, it.kind === 'method' ? pos - prefix.length + text.length - 1 : undefined);
  }

  closeCompletion() {
    this.popup?.remove();
    this.popup = null;
  }
}
