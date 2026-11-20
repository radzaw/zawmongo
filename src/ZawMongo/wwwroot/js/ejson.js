// BSON values as the backend sends them (canonical Extended JSON: {"$oid": …}, {"$numberLong": …}) turned into
// shell syntax for editing, short summaries for grid cells, and type names. Text the user edits goes back in shell
// syntax, which the backend parses exactly: NumberLong stays a long, 1.0 a double, ISODate a date.

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The type of a value in BSON terms ("int", "objectId", "date" …); "missing" for undefined. */
export function typeOf(v) {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (Array.isArray(v)) return 'array';
  const k = Object.keys(v);
  if (k.length === 1) {
    switch (k[0]) {
      case '$numberInt': return 'int';
      case '$numberLong': return 'long';
      case '$numberDouble': return 'double';
      case '$numberDecimal': return 'decimal';
      case '$oid': return 'objectId';
      case '$date': return 'date';
      case '$binary': return v.$binary?.subType === '04' || v.$binary?.subType === '03' ? 'uuid' : 'binData';
      case '$regularExpression': return 'regex';
      case '$timestamp': return 'timestamp';
      case '$minKey': return 'minKey';
      case '$maxKey': return 'maxKey';
      case '$undefined': return 'undefined';
      case '$symbol': return 'symbol';
      case '$code': return 'javascript';
    }
  }
  if (k.length === 2 && k.includes('$code') && k.includes('$scope')) return 'javascript';
  if (k.length === 2 && k[0] === '$dbPointer') return 'dbPointer';
  return 'object';
}

/** Is the value a scalar (anything but a document or an array)? */
export const isScalar = v => !['object', 'array'].includes(typeOf(v));

/** Milliseconds since the epoch of a date value. */
export function dateMs(v) {
  const d = v.$date;
  if (typeof d === 'object' && d) return Number(d.$numberLong);
  if (typeof d === 'string') return Date.parse(d);
  return Number(d);
}

/** "2024-01-02T03:04:05.000Z", or null outside the range JavaScript dates cover. */
export function isoDate(ms) {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function hexOfBase64(b64) {
  const bin = atob(b64);
  let s = '';
  for (let i = 0; i < bin.length; i++) s += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return s;
}

/** A UUID's text form, from binary subtype 4 (or 3, the legacy one). */
export function uuidText(v) {
  const h = hexOfBase64(v.$binary.base64);
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : h;
}

/** A double as shell text: always with a decimal point or exponent, so it stays a double when read back. */
function doubleText(s) {
  if (s === 'Infinity' || s === '-Infinity' || s === 'NaN') return s;
  const n = Number(s);
  if (!isFinite(n)) return s;
  const t = String(n);
  return /[.eE]/.test(t) ? t : t + '.0';
}

const key = k => (IDENT.test(k) ? k : JSON.stringify(k));

/** A scalar in shell syntax (documents and arrays: see toShell). */
export function scalarShell(v) {
  switch (typeOf(v)) {
    case 'string': return JSON.stringify(v);
    case 'null': return 'null';
    case 'bool': return String(v);
    case 'int': return typeof v === 'number' ? String(v) : v.$numberInt;
    case 'long': return `NumberLong(${/^-?\d{1,15}$/.test(v.$numberLong) ? v.$numberLong : JSON.stringify(v.$numberLong)})`;
    case 'double': return typeof v === 'number' ? doubleText(String(v)) : doubleText(v.$numberDouble);
    case 'decimal': return `NumberDecimal(${JSON.stringify(v.$numberDecimal)})`;
    case 'objectId': return `ObjectId(${JSON.stringify(v.$oid)})`;
    case 'date': {
      const ms = dateMs(v);
      const iso = isoDate(ms);
      return iso ? `ISODate(${JSON.stringify(iso)})` : `new Date(${ms})`;
    }
    case 'uuid': return v.$binary.subType === '04' ? `UUID(${JSON.stringify(uuidText(v))})` : `BinData(3, ${JSON.stringify(v.$binary.base64)})`;
    case 'binData': return `BinData(${parseInt(v.$binary.subType, 16)}, ${JSON.stringify(v.$binary.base64)})`;
    case 'regex': {
      const p = v.$regularExpression.pattern.replace(/(^|[^\\])\//g, '$1\\/');
      return `/${p}/${v.$regularExpression.options}`;
    }
    case 'timestamp': return `Timestamp(${v.$timestamp.t}, ${v.$timestamp.i})`;
    case 'minKey': return 'MinKey';
    case 'maxKey': return 'MaxKey';
    case 'undefined': return 'undefined';
    default: return JSON.stringify(v); // $symbol, $code, $dbPointer: Extended JSON reads back as such
  }
}

/**
 * A value in shell syntax. `indent`: spaces per level for a multi-line layout (documents and arrays that fit in
 * `width` characters stay on one line); 0 writes everything on one line.
 */
export function toShell(v, indent = 2, width = 72, level = 0) {
  const t = typeOf(v);
  if (t !== 'object' && t !== 'array') return scalarShell(v);
  const items = t === 'array' ? v.map(x => toShell(x, indent, width, level + 1)) : Object.entries(v).map(([k, x]) => `${key(k)}: ${toShell(x, indent, width, level + 1)}`);
  const [open, close] = t === 'array' ? ['[', ']'] : ['{', '}'];
  if (!items.length) return open + close;
  const flat = t === 'array' ? `[${items.join(', ')}]` : `{ ${items.join(', ')} }`;
  if (!indent || (!flat.includes('\n') && flat.length + level * indent <= width)) return flat;
  const pad = ' '.repeat((level + 1) * indent);
  return `${open}\n${items.map(i => pad + i).join(',\n')}\n${' '.repeat(level * indent)}${close}`;
}

/** Short text for a grid cell or tree row. */
export function summary(v, max = 300) {
  switch (typeOf(v)) {
    case 'missing': return '';
    case 'string': return v.length > max ? v.slice(0, max) + '…' : v;
    case 'int': return typeof v === 'number' ? String(v) : v.$numberInt;
    case 'long': return v.$numberLong;
    case 'double': return typeof v === 'number' ? String(v) : String(Number(v.$numberDouble));
    case 'decimal': return v.$numberDecimal;
    case 'objectId': return v.$oid;
    case 'date': return isoDate(dateMs(v)) ?? String(dateMs(v));
    case 'uuid': return uuidText(v);
    case 'binData': return `BinData(${parseInt(v.$binary.subType, 16)}, ${Math.floor(v.$binary.base64.length * 3 / 4)} bytes)`;
    case 'object': {
      const n = Object.keys(v).length;
      return `{ ${n} field${n === 1 ? '' : 's'} }`;
    }
    case 'array': return `[ ${v.length} item${v.length === 1 ? '' : 's'} ]`;
    default: return scalarShell(v);
  }
}

/** The grid's color class for a type (k-int, k-date … in the stylesheet). */
export function kindOf(type) {
  switch (type) {
    case 'int': case 'long': return 'int';
    case 'double': case 'decimal': return 'real';
    case 'date': case 'timestamp': return 'date';
    case 'objectId': case 'uuid': case 'binData': return 'binary';
    case 'object': case 'array': return 'spatial';
    default: return 'text';
  }
}

/** Top-level field names of documents in first-seen order, _id first. */
export function columnsOf(docs, limit = 500) {
  const seen = new Set();
  const out = [];
  for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); out.push(k); }
  const i = out.indexOf('_id');
  if (i > 0) { out.splice(i, 1); out.unshift('_id'); }
  return out.slice(0, limit);
}

/** The most common type of a field over some documents (for the column's color and editor). */
export function columnType(docs, name) {
  const counts = new Map();
  for (const d of docs.slice(0, 200)) {
    const t = typeOf(d[name]);
    if (t !== 'missing' && t !== 'null') counts.set(t, (counts.get(t) || 0) + 1);
  }
  let best = 'string', n = -1;
  for (const [t, c] of counts) if (c > n) { best = t; n = c; }
  return best;
}

/** Text to edit a field in a grid cell: strings as they are, other scalars in shell syntax. */
export const editText = v => (typeof v === 'string' ? v : v === undefined ? '' : scalarShell(v));

/**
 * The shell-syntax value to send for a grid cell edit. A string field stays a string whatever is typed; other fields
 * are read as shell syntax (so 42 stays a number and ISODate(…) a date). `null` sends null.
 */
export function editValue(orig, text) {
  if (typeof orig === 'string' || orig === undefined && !/^(-?\d|true$|false$|null$|ObjectId\(|ISODate\(|NumberLong\(|NumberDecimal\(|\[|\{|")/.test(text.trim())) return JSON.stringify(text);
  return text;
}

/** A value at a dotted path ("a.b.0"); undefined when missing. */
export function getPath(doc, path) {
  let cur = doc;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Documents as a JSON text file: relaxed Extended JSON (what mongoexport writes and mongoimport reads). */
export function toRelaxedJson(v, indent = 2) {
  const relax = x => {
    const t = typeOf(x);
    if (t === 'int') return typeof x === 'number' ? x : Number(x.$numberInt);
    if (t === 'long') return Math.abs(Number(x.$numberLong)) <= Number.MAX_SAFE_INTEGER ? Number(x.$numberLong) : x;
    if (t === 'double') {
      const n = typeof x === 'number' ? x : Number(x.$numberDouble);
      return isFinite(n) ? n : x;
    }
    if (t === 'date') {
      // Relaxed Extended JSON writes ISO text only for the years 1970 to 9999.
      const ms = dateMs(x);
      return ms >= 0 && ms < 253402300800000 ? { $date: isoDate(ms) } : x;
    }
    if (t === 'array') return x.map(relax);
    if (t === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, relax(y)]));
    return x;
  };
  return JSON.stringify(relax(v), null, indent);
}
