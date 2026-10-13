/* ---------- Parser: PDF form fields -> labelled model (no DOM in here) ---------- */

const LINE_NO = /^\d{1,3}[a-z]?$/i;

export function cleanText(s) {
  return (s || '')
    .replace(/(\s*\.){3,}/g, ' ')          // dot leaders ". . . ."
    .replace(/\s+\.(?=\s+[^\p{Lu}\s]|\s*$)/gu, '') // stray spaced dots
    .replace(/\s+\.(?=\s+[^\p{Lu}\s]|\s*$)/gu, '')
    .replace(/\s+([.,;:?])(?=\s|$)/g, '$1')  // "you . If" -> "you. If"
    .replace(/[▶►▸➤➔▶►]+/g, ' ') // arrow glyphs
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.\-–—/]+/, '')
    .replace(/[\s,;:\-–—/]+$/, '')
    .trim();
}
const hasAlnum = (s) => /[\p{L}\p{N}]/u.test(s || '');

/* Turn pdf.js text content into simple boxes in viewport space (y grows downward). */
function textBoxes(textContent, viewport) {
  const out = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;
    const h = it.height || Math.hypot(t[2], t[3]) || 8;
    const [vx, vy] = viewport.convertToViewportPoint(t[4], t[5]);
    const w = it.width || 0;
    out.push({ s: it.str.trim(), word: /[\p{L}\p{N}]/u.test(it.str), x0: vx, x1: vx + w, y: vy, h, top: vy - h * 0.8, cy: vy - h * 0.3, used: false });
  }
  return out;
}

function widgetFromAnnotation(a, pageIndex, viewport) {
  if (a.subtype !== 'Widget' || a.hidden) return null;
  let type = null;
  if (a.fieldType === 'Tx') type = 'text';
  else if (a.fieldType === 'Ch') type = 'select';
  else if (a.fieldType === 'Btn') {
    if (a.checkBox) type = 'checkbox';
    else if (a.radioButton) type = 'radio';
    else return null; // push buttons do nothing useful here
  } else return null; // signatures etc.
  if (!a.fieldName) return null;
  const p1 = viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
  const p2 = viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
  const x0 = Math.min(p1[0], p2[0]), x1 = Math.max(p1[0], p2[0]);
  const y0 = Math.min(p1[1], p2[1]), y1 = Math.max(p1[1], p2[1]);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const onValue = type === 'radio' ? a.buttonValue : a.exportValue;
  let initial = '';
  if (type === 'checkbox' || type === 'radio') {
    initial = a.fieldValue && a.fieldValue !== 'Off' ? String(a.fieldValue) : 'Off';
  } else if (type === 'select') {
    initial = Array.isArray(a.fieldValue) ? (a.multiSelect ? a.fieldValue.slice() : (a.fieldValue[0] ?? '')) : (a.fieldValue ?? '');
  } else {
    initial = a.fieldValue == null ? '' : String(a.fieldValue);
  }
  return {
    id: a.id, page: pageIndex, type, name: a.fieldName,
    x0, y0, x1, y1,
    onValue: onValue == null ? 'Yes' : String(onValue),
    maxLen: a.maxLen > 0 ? a.maxLen : 0,
    comb: !!a.comb, multiLine: !!a.multiLine, password: !!a.password,
    readOnly: !!a.readOnly, required: !!a.required,
    options: (a.options || []).map((o) => ({ value: String(o.exportValue), text: String(o.displayValue ?? o.exportValue) })),
    multiSelect: !!a.multiSelect, editableCombo: !!(a.combo && a.fieldFlags & (1 << 18)),
    tooltip: cleanText(a.alternativeText || ''),
    initial,
    label: '', context: '', hint: '', line: '',
  };
}

/* Split "12a Some description 12a" into { line: "12a", text: "Some description" }. */
function splitLineNo(raw, allowTrailing) {
  let toks = cleanText(raw).split(/\s+/).filter(Boolean);
  let line = '', found = true;
  const last = toks[toks.length - 1];
  if (allowTrailing && toks.length > 1 && LINE_NO.test(last) && /\d/.test(last)) {
    line = last;
    toks.pop();
    const lo = line.toLowerCase();
    const m = /^(\d+)([a-z])$/.exec(lo);
    let cut = -1;
    for (let i = 0; i < toks.length && cut < 0; i++) {
      if (toks[i].toLowerCase() === lo) cut = i + 1;
      else if (m && toks[i] === m[1] && (toks[i + 1] || '').toLowerCase() === m[2]) cut = i + 2;
    }
    if (cut < 0 && m && (toks[0] || '').toLowerCase() === m[2]) cut = 1;
    if (cut > 0) toks = toks.slice(cut);
    else if (toks.length > 1 && /^[a-z]$/.test(toks[0]) && /^[\p{Lu}(]/u.test(toks[1])) toks.shift();
    else found = false;
  } else if (toks.length > 1 && LINE_NO.test(toks[0]) && /\d/.test(toks[0])) {
    line = toks.shift();
    if (/^[a-z]$/.test(toks[0] || '') && toks.length > 1) line += toks.shift();
  } else if (toks.length > 1 && /^[a-z]$/.test(toks[0]) && /^[\p{Lu}(]/u.test(toks[1])) {
    line = toks.shift();
  }
  return { line, text: cleanText(toks.join(' ')), found };
}

/* Guess a human label for every widget on one page from the text printed around it. */
function labelPage(widgets, boxes) {
  const sameLine = (a, b) => {
    const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return ov > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
  };
  const inside = (b, w) => {
    const cx = (b.x0 + b.x1) / 2;
    return cx > w.x0 && cx < w.x1 && b.cy > w.y0 && b.cy < w.y1;
  };
  const onLine = (b, w) => b.cy >= w.y0 - 1 && b.cy <= w.y1 + 1;
  const isBtn = (w) => w.type === 'checkbox' || w.type === 'radio';
  const join = (bs) => bs.map((b) => b.s).join(' ');

  // Text printed inside a field is a hint (e.g. "MM", "DD"), not a label.
  for (const w of widgets) {
    const hits = boxes.filter((b) => inside(b, w));
    if (hits.length && w.type === 'text') {
      w.hint = cleanText(join(hits.sort((p, q) => p.x0 - q.x0)));
      hits.forEach((b) => (b.used = true));
    }
  }

  for (const w of widgets) {
    const row = widgets.filter((o) => o !== w && sameLine(o, w));
    const before = row.filter((o) => o.x1 <= w.x0 + 1).sort((p, q) => q.x1 - p.x1);
    const after = row.filter((o) => o.x0 >= w.x1 - 1).sort((p, q) => p.x0 - q.x0);
    w._prev = before[0] || null;
    w._next = after[0] || null;
    w._first = before.length ? before[before.length - 1] : w;
    w._leftBound = w._prev ? w._prev.x1 : -Infinity;
    w._nextX = w._next ? w._next.x0 : Infinity;
    w._peers = row.filter((o) => o.type === w.type && Math.abs(o.x1 - o.x0 - (w.x1 - w.x0)) < 2).length;
  }

  // The run of text that ends just left of a widget, on one baseline. Stops where a
  // margin note starts (a wide gap together with a change of size or baseline).
  const leftRun = (w) => {
    const cand = boxes.filter((b) => !b.used && onLine(b, w) && b.x1 <= w.x0 + 2 && b.x0 >= w._leftBound - 2);
    if (!cand.length) return [];
    const anchor = cand.reduce((p, q) => (q.x1 > p.x1 ? q : p));
    const line = cand.filter((b) => Math.abs(b.y - anchor.y) <= 1.5).sort((p, q) => q.x0 - p.x0);
    const run = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const prev = run[run.length - 1], b = line[i];
      if (prev.x0 - b.x1 > 14 && (Math.abs(b.h - prev.h) > 0.6 || Math.abs(b.y - prev.y) > 1)) break;
      run.push(b);
    }
    run.reverse();
    // a caption set on two short lines beside the field ("Phone" / "no.")
    const lines = [run];
    const ys = [...new Set(cand.filter((b) => Math.abs(b.y - anchor.y) > 1.5 && Math.abs(b.x0 - run[0].x0) <= 3 && Math.abs(b.h - run[0].h) <= 0.6).map((b) => b.y))];
    for (const y of ys) lines.push(cand.filter((b) => Math.abs(b.y - y) <= 1 && b.x0 >= run[0].x0 - 3).sort((p, q) => p.x0 - q.x0));
    lines.sort((p, q) => p[0].y - q[0].y);
    return lines.flat();
  };

  // A sentence that started on the line(s) above: "37 Subtract line 33 ... / For details ... 37 [____]"
  const lineAbove = (run, w) => {
    const first = run[0];
    const up = boxes.filter((b) => !b.used && b.y < first.y - 6 && b.y > first.y - 15 && b.x0 >= first.x0 - 30 && Math.abs(b.h - first.h) <= 0.6 && !widgets.some((o) => inside(b, o)));
    if (!up.length) return null;
    const yy = Math.max(...up.map((b) => b.y));
    const line = up.filter((b) => Math.abs(b.y - yy) <= 1).sort((p, q) => p.x0 - q.x0);
    if (!line.some((b) => b.word)) return null;
    if (widgets.some((o) => o !== w && line.some((b) => onLine(b, o) && b.x1 <= o.x0 + 2))) return null; // belongs to another field
    return line;
  };
  const leadText = (w, allowTrailing, trimOption) => {
    let run = w._lead;
    if (!run.length) return { line: '', text: '', found: true };
    const fix = (t) => (trimOption ? t.replace(/(\s*\.)*[:\s]+\d\s*$/, '') : t);
    let sp = splitLineNo(fix(join(run)), allowTrailing);
    for (let i = 0; i < 2; i++) {
      const cont = (sp.line && !sp.found) || (!sp.line && /^[\p{Ll}]/u.test(sp.text));
      if (!cont) break;
      const up = lineAbove(run, w);
      if (!up) break;
      run = up.concat(run);
      sp = splitLineNo(fix(join(run)), allowTrailing);
    }
    return sp;
  };

  // Pass 1: tick boxes usually carry their label immediately to the right.
  for (const w of widgets) {
    if (!isBtn(w)) continue;
    const cand = boxes
      .filter((b) => !b.used && onLine(b, w) && b.x0 >= w.x1 - 1 && b.x0 < w._nextX - 1)
      .sort((p, q) => p.x0 - q.x0);
    if (!cand.length || cand[0].x0 - w.x1 > 16) continue;
    const take = [];
    const starts = cand.filter((b) => b.x0 <= cand[0].x0 + 3).sort((p, q) => p.y - q.y);
    for (const st of starts) {
      const ln = cand.filter((b) => Math.abs(b.y - st.y) <= 1.5 && b.x0 >= st.x0 - 0.5);
      let lastB = null;
      for (const b of ln) {
        if (lastB && b.x0 - lastB.x1 > 12) break;
        take.push(b); lastB = b;
      }
    }
    while (take.length > 1 && /^\d{1,2}$/.test(take[take.length - 1].s) && w._next && isBtn(w._next) && w._nextX - take[take.length - 1].x1 < 14) take.pop();
    const txt = cleanText(join(take));
    if (!hasAlnum(txt)) continue;
    // "... check here [ ] . . 28 [amount]" – that number belongs to the amount box, not the tick box
    if (LINE_NO.test(txt) && w._next && w._next.type === 'text' && w._nextX - take[take.length - 1].x1 < 8) continue;
    w.label = txt;
    w._side = 'right';
    take.forEach((b) => (b.used = true));
  }

  // Pass 2: caption printed above (left aligned with the field) or text to the left on the same line.
  for (const w of widgets) {
    w._lead = leftRun(w);
    if (w.label) continue;
    const aboveAll = boxes.filter((b) => !b.used && b.word && b.cy < w.y0 - 0.5 && b.cy > w.y0 - 13 && b.x0 < w.x1 && b.x1 > w.x0);
    let above = [];
    if (aboveAll.length) {
      const nearestY = Math.max(...aboveAll.map((b) => b.y));
      above = aboveAll.filter((b) => Math.abs(b.y - nearestY) < 2 && b.x0 >= w.x0 - 4).sort((p, q) => p.x0 - q.x0);
    }
    const leadWords = w._lead.filter((b) => b.word);
    const inline = leadWords.length && w.x0 - Math.max(...w._lead.map((b) => b.x1)) <= 6 && hasAlnum(cleanText(join(w._lead)));
    if (!isBtn(w) && !inline && above.length && above[0].x0 - w.x0 <= 12 && hasAlnum(cleanText(join(above)))) {
      // a caption set on two or three lines: collect the lines above that start at the same place
      let lines = [above];
      for (let i = 0; i < 2; i++) {
        const top = lines[0][0];
        const up = boxes.filter((b) => !b.used && top.y - b.y > top.h * 0.8 && top.y - b.y < top.h * 1.7 && Math.abs(b.h - top.h) <= 0.6
          && b.x0 >= top.x0 - 3 && b.x0 < w.x1 && !widgets.some((o) => inside(b, o) || (onLine(b, o) && b.x1 <= o.x0 + 2 && o.x0 - b.x1 < 40)));
        if (!up.length || !up.some((b) => Math.abs(b.x0 - top.x0) <= 3)) break;
        const yy = Math.max(...up.map((b) => b.y));
        lines.unshift(up.filter((b) => Math.abs(b.y - yy) < 1.5).sort((p2, q2) => p2.x0 - q2.x0));
      }
      w.label = cleanText(lines.map(join).join(' '));
      w._side = 'above';
    } else if (hasAlnum(cleanText(join(w._lead)))) {
      const rawLead = join(w._lead).replace(/[\s.]+/g, ' ').trim();
      if (!isBtn(w) && LINE_NO.test(rawLead) && /\d/.test(rawLead)) {
        w.line = rawLead; // only "35a" in front of the box: the description sits further left
      } else {
        const sp = leadText(w, !isBtn(w), false);
        w.label = sp.text; w.line = sp.line;
      }
      w._side = 'left';
    }
  }

  // The question a group of boxes belongs to = the nearest worded text leading up to them.
  const letters = (t) => (t.match(/\p{L}/gu) || []).length;
  const rowLead = (w) => {
    let o = w._side === 'right' ? w : w._prev, hops = 0;
    while (o && hops++ < 16) {
      if (letters(join(o._lead)) >= 3) return leadText(o, !isBtn(o), isBtn(o)).text;
      o = o._prev;
    }
    return '';
  };

  // Pass 3: nothing usable nearby — borrow from the row, the neighbour, or a column heading.
  const strong = new Map(widgets.map((w) => [w, hasAlnum(w.label) && (w._side !== 'left' || w.line || w.label.replace(/[^\p{L}\p{N}]/gu, '').length >= 3)]));
  for (const w of widgets) {
    if (strong.get(w)) continue;
    w._weak = true;
    let own = w.label;
    let ctx = '';
    const p = w._prev;
    if (p && isBtn(p) && p._side === 'right' && !isBtn(w) && !w.line) ctx = p.label;
    if (!ctx) ctx = rowLead(w);
    if (!ctx) { let q = p, hops = 0; while (q && !strong.get(q) && hops++ < 12) q = q._prev; if (q) ctx = q.label; }
    if (ctx) {
      w.label = own && hasAlnum(own) ? ctx + ' – ' + own : ctx;
      w._borrowed = true;
      continue;
    }
    w.label = own;
    if (hasAlnum(own)) continue;
    const col = boxes.filter((b) => b.word && b.cy < w.y0 && b.cy > w.y0 - 220 && b.x0 < w.x1 - 1 && b.x1 > w.x0 + 1 && !widgets.some((o) => inside(b, o)));
    if (col.length) {
      const yy = Math.max(...col.map((b) => b.y));
      const txt = cleanText(join(col.filter((b) => Math.abs(b.y - yy) < 2).sort((a2, b2) => a2.x0 - b2.x0)));
      if (hasAlnum(txt)) w.label = txt;
    }
  }

  // Tables with a heading per column and one unlabeled row per entry (e.g. a list of dependents).
  const seen = new Set();
  for (const w of widgets) {
    if (seen.has(w)) continue;
    const col = widgets.filter((o) => o.type === w.type && Math.abs(o.x0 - w.x0) < 1.5 && Math.abs(o.x1 - w.x1) < 1.5).sort((p, q) => p.y0 - q.y0);
    const run = [w];
    for (const o of col) if (o !== w && o.y0 > run[run.length - 1].y0 && o.y0 - run[run.length - 1].y1 < Math.max(3, 0.75 * (o.y1 - o.y0))) run.push(o);
    run.forEach((o) => seen.add(o));
    const top = run[0];
    if (run.length < 3 || run.some((o) => o.line) || run.every((o) => o._peers >= 2) || !(top._side === 'above' || top._weak)) continue;
    const cand = boxes.filter((b) => { const cx = (b.x0 + b.x1) / 2; return b.word && cx > top.x0 - 1 && cx < top.x1 + 1 && b.cy < top.y0 && b.cy > top.y0 - 30 && !widgets.some((o) => inside(b, o)); })
      .sort((p, q) => q.y - p.y);
    if (!cand.length) continue;
    const head = [cand[0]];
    for (const b of cand.slice(1)) { const last = head[head.length - 1]; if (Math.abs(b.h - cand[0].h) > 0.6 || last.y - b.y > b.h * 1.7) break; head.push(b); }
    const title = cleanText(join(head.sort((p, q) => (Math.abs(p.y - q.y) > 1.5 ? p.y - q.y : p.x0 - q.x0))));
    if (!hasAlnum(title)) continue;
    run.forEach((o, i) => { o.label = `${title} – row ${i + 1}`; o.context = ''; o._side = 'table'; });
  }

  // Short answers such as "Yes"/"No" need the question they belong to.
  for (const w of widgets) {
    if (w._side !== 'right' || w.label.split(/\s+/).length > 2 || w.label.length > 14) continue;
    const q = rowLead(w);
    if (hasAlnum(q) && q.length > 3) w.context = q;
  }

  // Grids (several equal columns): put the column heading in front, e.g. "Dependent 2: First name".
  for (const w of widgets) {
    if (w.type !== 'text' || w._peers < 2) continue;
    const stack = widgets.filter((o) => o.type === 'text' && Math.abs(o.x0 - w.x0) < 1.5 && Math.abs(o.x1 - w.x1) < 1.5 && o._peers >= 2 && Math.abs(o.y0 - w.y0) < 120);
    const top = stack.reduce((p, q) => (q.y0 < p.y0 ? q : p), w);
    const head = boxes.filter((b) => { const cx = (b.x0 + b.x1) / 2; return b.cy < top.y0 && b.cy > top.y0 - 14 && cx > w.x0 && cx < w.x1 && b.x0 > w.x0 - 2 && b.x1 < w.x1 + 2; });
    const txt = cleanText(join(head.sort((p, q) => p.x0 - q.x0)));
    if (hasAlnum(txt) && w.label && txt !== w.label) w.label = txt + ': ' + w.label;
  }

  for (const w of widgets) {
    // A tooltip stored in the PDF beats a guess, unless it is just the internal field name.
    const leafName = w.name.split('.').pop().replace(/\[\d+\]$/, '');
    if (w.tooltip && w.tooltip.length > 2 && w.tooltip !== leafName && (!w.label || /\s/.test(w.tooltip))) { w.label = w.tooltip; w.context = ''; }
    if (!hasAlnum(w.label)) w.label = '';
    if (w.hint && w.label && w.hint.toLowerCase() !== w.label.toLowerCase() && w.hint.length <= 12) w.label += ' (' + w.hint + ')';
    if (w.label.length > 200) w.label = w.label.slice(0, 197).trimEnd() + '…';
    for (const k of ['_leftBound', '_nextX', '_prev', '_next', '_first', '_side', '_lead', '_peers', '_borrowed', '_weak']) delete w[k];
  }
}

/* Fallback name when no text could be matched: tidy up the internal PDF field name. */
function prettyName(name) {
  const leaf = String(name).split('.').pop().replace(/\[\d+\]$/, '');
  return leaf.replace(/[_\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || String(name);
}

/* pages: [{ index, viewport, annotations, textContent }] -> { widgets, fields } */
export function buildModel(pages) {
  const widgets = [];
  for (const p of pages) {
    const ws = p.annotations.map((a) => widgetFromAnnotation(a, p.index, p.viewport)).filter(Boolean);
    labelPage(ws, textBoxes(p.textContent, p.viewport));
    widgets.push(...ws);
  }
  // One logical field per PDF field name; tick boxes sharing a name form an exclusive group.
  const fields = new Map();
  for (const w of widgets) {
    let f = fields.get(w.name);
    if (!f) {
      f = { name: w.name, type: w.type, widgets: [], initial: w.initial, readOnly: w.readOnly };
      fields.set(w.name, f);
    }
    f.widgets.push(w);
    if ((w.type === 'checkbox' || w.type === 'radio') && w.initial !== 'Off') f.initial = w.initial;
  }
  for (const f of fields.values()) {
    f.exclusive = (f.type === 'checkbox' || f.type === 'radio') && new Set(f.widgets.map((w) => w.onValue)).size > 1;
    for (const w of f.widgets) if (!w.label) w.label = prettyName(w.name) + (f.exclusive ? ' – ' + w.onValue : '');
  }
  // Tell identical neighbours apart: "Other", "Other (2)", "Other (3)".
  const seen = new Map();
  for (const w of widgets) {
    const key = w.page + '|' + w.line + '|' + w.label + '|' + w.context;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n > 1 && fields.get(w.name).widgets[0] === w) w.label += ' (' + n + ')';
  }
  return { widgets, fields };
}
