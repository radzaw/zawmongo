// explain() output made readable: the totals, what to look at first (collection scans, in-memory sorts, many
// documents examined per one returned), and the winning plan as a tree of stages.
import { h, fmtNum } from './util.js';
import { icon } from './icons.js';
import { toShell, summary } from './ejson.js';
import { highlight } from './editor.js';

const num = v => (v == null ? null : typeof v === 'object' ? Number(v.$numberInt ?? v.$numberLong ?? v.$numberDouble ?? v.$numberDecimal) : Number(v));

/** The parts of an explain reply this view uses, from find/count/distinct, aggregate, sharded or SBE layouts. */
export function analyzeExplain(x) {
  let qp = x.queryPlanner, es = x.executionStats;
  const pipeline = [];
  if (!qp && Array.isArray(x.stages)) {
    for (const s of x.stages) {
      const name = Object.keys(s).find(k => k.startsWith('$'));
      if (name === '$cursor') { qp = s.$cursor.queryPlanner; es = s.$cursor.executionStats; }
      else pipeline.push({ name, returned: num(s.nReturned), ms: num(s.executionTimeMillisEstimate), spec: s[name] });
    }
  }
  if (!qp && x.shards) {
    const first = Object.values(x.shards)[0];
    qp = first?.queryPlanner ?? first?.stages?.[0]?.$cursor?.queryPlanner;
    es = first?.executionStats ?? first?.stages?.[0]?.$cursor?.executionStats;
  }
  const wp = qp?.winningPlan;
  const plan = wp?.queryPlan ?? wp; // SBE: the query plan sits beside the slot-based plan
  // Classic plans carry per-stage counts in executionStages; SBE stages are a different tree, so totals only then.
  const stages = es?.executionStages && !wp?.queryPlan ? es.executionStages : null;
  const findings = [];
  const walk = (n, f) => { if (!n) return; f(n); walk(n.inputStage, f); (n.inputStages || []).forEach(c => walk(c, f)); walk(n.outerStage, f); walk(n.innerStage, f); };
  const names = [];
  walk(plan, n => names.push(n.stage));
  const totals = es ? { returned: num(es.nReturned), ms: num(es.executionTimeMillis), keys: num(es.totalKeysExamined), docs: num(es.totalDocsExamined) } : null;
  if (names.includes('COLLSCAN')) findings.push({ level: 'warning', text: 'Collection scan: no index is used, every document is read.', hint: 'An index on the fields the filter compares for equality (then the sort, then ranges) avoids it.' });
  if (names.includes('SORT')) findings.push({ level: 'warning', text: 'In-memory sort: the results are sorted after reading them.', hint: 'An index whose key order matches the sort returns them already sorted.' });
  if (totals && totals.returned != null && totals.docs > 0) {
    const ratio = totals.docs / Math.max(1, totals.returned);
    if (ratio >= 10 && totals.docs >= 100) findings.push({ level: 'warning', text: `${fmtNum(totals.docs)} documents examined to return ${fmtNum(totals.returned)} (${fmtNum(Math.round(ratio))} per result).`, hint: 'The filter is not selective in the index used; a more specific (compound) index helps.' });
  }
  if (names.includes('IXSCAN') && names.includes('FETCH') && totals?.keys > 0 && totals.docs > totals.returned * 2 && totals.returned != null)
    findings.push({ level: 'note', text: 'Part of the filter is applied after fetching documents (FETCH with a filter).', hint: 'Adding the remaining filter fields to the index lets the index scan reject them.' });
  if (!names.includes('COLLSCAN') && !names.includes('SORT') && totals && totals.keys === 0 && totals.docs === 0 && totals.returned === 0) findings.push({ level: 'ok', text: 'Nothing had to be read.' });
  if (names.includes('IXSCAN') && totals && totals.docs === 0 && totals.returned > 0) findings.push({ level: 'ok', text: 'Covered query: answered from the index alone.' });
  if (names.includes('EOF')) findings.push({ level: 'note', text: 'EOF: the collection doesn\'t exist or the filter can never match.' });
  return {
    namespace: qp?.namespace, indexFilterSet: qp?.indexFilterSet, parsedQuery: qp?.parsedQuery, plan, stages, rejected: qp?.rejectedPlans?.length ?? 0,
    totals, pipeline, findings, engine: wp?.queryPlan ? 'sbe' : 'classic', summary: [...new Set(names)].join(' → '),
  };
}

function stageCard(n, exec) {
  const props = [];
  if (n.indexName) props.push(['Index', n.indexName + (n.keyPattern ? ' ' + toShell(n.keyPattern, 0) : '')]);
  if (n.direction && n.stage === 'IXSCAN') props.push(['Direction', n.direction]);
  if (n.indexBounds) props.push(['Bounds', Object.entries(n.indexBounds).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('; ')]);
  if (n.filter) props.push(['Filter', toShell(n.filter, 0)]);
  if (n.sortPattern) props.push(['Sort', toShell(n.sortPattern, 0)]);
  if (n.limitAmount != null) props.push(['Limit', summary(n.limitAmount)]);
  if (n.skipAmount != null) props.push(['Skip', summary(n.skipAmount)]);
  if (n.transformBy) props.push(['Projection', toShell(n.transformBy, 0)]);
  const counts = exec ? [['returned', exec.nReturned], ['keys', exec.keysExamined], ['docs', exec.docsExamined], ['ms', exec.executionTimeMillisEstimate]].filter(([, v]) => v != null) : [];
  const bad = n.stage === 'COLLSCAN' || n.stage === 'SORT';
  const kids = [];
  const pairs = [[n.inputStage, exec?.inputStage], ...(n.inputStages || []).map((c, i) => [c, exec?.inputStages?.[i]]), [n.outerStage, exec?.outerStage], [n.innerStage, exec?.innerStage]];
  for (const [c, e] of pairs) if (c) kids.push(stageCard(c, e));
  return h('div', { class: 'xp-node' },
    h('div', { class: 'xp-card' + (bad ? ' bad' : '') },
      h('div', { class: 'xp-head' }, h('b', null, n.stage), counts.map(([k, v]) => h('span', { class: 'xp-badge' }, `${fmtNum(num(v))} ${k}`))),
      props.length ? h('div', { class: 'xp-props' }, props.map(([k, v]) => h('div', null, h('span', { class: 'muted' }, k + ': '), h('span', { class: 'mono' }, v)))) : null),
    kids.length ? h('div', { class: 'xp-children' }, kids) : null);
}

/** The explain view: tiles, findings, plan tree, and the raw reply. */
export function renderExplain(raw) {
  const a = analyzeExplain(raw);
  const tiles = a.totals ? [
    ['Returned', a.totals.returned], ['Keys examined', a.totals.keys], ['Documents examined', a.totals.docs], ['Time', a.totals.ms != null ? a.totals.ms + ' ms' : null],
  ] : [];
  let showRaw = false;
  const rawEl = h('pre', { class: 'xp-json', html: highlight(toShell(raw, 2)) });
  rawEl.style.display = 'none';
  const toggle = h('button', { class: 'btn', onclick: () => { showRaw = !showRaw; rawEl.style.display = showRaw ? '' : 'none'; toggle.textContent = showRaw ? 'Hide raw output' : 'Show raw output'; } }, 'Show raw output');
  return h('div', { class: 'xp' },
    h('div', { class: 'xp-body' },
      h('div', { class: 'xp-bar' },
        h('b', null, a.summary || 'Plan'),
        a.namespace ? h('span', { class: 'muted' }, a.namespace) : null,
        a.rejected ? h('span', { class: 'muted' }, `${a.rejected} rejected plan${a.rejected === 1 ? '' : 's'}`) : null,
        a.engine === 'sbe' ? h('span', { class: 'xp-badge', title: 'Slot-based execution engine: per-stage counts are not shown' }, 'SBE') : null,
        h('span', { class: 'grow' }), toggle),
      tiles.length ? h('div', { class: 'mon-tiles' }, tiles.map(([l, v]) => h('div', { class: 'mon-tile' }, h('div', { class: 'mon-tile-label' }, l), h('div', { class: 'mon-tile-value' }, v == null ? '–' : typeof v === 'number' ? fmtNum(v) : v)))) : h('div', { class: 'muted' }, 'Run explain("executionStats") to see how many keys and documents were read.'),
      a.findings.length ? h('div', { class: 'xp-issues' }, a.findings.map(f => h('div', { class: 'xp-issue ' + f.level },
        h('span', { html: icon(f.level === 'ok' ? 'check' : f.level === 'note' ? 'info' : 'warning') }),
        h('div', null, h('div', null, f.text), f.hint ? h('div', { class: 'muted' }, f.hint) : null)))) : null,
      a.parsedQuery && Object.keys(a.parsedQuery).length ? h('div', { class: 'xp-stmt' }, h('span', { class: 'muted' }, 'Parsed query: '), h('span', { class: 'mono', html: highlight(toShell(a.parsedQuery, 0)).replace(/\n$/, '') })) : null,
      a.plan ? h('div', { class: 'xp-tree' }, stageCard(a.plan, a.stages)) : h('div', { class: 'muted' }, 'No query plan in this output.'),
      a.pipeline.length ? h('div', { class: 'xp-steps' }, h('b', null, 'Pipeline stages after the query'), a.pipeline.map(p => h('div', { class: 'xp-step' }, h('span', { class: 'mono' }, p.name), p.returned != null ? h('span', { class: 'xp-badge' }, `${fmtNum(p.returned)} returned`) : null, p.ms != null ? h('span', { class: 'xp-badge' }, `${p.ms} ms`) : null, h('span', { class: 'mono muted' }, ' ' + toShell(p.spec, 0).slice(0, 200))))) : null,
      rawEl));
}

