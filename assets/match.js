/* Year-to-year matching: which fields of an earlier year's form are the same as this year's?
 *
 * The internal PDF field names (f1_47[0] …) are renumbered by the IRS whenever a line is
 * added, so a name alone proves nothing. Fields are paired by what is printed next to them:
 *
 *   exact    same kind, same line number, same label
 *   line     same kind and label, but the line was renumbered (11 -> 11a) or regrouped
 *   similar  same line, wording changed a little ("Add lines 12 and 13" -> "Add lines 12e, 13a, and 13b"),
 *            or an unnumbered box whose wording was extended
 *
 * Years in the text are compared relative to the tax year, so "2025 estimated tax payments"
 * on the 2025 form equals "2024 estimated tax payments" on the 2024 form, and
 * "born before January 2, 1961" equals "born before January 2, 1960".
 */

const isBtn = (t) => t === 'checkbox' || t === 'radio';
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '' && v !== 'Off');

export function normalize(text, year) {
  let s = String(text || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[–—]/g, '-');
  if (year) s = s.replace(/\b(?:19|20)\d\d\b/g, (y) => { const d = Number(y) - Number(year); return `{y${d >= 0 ? '+' : ''}${d}}`; });
  return s.replace(/\s+/g, ' ').trim();
}
/* Words of a label without line references ("12e", "7a") and without the "(2)" duplicate counter. */
function words(label) {
  return new Set(label.replace(/\s\(\d+\)$/, '').split(/[^a-z0-9{}+\-]+/).filter((t) => t && !/^\d{1,2}[a-z]?$/.test(t) && !/^[a-z]$/.test(t) && t !== '-'));
}
/* 2 = same line, 1 = renumbered within the same line (11 / 11a, b / 4b), 0 = different lines. */
function lineFit(a, b) {
  if (a === b) return 2;
  if (!a || !b) return 0;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.startsWith(s) && /^[a-z]$/.test(l.slice(s.length)) && /\d$/.test(s)) return 1;
  if (/^[a-z]$/.test(s) && l.endsWith(s) && /^\d+[a-z]$/.test(l)) return 1;
  return 0;
}
function similarity(a, b) {
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  const small = Math.min(a.size, b.size), large = Math.max(a.size, b.size);
  if (!small) return { jaccard: 0, contained: 0, ratio: 0, small };
  return { jaccard: inter / (a.size + b.size - inter), contained: inter / small, ratio: small / large, small };
}

/* One entry per thing that can hold a value: a text/list field, or a single tick box. */
export function entries(model, year) {
  const out = [];
  for (const f of model.fields.values()) {
    const list = isBtn(f.type) ? f.widgets : [f.widgets[0]];
    for (const w of list) {
      const kind = isBtn(f.type) ? 'box' : f.type;
      const tag = f.copy ? `copy ${f.copy}` : ''; // an extra copy of a page only ever matches the same copy
      const line = normalize(w.line), label = normalize(w.label, year), context = [tag, normalize(w.context, year)].filter(Boolean).join(' ');
      out.push({
        kind, line, copy: f.copy || 0, labelKey: label, context, key: [kind, line, context, label].join('|'), words: words(label),
        name: f.name, on: w.onValue, maxLen: w.maxLen || 0, initial: f.initial,
        options: (w.options || []).map((o) => o.value), multi: !!w.multiSelect,
        label: [f.copy && 'Copy ' + f.copy, w.line && 'Line ' + w.line, w.context, w.label].filter(Boolean).join(' · '),
      });
    }
  }
  return out;
}

export function pair(oldEntries, newEntries) {
  const pairs = [];
  const usedOld = new Set(), usedNew = new Set();
  const take = (from, to, how) => { pairs.push({ from, to, how }); usedOld.add(from); usedNew.add(to); };
  const group = (list, keyOf, skip) => { const m = new Map(); for (const e of list) { if (skip.has(e)) continue; const k = keyOf(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); } return m; };

  // 1. exact: same kind, line, context and label (labels used several times are paired in order)
  const a = group(oldEntries, (e) => e.key, usedOld), b = group(newEntries, (e) => e.key, usedNew);
  for (const [key, olds] of a) { const news = b.get(key); if (news && news.length === olds.length) olds.forEach((o, i) => take(o, news[i], 'exact')); }

  // 2. same label; line renumbered within the same line, or the surrounding question reworded
  for (const o of oldEntries) {
    if (usedOld.has(o)) continue;
    const cands = newEntries.filter((n) => !usedNew.has(n) && n.kind === o.kind && n.copy === o.copy && n.labelKey === o.labelKey && (o.line || n.line ? lineFit(o.line, n.line) > 0 : true));
    const rivals = oldEntries.filter((x) => !usedOld.has(x) && x.kind === o.kind && x.copy === o.copy && x.labelKey === o.labelKey && (x.line || o.line ? lineFit(x.line, o.line) > 0 : true));
    if (cands.length === 1 && rivals.length === 1) take(o, cands[0], 'line');
  }

  // 3. similar wording: on the same line, or an unnumbered field whose text was only extended
  const scored = [];
  for (const o of oldEntries) {
    if (usedOld.has(o)) continue;
    for (const n of newEntries) {
      if (usedNew.has(n) || n.kind !== o.kind || n.copy !== o.copy) continue;
      const s = similarity(o.words, n.words);
      let score = 0;
      const fit = lineFit(o.line, n.line);
      if (o.line && n.line) {
        if (fit > 0 && s.small >= 2) score = Math.max(s.jaccard, s.contained * 0.95);
        score = score < 0.6 ? 0 : score + (fit === 2 ? 0.1 : 0); // the very same line number beats a renumbered one
      } else if (!o.line && !n.line) {
        if (s.jaccard >= 0.9) score = s.jaccard;
        // wording only extended ("… (MFS)" -> "… (MFS). Enter spouse's SSN above"); a box that was split in two is not carried
        else if (s.contained === 1 && s.small >= 3 && s.ratio >= 0.5 && o.words.size <= n.words.size) score = 0.7 + 0.2 * s.ratio;
      }
      if (score) scored.push({ o, n, score });
    }
  }
  scored.sort((p, q) => q.score - p.score);
  for (const c of scored) {
    if (usedOld.has(c.o) || usedNew.has(c.n)) continue;
    // ambiguous when another candidate for either side scores about the same
    const rival = scored.some((x) => x !== c && (x.o === c.o || x.n === c.n) && !usedOld.has(x.o) && !usedNew.has(x.n) && c.score - x.score < 0.08);
    if (!rival) take(c.o, c.n, 'similar');
  }
  return pairs;
}

/* What would be copied (only into fields still empty in the new year), and what has no counterpart. */
export function plan(oldEntries, newEntries, oldValues, newValues) {
  const get = (store, name) => (store.get ? store.get(name) : store[name]);
  const pairs = pair(oldEntries, newEntries);
  const paired = new Map(pairs.map((p) => [p.from, p]));
  const transfers = [], unmatched = [];
  const taken = new Set();
  for (const o of oldEntries) {
    const ov = get(oldValues, o.name);
    if (!filled(ov) || (o.kind === 'box' && ov !== o.on)) continue;
    const p = paired.get(o);
    if (!p) { unmatched.push({ label: o.label, value: o.kind === 'box' ? true : ov }); continue; }
    const to = p.to;
    if (filled(get(newValues, to.name)) || taken.has(to.name)) continue;
    let value;
    if (to.kind === 'box') value = to.on;
    else if (to.kind === 'select') {
      const ok = (Array.isArray(ov) ? ov : [ov]).filter((x) => to.options.includes(x));
      if (!ok.length) { unmatched.push({ label: o.label, value: ov }); continue; }
      value = to.multi ? ok : ok[0];
    } else { value = String(ov); if (to.maxLen) value = value.slice(0, to.maxLen); }
    taken.add(to.name);
    transfers.push({ name: to.name, value, label: to.label, how: p.how, fromLabel: o.label });
  }
  const count = (how) => pairs.filter((p) => p.how === how).length;
  const oldFilled = oldEntries.filter((o) => { const v = get(oldValues, o.name); return filled(v) && (o.kind !== 'box' || v === o.on); }).length;
  return { oldFilled, identical: pairs.length, exact: count('exact'), renumbered: count('line'), similar: count('similar'), total: newEntries.length, oldTotal: oldEntries.length, transfers, unmatched };
}
