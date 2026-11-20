// Tokens and statements of mongosh-style text. Mirrors Shell.cs on the backend: the statement the UI picks to run
// is the one the backend would read.

/** Token types: id, str, num, regex, punct, com (comment), ws (spaces), nl (line break). */
export function lex(s) {
  const out = [];
  let i = 0;
  const afterValue = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k];
      if (t.type === 'ws' || t.type === 'nl' || t.type === 'com') continue;
      return t.type === 'id' || t.type === 'str' || t.type === 'num' || t.type === 'regex' || (t.type === 'punct' && ')]}'.includes(s[t.start]));
    }
    return false;
  };
  while (i < s.length) {
    const c = s[i], start = i;
    if (c === '\n') { i++; out.push({ type: 'nl', start, end: i }); continue; }
    if (/\s/.test(c)) { while (i < s.length && s[i] !== '\n' && /\s/.test(s[i])) i++; out.push({ type: 'ws', start, end: i }); continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out.push({ type: 'com', start, end: i }); continue; }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      i = e < 0 ? s.length : e + 2;
      out.push({ type: 'com', start, end: i });
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < s.length && s[i] !== c && !(c !== '`' && s[i] === '\n')) i += s[i] === '\\' ? 2 : 1;
      i = Math.min(s.length, i + 1);
      out.push({ type: 'str', start, end: i });
      continue;
    }
    if (c === '/' && !afterValue()) {
      i++;
      let cls = false;
      while (i < s.length && s[i] !== '\n' && (s[i] !== '/' || cls)) {
        if (s[i] === '\\') i++;
        else if (s[i] === '[') cls = true;
        else if (s[i] === ']') cls = false;
        i++;
      }
      i = Math.min(s.length, i + 1);
      while (i < s.length && /[a-z]/i.test(s[i])) i++;
      out.push({ type: 'regex', start, end: i });
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1] || '') && !afterValue())) {
      while (i < s.length && (/[\w.]/.test(s[i]) || ((s[i] === '+' || s[i] === '-') && /[eE]/.test(s[i - 1])))) i++;
      out.push({ type: 'num', start, end: i });
      continue;
    }
    if (/[\p{L}_$]/u.test(c)) {
      while (i < s.length && /[\p{L}\p{N}_$]/u.test(s[i])) i++;
      out.push({ type: 'id', start, end: i });
      continue;
    }
    i++;
    out.push({ type: 'punct', start, end: i });
  }
  return out;
}

const CONTINUES_LINE = '.,([{:+-=&|?';

/**
 * Statements of a script: split at semicolons, and at line breaks where the statement is complete (brackets closed,
 * the line doesn't end in an operator and the next one doesn't start with ".sort(…)" and the like).
 */
export function splitStatements(s) {
  const toks = lex(s);
  const res = [];
  let depth = 0, start = null, end = 0;
  const flush = () => {
    if (start != null && end > start) res.push({ text: s.slice(start, end), start, end });
    start = null;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'ws' || t.type === 'com') continue;
    if (t.type === 'nl') {
      if (depth > 0 || start == null) continue;
      if (CONTINUES_LINE.includes(s[end - 1])) continue;
      let n = k + 1;
      while (n < toks.length && (toks[n].type === 'ws' || toks[n].type === 'nl' || toks[n].type === 'com')) n++;
      if (n < toks.length && toks[n].type === 'punct' && '.)]},'.includes(s[toks[n].start])) continue;
      flush();
      continue;
    }
    if (t.type === 'punct') {
      const ch = s[t.start];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === ';' && depth === 0) { flush(); continue; }
    }
    if (start == null) start = t.start;
    end = t.end;
  }
  flush();
  return res;
}

/** The statement at a caret position: the one containing it, else the nearest one before it on the same or an earlier line. */
export function statementAt(s, pos) {
  const all = splitStatements(s);
  if (!all.length) return null;
  const inside = all.find(x => pos >= x.start && pos <= x.end);
  if (inside) return inside;
  const before = all.filter(x => x.end <= pos);
  return before.length ? before[before.length - 1] : all[0];
}

/** What to complete at the caret: collection names after "db.", methods after "db.coll.", operators after "$". */
export function completionContext(s, pos) {
  const before = s.slice(0, pos);
  let m = /(?:^|[^\w$.])db\.([\w$]*)$/.exec(before);
  if (m) return { kind: 'dbmember', prefix: m[1] };
  m = /(?:^|[^\w$.])db\.(?:getCollection\(\s*["']([^"']+)["']\s*\)|\[\s*["']([^"']+)["']\s*\]|([\w$]+(?:\.[\w$]+)*?))\.([\w$]*)$/.exec(before);
  if (m) return { kind: 'method', coll: m[1] ?? m[2] ?? m[3], prefix: m[4] };
  m = /\)\s*\.([\w$]*)$/.exec(before);
  if (m) return { kind: 'cursor', prefix: m[1] };
  m = /(["']?)(\$[\w]*)$/.exec(before);
  if (m) return { kind: 'operator', prefix: m[2], quoted: !!m[1] };
  m = /(?:^|[^\w$.])([A-Za-z_][\w]*)$/.exec(before);
  if (m) return { kind: 'word', prefix: m[1] };
  return null;
}
