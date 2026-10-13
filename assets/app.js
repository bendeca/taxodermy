/* Taxodermy — one section per form, one folder per tax year, everything in flat files. */
import { buildModel } from './parser.js';
import { entries, plan } from './match.js';
import { SEP, expandModel, cleanCopies, mergeCopies, combineForPrint } from './copies.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const isBtn = (t) => t === 'checkbox' || t === 'radio';
const isFilled = (v) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '' && v !== 'Off');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const DEFAULT_FORMS = [
  { id: '1040', name: 'Form 1040', title: 'U.S. Individual Income Tax Return', irsFile: 'f1040', detect: 'U\\.S\\. Individual Income Tax Return', detectNot: 'Amended|SCHEDULE' },
  { id: '1040-schedule-1', name: 'Schedule 1', title: 'Additional Income and Adjustments to Income', irsFile: 'f1040s1', detect: 'Additional Income and Adjustments to Income' },
  { id: '1040-schedule-3', name: 'Schedule 3', title: 'Additional Credits and Payments', irsFile: 'f1040s3', detect: 'Additional Credits and Payments' },
  { id: '2555', name: 'Form 2555', title: 'Foreign Earned Income', irsFile: 'f2555', detect: 'Foreign Earned Income' },
  { id: '1116', name: 'Form 1116', title: 'Foreign Tax Credit', irsFile: 'f1116', detect: 'Foreign Tax Credit' },
  { id: '8938', name: 'Form 8938', title: 'Statement of Specified Foreign Financial Assets', irsFile: 'f8938', detect: 'Statement of Specified Foreign Financial Assets', repeatPages: [2] },
];

/* ---------- flat-file storage (served by server.py / server.js) ---------- */
const api = {
  async list() { const r = await fetch('api/list'); if (!r.ok) throw new Error('list ' + r.status); return r.json(); },
  async json(path) { const r = await fetch('data/' + path); if (r.status === 404) return null; if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); },
  async bytes(path) { const r = await fetch('data/' + path); if (!r.ok) throw new Error(path + ' ' + r.status); return new Uint8Array(await r.arrayBuffer()); },
  async put(path, body, type) {
    const r = await fetch(path, { method: 'PUT', body, headers: { 'Content-Type': type || 'application/octet-stream', 'X-Tax-Forms': '1' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'write failed (' + r.status + ')');
  },
  async del(path) { const r = await fetch('data/' + path, { method: 'DELETE', headers: { 'X-Tax-Forms': '1' } }); if (!r.ok) throw new Error('delete failed'); },
};

const S = {
  forms: DEFAULT_FORMS, tree: { people: {}, legacy: [], years: {} }, summaries: {}, people: [], person: null, year: null, formId: null,
  lib: null, pdf: null, model: null, pages: [], meta: {},
  base: null, basePages: [], copies: {}, // the PDF as it is, and extra copies per page number
  values: new Map(), initial: new Map(), touched: new Set(), carried: new Map(), unmatched: {},
  controls: new Map(), rows: new Map(), overlays: new Map(),
  zoom: 'fit', scale: 1, show: 'all', linked: null, renderChain: Promise.resolve(), gen: 0,
  carryPlan: null, carryError: null, carryReport: false, prevYear: null,
  rates: {},
};
const form = (id = S.formId) => S.forms.find((f) => f.id === id);
const has = (year, name) => !!(S.tree.years[year] && name in S.tree.years[year]);
/* Everything of one person lives in data/<person>/<year>/. */
const PERSON_ID = /^(?=.*[a-z])[a-z0-9][a-z0-9-]{0,40}$/;
const D = (year, file, person = S.person) => `${person}/${year}/${file}`;
const personName = (id = S.person) => (S.people.find((p) => p.id === id) || {}).name || id || '';
const treeYear = (year, person = S.person) => ((S.tree.people[person] ??= { years: {} }).years[year] ??= {});
function usePerson(id) { S.person = id; S.tree.years = id ? (S.tree.people[id] ??= { years: {} }).years : {}; }

let libPromise;
function loadLib() {
  return (libPromise ??= (async () => {
    const lib = await import('./vendor/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
    return lib;
  })());
}

/* ---------- small UI helpers ---------- */
let toastTimer;
function toast(msg, action) {
  const t = $('toast'); t.textContent = '';
  t.append(el('span', '', msg));
  if (action) { const b = el('button', '', action.label); b.type = 'button'; b.onclick = () => { t.hidden = true; action.run(); }; t.append(b); }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 9000 : 5000);
}
function status(msg, bad) { const s = $('status'); s.textContent = msg; s.classList.toggle('bad', !!bad); }
function note(title, text) { const n = el('div', 'note'); n.append(el('b', '', title), document.createTextNode(text || '')); return n; }
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* ---------- reading a PDF ---------- */
async function readPdf(bytes, keepPages) {
  const lib = (S.lib = await loadLib());
  const task = lib.getDocument({ data: bytes, enableXfa: false, isEvalSupported: false });
  task.onPassword = (update, reason) => {
    const pw = prompt(reason === 2 ? 'Wrong password. Try again:' : 'This PDF is password protected. Password:');
    if (pw == null) task.destroy(); else update(pw);
  };
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const [annotations, textContent] = await Promise.all([page.getAnnotations({ intent: 'display' }), page.getTextContent()]);
    pages.push({ index: i - 1, page, viewport, annotations, textContent });
  }
  // text in the title band of page 1 and anywhere on page 1 (to recognise form and year)
  const first = pages[0];
  let header = '', all = '';
  if (first) for (const it of first.textContent.items) {
    if (!it.str.trim()) continue;
    const y = first.viewport.convertToViewportPoint(it.transform[4], it.transform[5])[1];
    all += it.str + ' ';
    if (y < first.viewport.height * 0.2) header += it.str + ' ';
  }
  const model = buildModel(pages);
  for (const p of pages) { p.annotations = null; p.textContent = null; }
  if (!keepPages) { await task.destroy(); return { model, header, all, pageCount: pages.length }; }
  return { pdf, pages, model, header, all };
}
function guessForm(fileName, header) {
  const base = (fileName || '').toLowerCase().replace(/\.pdf$/, '');
  const byName = S.forms.filter((f) => f.irsFile && new RegExp('^' + f.irsFile + '(?![a-z0-9])', 'i').test(base))
    .sort((a, b) => b.irsFile.length - a.irsFile.length)[0];
  if (byName) return byName;
  const text = header.replace(/\s+/g, ' ');
  return S.forms.find((f) => {
    try { return f.detect && new RegExp(f.detect.replace(/ /g, '\\s*'), 'i').test(text) && !(f.detectNot && new RegExp(f.detectNot).test(text)); } catch { return false; }
  }) || null;
}
function guessYear(text) {
  if (/\bRev\.\s+\w+\s+(?:19|20)\d\d/.test(text)) return null; // revision-dated form, used for several years
  const m = /\((20\d\d)\)/.exec(text) || /\b(20\d\d)\s+Form\b/.exec(text);
  return m ? m[1] : null;
}

/* ---------- folders ---------- */
async function refreshTree() {
  S.tree = await api.list();
  S.tree.people ??= {}; S.tree.legacy ??= []; S.tree.shared ??= [];
  usePerson(S.person);
  $('folder').textContent = '';
  if (S.person) $('folder').append('Saved as plain files in ', el('code', '', `${S.tree.folder || 'data'}/${S.person}`));
}

/* ---------- people ---------- */
async function loadPeople() {
  const j = S.tree.shared.includes('people.json') ? await api.json('people.json') : null;
  const people = (j && Array.isArray(j.people) ? j.people : []).filter((p) => p && PERSON_ID.test(p.id || '') && p.name).map((p) => ({ id: p.id, name: String(p.name) }));
  for (const id of Object.keys(S.tree.people)) if (!people.some((p) => p.id === id)) people.push({ id, name: id }); // a folder made by hand
  S.people = people;
}
const savePeople = () => api.put('data/people.json', JSON.stringify({ people: S.people }, null, 2), 'application/json');
function slug(name) {
  let base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  if (!/[a-z]/.test(base)) base = ('person-' + base).replace(/-$/, '');
  let id = base, n = 2;
  while (S.people.some((p) => p.id === id) || id in S.tree.people) id = `${base}-${n++}`;
  return id;
}
async function createPerson(name) {
  const id = slug(name);
  await api.put('api/people/' + id, '');
  S.people.push({ id, name }); await savePeople();
  return id;
}
function renderPeople() {
  const sel = $('person'); sel.textContent = '';
  $('who').hidden = !S.people.length;
  for (const p of S.people) sel.append(new Option(p.name, p.id, false, p.id === S.person));
  const grp = el('optgroup'); grp.label = '—';
  grp.append(new Option('Add a person…', '+'), new Option(`Rename ${personName()}…`, '~'));
  sel.append(grp);
}
async function onPersonPicked() {
  const v = $('person').value;
  if (v === '+') {
    const name = (prompt('Name of the person whose returns you want to add:') || '').trim().replace(/\s+/g, ' ');
    if (!name) return renderPeople();
    if (S.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast(`${name} already exists.`); return renderPeople(); }
    try { const id = await createPerson(name); await refreshTree(); go(S.year, RESERVED.includes(S.formId) ? S.forms[0].id : S.formId, id); }
    catch (e) { status('Could not add the person: ' + e.message, true); renderPeople(); }
  } else if (v === '~') {
    const me = S.people.find((p) => p.id === S.person);
    const name = (prompt('New name (the folder name stays the same):', me.name) || '').trim().replace(/\s+/g, ' ');
    if (name && name !== me.name) { me.name = name; try { await savePeople(); } catch (e) { status('Could not save: ' + e.message, true); } }
    renderPeople();
  } else go(S.year, S.formId, v);
}

/* First start, or year folders left over from before people existed. */
function showWelcome() {
  const legacy = S.tree.legacy;
  $('years').textContent = ''; $('formList').textContent = ''; $('extraList').textContent = ''; $('sideConv').hidden = true; $('who').hidden = true; $('printBtn').hidden = true;
  const box = $('empty'); box.textContent = ''; box.hidden = false;
  const d = el('form', 'drop');
  d.append(el('h1', '', legacy.length ? 'Whose tax returns are these?' : 'Who is the first person?'),
    el('p', '', legacy.length
      ? `The tax ${legacy.length === 1 ? 'year' : 'years'} ${legacy.join(', ')} ${legacy.length === 1 ? 'was' : 'were'} saved before the app could keep several people apart. Enter the name they belong to; the folders are moved into that person's folder, nothing else changes.`
      : 'Each person gets their own folder, with one sub-folder per tax year. You can add more people later from the menu at the top.'));
  const name = el('input'); name.type = 'text'; name.placeholder = 'Name, e.g. Ada Lovelace'; name.required = true; name.maxLength = 60; name.setAttribute('aria-label', 'Name');
  const btn = el('button', 'btn primary', legacy.length ? 'Move them to this person' : 'Add person'); btn.type = 'submit';
  const btns = el('div', 'btns'); btns.append(name, btn); d.append(btns);
  d.onsubmit = async (e) => {
    e.preventDefault();
    const n = name.value.trim().replace(/\s+/g, ' '); if (!n) return;
    btn.disabled = true;
    try {
      const known = S.people.find((p) => p.name.toLowerCase() === n.toLowerCase());
      const id = known ? known.id : await createPerson(n);
      if (legacy.length) {
        const r = await (await fetch('api/adopt/' + id, { method: 'PUT', headers: { 'X-Tax-Forms': '1' } })).json();
        if (r.skipped && r.skipped.length) toast(`${r.skipped.join(', ')} already existed for ${n} and stayed where it was.`);
      }
      await refreshTree(); await loadRates();
      if (S.tree.legacy.length) { btn.disabled = false; return showWelcome(); }
      go(null, S.forms[0].id, id);
    } catch (err) { status('Could not set this up: ' + err.message, true); btn.disabled = false; }
  };
  box.append(d); name.focus(); status('');
}

/* ---------- years + sidebar ---------- */
function yearList() {
  const ys = new Set(Object.keys(S.tree.years));
  if (S.year) ys.add(S.year);
  return [...ys].sort();
}
function renderYears() {
  const nav = $('years'); nav.textContent = '';
  for (const y of yearList()) {
    const b = el('button', '', y); b.type = 'button';
    b.setAttribute('aria-current', y === S.year);
    b.onclick = () => go(y, S.formId);
    nav.append(b);
  }
  const add = el('button', 'add', '+ Year'); add.type = 'button'; add.title = 'Start another tax year';
  add.onclick = addYear;
  nav.append(add);
  const pb = $('printBtn'); pb.hidden = false; pb.textContent = `Print ${S.year}`;
  pb.title = `Print every ${S.year} form of ${personName()} that has entries, in one go`;
}
async function addYear() {
  const ys = yearList();
  const next = String(Math.max(...ys.map(Number), new Date().getFullYear() - 2) + 1);
  const y = (prompt('Which tax year do you want to add?', next) || '').trim();
  if (!y) return;
  if (!/^(19|20)\d\d$/.test(y)) { toast('Enter a four-digit year, for example ' + next + '.'); return; }
  try { await api.put(`api/years/${S.person}/${y}`, ''); await refreshTree(); go(y, S.formId); }
  catch (e) { status('Could not create the folder: ' + e.message, true); }
}
async function loadSummaries(year) {
  const out = {};
  await Promise.all(S.forms.map(async (f) => {
    if (has(year, f.id + '.json')) { try { out[f.id] = (await api.json(D(year, f.id + '.json'))) || {}; } catch { out[f.id] = {}; } }
  }));
  S.summaries[year] = out;
}
function renderSidebar() {
  const ul = $('formList'); ul.textContent = '';
  const sums = S.summaries[S.year] || {};
  for (const f of S.forms) {
    const li = el('li'); const b = el('button'); b.type = 'button';
    b.setAttribute('aria-current', f.id === S.formId);
    b.onclick = () => go(S.year, f.id);
    b.append(el('b', '', f.name), el('span', '', f.title));
    const st = (sums[f.id] || {}).stats;
    if (!has(S.year, f.id + '.pdf')) b.append(el('em', 'todo', 'No PDF for ' + S.year + ' yet'));
    else if (st && st.fields) {
      const em = el('em', '', `${st.filled} of ${st.fields} filled`);
      if (st.toCheck) em.append(' · ', el('span', 'check', `${st.toCheck} to check`));
      const meter = el('div', 'meter'); const bar = el('i'); bar.style.width = (st.filled / st.fields) * 100 + '%'; meter.append(bar);
      b.append(em, meter);
    } else b.append(el('em', '', 'PDF added'));
    li.append(b); ul.append(li);
  }
  const li = el('li', 'addform'); const add = el('button', '', '+ Add a form'); add.type = 'button';
  add.title = 'Add a section for another IRS form, e.g. Schedule 2';
  add.setAttribute('aria-current', S.formId === ADD_FORM);
  add.onclick = () => go(S.year, ADD_FORM);
  li.append(add); ul.append(li);
  renderRatesEntry();
}

/* ---------- IRS yearly average exchange rate, Swiss franc only: data/<year>/rates.json ---------- */
const IRS_RATES_URL = 'https://www.irs.gov/individuals/international-taxpayers/yearly-average-currency-exchange-rates';
const CUR = { code: 'CHF', irsName: 'Switzerland Franc' };

/* "85'000.50", "85,000.50", "85 000,50", "0,831" -> number (or null) */
function parseNum(text) {
  let t = String(text ?? '').trim().replace(/[\s'’ ]/g, '');
  if (!t) return null;
  const c = t.lastIndexOf(','), d = t.lastIndexOf('.');
  if (c > -1 && d > -1) t = c > d ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (c > -1) t = (t.match(/,/g).length === 1 && !/,\d{3}$/.test(t)) || /^0,/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function readRate(j) {
  let rate = Number(j && j.rate);
  if (!(rate > 0) && j && Array.isArray(j.rates)) { // file written by the earlier multi-currency version
    const old = j.rates.find((r) => r && /swi|franc|chf/i.test(String(r.name)));
    rate = old ? Number(old.rate) : NaN;
  }
  return rate > 0 ? rate : null;
}
/* The IRS rate is the same for everybody, so it is kept once: data/rates.json */
async function loadRates() {
  const out = {};
  try { const j = S.tree.shared.includes('rates.json') ? await api.json('rates.json') : null; for (const [y, r] of Object.entries((j && j.rates) || {})) if (/^(19|20)\d\d$/.test(y) && Number(r) > 0) out[y] = Number(r); } catch {}
  S.rates = out;
  // per-year files from earlier versions are folded into the shared file
  let moved = false;
  for (const [pid, p] of Object.entries(S.tree.people)) for (const [y, files] of Object.entries(p.years)) {
    if (!('rates.json' in files)) continue;
    try {
      const rate = readRate(await api.json(D(y, 'rates.json', pid)));
      if (rate && !(y in S.rates)) S.rates[y] = rate;
      await api.del(D(y, 'rates.json', pid)); delete files['rates.json']; moved = true;
    } catch {}
  }
  if (moved) { ratesDirty = true; await flushRates(); }
}
let ratesDirty = false, ratesTimer = null, ratesChain = Promise.resolve();
function setRate(year, rate) {
  if (rate == null) delete S.rates[year]; else S.rates[year] = rate;
  ratesDirty = true; status('Saving…'); clearTimeout(ratesTimer); ratesTimer = setTimeout(flushRates, 400);
  renderRatesEntry(); refreshConverters();
}
function flushRates() {
  clearTimeout(ratesTimer);
  if (!ratesDirty) return ratesChain;
  ratesDirty = false;
  const rates = Object.fromEntries(Object.keys(S.rates).sort().map((y) => [y, S.rates[y]]));
  const body = { currency: CUR.code, irsName: CUR.irsName, what: 'IRS yearly average exchange rate: Swiss francs per 1 U.S. dollar, by tax year', source: IRS_RATES_URL, savedAt: new Date().toISOString(), rates };
  ratesChain = ratesChain.then(async () => {
    try { await api.put('data/rates.json', JSON.stringify(body, null, 2), 'application/json'); if (!ratesDirty) status(`Saved · data/rates.json · ${clock()}`); }
    catch (e) { ratesDirty = true; status('NOT SAVED — is the server still running? (' + e.message + ')', true); }
  });
  return ratesChain;
}

function renderRatesEntry() {
  const ul = $('extraList'); ul.textContent = '';
  const li = el('li'); const b = el('button'); b.type = 'button';
  b.setAttribute('aria-current', S.formId === 'rates');
  b.onclick = () => go(S.year, 'rates');
  const rate = S.rates[S.year];
  b.append(el('b', '', 'Exchange rate'), el('span', '', 'IRS yearly average, CHF'), el('em', rate ? '' : 'todo', rate ? `${S.year}: ${rate} CHF per USD` : `Not set for ${S.year}`));
  li.append(b); ul.append(li);
  buildConverter($('sideConv'), true);
}

/* A small calculator: francs / rate = U.S. dollars (or dollars x rate = francs). */
function buildConverter(box, compact) {
  const rate = S.rates[S.year];
  const keep = { amt: box.querySelector('input')?.value || '', dir: box.dataset.dir || 'toUsd' };
  box.textContent = ''; box.hidden = !rate; box.dataset.dir = keep.dir;
  if (!rate) return;
  const title = el('b', '', compact ? `Convert at the ${S.year} rate (${rate})` : `Converter · ${S.year} · ${rate} CHF per USD`);
  const amt = el('input'); amt.type = 'text'; amt.inputMode = 'decimal'; amt.value = keep.amt;
  const dir = el('button', 'btn', ''); dir.type = 'button'; dir.title = 'Switch direction';
  const out = el('output'); const copy = el('button', 'btn', 'Copy'); copy.type = 'button';
  let result = null;
  const calc = () => {
    const toUsd = box.dataset.dir !== 'toForeign';
    dir.textContent = toUsd ? 'CHF → USD ⇄' : 'USD → CHF ⇄';
    amt.placeholder = toUsd ? 'Amount in CHF' : 'Amount in USD'; amt.setAttribute('aria-label', amt.placeholder);
    const n = parseNum(amt.value);
    result = n == null ? null : toUsd ? n / rate : n * rate;
    out.textContent = result == null ? (amt.value.trim() ? 'not a number' : '') : toUsd ? '$ ' + money(result) : 'CHF ' + money(result);
    out.title = result == null ? '' : toUsd ? `${amt.value} ÷ ${rate}` : `${amt.value} × ${rate}`;
    copy.disabled = result == null;
  };
  amt.oninput = calc;
  dir.onclick = () => { box.dataset.dir = box.dataset.dir === 'toForeign' ? 'toUsd' : 'toForeign'; calc(); };
  copy.onclick = async () => { const text = result.toFixed(2); try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`); } catch { toast(text); } };
  const line = el('div', 'line'); line.append(out, copy);
  box.append(title, amt, dir, line);
  calc();
}
function refreshConverters() { buildConverter($('sideConv'), true); const c = document.getElementById('ratesConv'); if (c) buildConverter(c, false); }

function showRates() {
  const view = $('ratesView'); view.textContent = ''; view.hidden = false;
  const years = [...new Set([...yearList(), ...Object.keys(S.rates)])].sort().reverse(); // newest first, like the IRS table
  const wrap = el('div', 'rates');
  wrap.append(el('h1', '', 'IRS yearly average exchange rate · Swiss franc'));
  const p = el('p');
  const a = el('a', '', 'IRS: Yearly average currency exchange rates'); a.href = IRS_RATES_URL; a.target = '_blank'; a.rel = 'noopener';
  p.append('Enter the “Switzerland – Franc” figure for each tax year from ', a, '. It is the number of Swiss francs per 1 U.S. dollar. Francs to dollars: divide by the rate. Dollars to francs: multiply by the rate.');
  wrap.append(p);
  const table = el('table');
  const head = el('tr'); head.append(el('th', '', 'Tax year'), el('th', '', 'CHF per 1 USD'), el('th', '', '')); table.append(head);
  for (const y of years) {
    const tr = el('tr'); if (y === S.year) tr.className = 'now';
    const i = el('input'); i.type = 'text'; i.inputMode = 'decimal'; i.dataset.year = y; i.placeholder = 'e.g. 0.881'; i.maxLength = 8;
    i.value = S.rates[y] == null ? '' : String(S.rates[y]); i.setAttribute('aria-label', `${y} rate, Swiss francs per U.S. dollar`);
    const hint = el('td', 'hint');
    const check = () => {
      const n = parseNum(i.value), blank = !i.value.trim();
      const bad = !blank && !(n > 0), odd = !bad && !blank && (n < 0.5 || n > 2);
      i.classList.toggle('bad', bad);
      hint.textContent = bad ? 'Enter a number such as 0.881' : odd ? 'Unusual for CHF per USD — check the IRS table' : blank ? 'Not set' : `1 USD = ${n} CHF · 1 CHF = ${(1 / n).toFixed(4)} USD`;
      return blank ? null : bad ? undefined : n;
    };
    i.oninput = () => { const n = check(); if (n !== undefined) setRate(y, n); };
    const td = el('td'); td.append(i); tr.append(el('td', '', y), td, hint); table.append(tr);
    check();
  }
  wrap.append(table);
  const conv = el('div', 'conv wide'); conv.id = 'ratesConv'; wrap.append(conv);
  const files = el('p', 'files'); files.append('Stored once for everyone in ', el('code', '', 'data/rates.json'), '.'); wrap.append(files);
  view.append(wrap);
  buildConverter(conv, false);
  status('');
}

/* ---------- adding and removing form sections: data/forms.json ---------- */
const ADD_FORM = 'add-form';
const RESERVED = ['rates', ADD_FORM];
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const saveForms = () => api.put('data/forms.json', JSON.stringify({ forms: S.forms }, null, 2), 'application/json');
/* Does anyone have a PDF or entries for this form, in any year? */
const formInUse = (id) => Object.values(S.tree.people).some((p) => Object.values(p.years).some((files) => Object.keys(files).some((n) => n === id + '.pdf' || n === id + '.json' || n === id + '-filled.pdf')));
function newFormId(name) {
  let base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(irs\s+)?form\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-filled$/, '').slice(0, 40) || 'form';
  if (RESERVED.includes(base)) base += '-form';
  let id = base, n = 2;
  while (S.forms.some((f) => f.id === id || f.id + '-filled' === id || id + '-filled' === f.id)) id = `${base}-${n++}`;
  return id;
}
function showAddForm() {
  const view = $('formView'); view.textContent = ''; view.hidden = false;
  const pre = S.addPrefill || {}; S.addPrefill = null;
  const wrap = el('form', 'rates addform');
  wrap.append(el('h1', '', 'Add a form'),
    el('p', '', 'Adds a section to the list on the left, for every person and year. Then add the blank, fillable PDF for it as usual.'));
  const grid = el('div', 'fields');
  const field = (label, input, help) => {
    const l = el('label'); l.append(el('b', '', label), input); if (help) l.append(el('small', '', help)); grid.append(l); return input;
  };
  const input = (placeholder, value = '', max = 80) => { const i = el('input'); i.type = 'text'; i.placeholder = placeholder; i.value = value; i.maxLength = max; return i; };
  const name = field('Name', input('e.g. Schedule 2', '', 40), 'Short name shown in the list.');
  const title = field('Title', input('e.g. Additional Taxes', '', 120), 'The title printed on the form. Dropped PDFs whose first page shows this text are sorted into this section.');
  const irs = field('IRS file name (optional)', input('e.g. f1040s2', pre.irsFile || '', 20), 'The name of the PDF on irs.gov, without “.pdf”. Dropped files with this name are sorted here, and a download link is shown.');
  const repeat = field('Pages that can be added several times (optional)', input('e.g. 2', '', 20), 'Page numbers, separated by commas, as Form 8938 does for page 2.');
  repeat.inputMode = 'numeric';
  wrap.append(grid);
  const msg = el('p', 'msg'); msg.setAttribute('role', 'alert');
  const btn = el('button', 'btn primary', 'Add form'); btn.type = 'submit';
  const btns = el('div', 'btns'); btns.append(btn); wrap.append(msg, btns);
  const files = el('p', 'files'); files.append('The list is kept in ', el('code', '', 'data/forms.json'), ', shared by everyone.'); wrap.append(files);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const n = name.value.trim().replace(/\s+/g, ' '), t = title.value.trim().replace(/\s+/g, ' '), f = irs.value.trim().toLowerCase().replace(/\.pdf$/, '');
    const pages = repeat.value.split(/[\s,;]+/).filter(Boolean);
    const fail = (text, at) => { msg.textContent = text; at.focus(); };
    if (!n) return fail('Enter a name.', name);
    if (!t) return fail('Enter the title printed on the form.', title);
    if (S.forms.some((x) => x.name.toLowerCase() === n.toLowerCase())) return fail(`There is already a form called ${n}.`, name);
    if (f && !/^[a-z0-9_-]+$/.test(f)) return fail('The IRS file name has only letters and digits, like f1040s2.', irs);
    if (f && S.forms.some((x) => x.irsFile === f)) return fail(`${S.forms.find((x) => x.irsFile === f).name} already uses the IRS file name ${f}.`, irs);
    if (pages.some((p) => !/^\d{1,3}$/.test(p) || +p < 1)) return fail('Enter page numbers such as 2, or leave it empty.', repeat);
    const entry = { id: newFormId(n), name: n, title: t };
    if (f) entry.irsFile = f;
    entry.detect = escapeRe(t);
    if (pages.length) entry.repeatPages = [...new Set(pages.map(Number))].sort((a, b) => a - b);
    btn.disabled = true;
    S.forms.push(entry);
    try { await saveForms(); }
    catch (err) { S.forms.pop(); btn.disabled = false; return fail('Could not save: ' + err.message, name); }
    toast(`${n} added. Now add its blank PDF for ${S.year}.`);
    go(S.year, entry.id);
  };
  view.append(wrap); name.focus();
  status('');
}
async function removeForm(f) {
  if (!confirm(`Remove the section ${f.name} for everyone?\n\nYou can add it again later with “+ Add a form”.`)) return;
  const at = S.forms.indexOf(f);
  S.forms.splice(at, 1);
  try { await saveForms(); }
  catch (e) { S.forms.splice(at, 0, f); status('Could not save: ' + e.message, true); return; }
  toast(`${f.name} removed.`);
  go(S.year, S.forms[0].id);
}

/* ---------- navigation ---------- */
function go(year, formId, person = S.person) {
  const target = `#/${person}/${year || '-'}/${formId}`;
  if (location.hash === target) openSection(); else location.hash = target;
}
async function openSection() {
  await flushSave(); await flushRates();
  if (!S.people.length || S.tree.legacy.length) { ++S.gen; await teardown(); return showWelcome(); }
  const m = /^#\/([a-z0-9-]+)\/(\d{4}|-)\/([\w.-]+)$/.exec(location.hash);
  const person = m && S.people.some((p) => p.id === m[1]) ? m[1] : S.person || S.people[0].id;
  const personChanged = person !== S.person;
  if (personChanged) { usePerson(person); S.summaries = {}; }
  const mine = Object.keys(S.tree.years).sort();
  const everyone = Object.values(S.tree.people).flatMap((p) => Object.keys(p.years)).sort();
  // switching person keeps the year; a first visit opens the latest year there is
  const year = m && m[2] !== '-' ? m[2] : S.year || mine[mine.length - 1] || everyone[everyone.length - 1] || String(new Date().getFullYear() - 1);
  const formId = m && (RESERVED.includes(m[3]) || form(m[3])) ? m[3] : S.forms[0].id;
  const canonical = `#/${person}/${year}/${formId}`;
  if (location.hash !== canonical) history.replaceState(null, '', canonical);
  const gen = ++S.gen;
  const yearChanged = year !== S.year || personChanged;
  S.year = year; S.formId = formId;
  await teardown();
  renderPeople(); renderYears();
  $('folder').textContent = ''; $('folder').append('Saved as plain files in ', el('code', '', `${S.tree.folder || 'data'}/${S.person}`));
  if (yearChanged || !S.summaries[year]) { await loadSummaries(year); if (gen !== S.gen) return; }
  renderSidebar();
  if (formId === 'rates') { document.title = `Exchange rate ${year} · Taxodermy`; return showRates(); }
  if (formId === ADD_FORM) { document.title = 'Add a form · Taxodermy'; return showAddForm(); }
  document.title = `${personName()} · ${form().name} ${year} · Taxodermy`;
  if (!has(year, formId + '.pdf')) return showEmpty();
  await loadForm(gen);
}
async function teardown() {
  if (S.io) S.io.disconnect();
  if (S.pdf) { try { await S.pdf.loadingTask.destroy(); } catch {} }
  S.pdf = null; S.model = null; S.pages = []; S.base = null; S.basePages = []; S.copies = {}; S.carryCopies = null; S.carryPlan = null; S.prevYear = null; S.linked = null;
  S.values = new Map(); S.touched = new Set(); S.carried = new Map(); S.unmatched = {}; S.meta = {};
  $('formScroll').textContent = ''; $('pages').textContent = '';
  $('head').hidden = true; $('progress').hidden = true; $('carry').hidden = true; $('work').hidden = true; $('empty').hidden = true; $('ratesView').hidden = true; $('formView').hidden = true;
}

/* Store a blank PDF for the current person and write its first .json next to it. */
async function storeBlank(year, target, bytes, sourceName, model) {
  await api.put('data/' + D(year, target.id + '.pdf'), bytes, 'application/pdf');
  const old = has(year, target.id + '.json') ? (await api.json(D(year, target.id + '.json'))) || {} : {};
  const fresh = { person: S.person, form: target.id, formName: target.name, year: Number(year), pdf: `${target.id}.pdf`, values: {}, labels: {}, ...old, sourceName, savedAt: new Date().toISOString() };
  if (fresh.filledPdf) fresh.filledPdf = { ...fresh.filledPdf, stale: true }; // written from the PDF that is being replaced
  fresh.stats = { fields: model.fields.size, filled: 0, toCheck: 0, ...(old.stats && old.stats.fields === model.fields.size ? old.stats : {}) };
  await api.put('data/' + D(year, target.id + '.json'), JSON.stringify(fresh, null, 2), 'application/json');
}
/* Copy blank forms of this year from someone else. A PDF that already holds entries is never copied. */
async function copyBlanks(from, formIds) {
  const year = S.year; let done = 0; const refused = [];
  status('Copying…');
  for (const id of formIds) {
    try {
      const bytes = await api.bytes(D(year, id + '.pdf', from));
      const info = await readPdf(bytes.slice(), false);
      if ([...info.model.fields.values()].some((f) => isFilled(f.initial))) { refused.push(form(id).name); continue; }
      await storeBlank(year, form(id), bytes, `copied from ${personName(from)}`, info.model); done++;
    } catch (e) { status(`Could not copy ${form(id).name}: ${e.message}`, true); }
  }
  await refreshTree(); await loadSummaries(year);
  const no = refused.length ? ` Not copied: ${refused.join(', ')} — that PDF already contains ${personName(from)}'s entries, so add a blank one instead.` : '';
  toast((done ? `${plural(done, 'blank form', 'blank forms')} copied from ${personName(from)}.` : 'Nothing was copied.') + no);
  openSection();
}

/* A section that has no PDF for this year yet. */
function showEmpty() {
  const f = form(), y = S.year;
  const box = $('empty'); box.textContent = ''; box.hidden = false;
  const d = el('div', 'drop');
  d.append(el('h1', '', `${f.name} for ${y}`), el('p', '', `${f.title}. Add the blank, fillable PDF for tax year ${y}; it is stored in ${personName()}'s ${y} folder and turned into a form you can fill in here.`));
  const btns = el('div', 'btns');
  const pick = el('button', 'btn primary', 'Choose PDF'); pick.type = 'button'; pick.onclick = () => { pickTarget = f.id; $('file').click(); };
  btns.append(pick);
  // someone else already has this year's blank forms
  const others = S.people.filter((p) => p.id !== S.person && (S.tree.people[p.id] || { years: {} }).years[y]);
  const donor = others.find((p) => (f.id + '.pdf') in S.tree.people[p.id].years[y]);
  if (donor) {
    const b = el('button', 'btn', `Use ${donor.name}'s ${y} PDF`); b.type = 'button'; b.title = 'Copies the blank form, never the entries';
    b.onclick = () => copyBlanks(donor.id, [f.id]); btns.append(b);
  }
  const bulk = others.map((p) => ({ p, ids: S.forms.filter((x) => (x.id + '.pdf') in S.tree.people[p.id].years[y] && !has(y, x.id + '.pdf')).map((x) => x.id) })).sort((a, b) => b.ids.length - a.ids.length)[0];
  if (bulk && bulk.ids.length > 1) {
    const b = el('button', 'btn', `Copy all ${bulk.ids.length} blank ${y} forms from ${bulk.p.name}`); b.type = 'button'; b.title = 'Copies the blank forms, never the entries';
    b.onclick = () => copyBlanks(bulk.p.id, bulk.ids); btns.append(b);
  }
  const other = nearestYearWith(f.id + '.pdf');
  if (other) {
    const again = el('button', 'btn', `Use the ${other} PDF again`); again.type = 'button';
    again.title = 'For forms the IRS did not change between these years';
    again.onclick = async () => {
      try {
        const bytes = await api.bytes(D(other, f.id + '.pdf'));
        await api.put('data/' + D(y, f.id + '.pdf'), bytes, 'application/pdf');
        await refreshTree(); openSection();
      } catch (e) { status('Could not copy the PDF: ' + e.message, true); }
    };
    btns.append(again);
  }
  d.append(btns);
  if (S.forms.length > 1 && !formInUse(f.id)) {
    const rm = el('button', 'btn quiet', 'Remove this section'); rm.type = 'button';
    rm.title = 'Nobody has a PDF or entries for this form yet, so nothing is lost';
    rm.onclick = () => removeForm(f);
    const r = el('div', 'btns remove'); r.append(rm); d.append(r);
  }
  if (f.irsFile) {
    const s = el('small'); const a = el('a', '', `irs.gov/pub/irs-pdf/${f.irsFile}.pdf`);
    a.href = `https://www.irs.gov/pub/irs-pdf/${f.irsFile}.pdf`; a.target = '_blank'; a.rel = 'noopener';
    s.append('Current blank form: ', a, ' · earlier years are under “Prior year forms” on irs.gov');
    d.append(s);
  }
  box.append(d);
  status('');
}
function nearestYearWith(name, onlyEarlier) {
  const ys = Object.keys(S.tree.years).filter((y) => y !== S.year && has(y, name) && (!onlyEarlier || y < S.year));
  ys.sort((a, b) => (Math.abs(a - S.year) - Math.abs(b - S.year)) || (a < b ? -1 : 1));
  if (onlyEarlier) ys.sort((a, b) => b - a);
  return ys[0] || null;
}

/* ---------- load one form of one year ---------- */
async function loadForm(gen) {
  const { year, formId } = S;
  $('work').hidden = false;
  $('formScroll').append(note('Reading the form…', `${form().name} · ${year}`));
  status('Reading…');
  try {
    const [bytes, saved] = await Promise.all([api.bytes(D(year, formId + '.pdf')), has(year, formId + '.json') ? api.json(D(year, formId + '.json')) : null]);
    const doc = await readPdf(bytes, true);
    if (gen !== S.gen) { doc.pdf.loadingTask.destroy(); return; }
    S.pdf = doc.pdf; S.basePages = doc.pages; S.base = doc.model; S.meta = saved || {};
    S.copies = cleanCopies(S.meta.pageCopies, form().repeatPages, doc.pages.length);
    applyModel();
    S.initial = new Map(); S.values = new Map();
    for (const f of S.model.fields.values()) { S.initial.set(f.name, f.initial); S.values.set(f.name, f.initial); }
    for (const [name, v] of Object.entries(S.meta.values || {})) {
      if (S.model.fields.has(name)) { S.values.set(name, v); S.touched.add(name); } else S.unmatched[name] = v;
    }
    for (const [name, y] of Object.entries(S.meta.carried || {})) if (S.model.fields.has(name) && isFilled(S.values.get(name))) S.carried.set(name, String(y));
    build();
    if (!saved || !saved.stats || saved.stats.fields !== S.model.fields.size) { dirty = true; await flushSave(); }
    else status(`Loaded data/${D(year, formId + '.json')}`);
    prepareCarry(gen);
  } catch (e) {
    if (gen !== S.gen) return;
    console.error(e);
    $('formScroll').textContent = '';
    $('formScroll').append(note('This PDF could not be opened', (e && e.message) || String(e)));
    status('Could not open the PDF', true);
  }
}

/* ---------- repeatable pages (e.g. Form 8938 page 2, one per account) ---------- */
const pageTitle = (p) => `Page ${p.real + 1}` + (p.copy ? ` · copy ${p.copy}` : '');
const canRepeat = (pageNo) => (form().repeatPages || []).includes(pageNo);
function applyModel() {
  const x = expandModel(S.base, S.basePages.length, S.copies);
  S.model = { widgets: x.widgets, fields: x.fields };
  S.pages = x.pages.map((pg, index) => ({ index, real: pg.real, copy: pg.copy, page: S.basePages[pg.real].page, viewport: S.basePages[pg.real].viewport }));
}
function rebuild(showPage) {
  applyModel();
  for (const f of S.model.fields.values()) if (!S.values.has(f.name)) { S.values.set(f.name, f.initial); S.initial.set(f.name, f.initial); }
  build();
  const p = showPage && S.pages.find((x) => x.real === showPage.real && x.copy === showPage.copy);
  if (p) {
    $('formScroll').querySelector(`.pg[data-page="${p.index}"]`)?.scrollIntoView({ block: 'start' });
    p.box?.scrollIntoView({ block: 'start' });
  }
}
function addCopy(pageNo) {
  S.copies[pageNo] = (S.copies[pageNo] || 0) + 1;
  markChanged(); rebuild({ real: pageNo - 1, copy: S.copies[pageNo] + 1 }); scheduleSave();
  remindStatements(`Copy ${S.copies[pageNo] + 1} of page ${pageNo} added.`);
}
function removeCopy(pageNo, k) {
  const total = S.copies[pageNo] || 0, last = total + 1;
  const names = [...new Set(S.base.widgets.filter((w) => w.page === pageNo - 1).map((w) => w.name))];
  if (names.some((n) => isFilled(S.values.get(n + SEP + k))) && !confirm(`Remove copy ${k} of page ${pageNo} and everything entered on it?`)) return;
  const move = (from, to) => {
    if (S.values.has(from)) S.values.set(to, S.values.get(from)); else S.values.delete(to);
    if (S.touched.has(from)) S.touched.add(to); else S.touched.delete(to);
    if (S.carried.has(from)) S.carried.set(to, S.carried.get(from)); else S.carried.delete(to);
  };
  for (const n of names) {
    for (let i = k; i < last; i++) move(n + SEP + (i + 1), n + SEP + i); // later copies move up
    for (const m of [S.values, S.initial, S.touched, S.carried]) m.delete(n + SEP + last);
  }
  if (total > 1) S.copies[pageNo] = total - 1; else delete S.copies[pageNo];
  markChanged(); rebuild({ real: pageNo - 1, copy: Math.min(k, last - 1) > 1 ? Math.min(k, last - 1) : 0 }); scheduleSave();
  remindStatements(`Copy ${k} of page ${pageNo} removed.`);
}
/* Forms that take extra pages usually ask on page 1 how many were attached. Offer to keep that in step. */
function remindStatements(msg) {
  const n = Object.values(S.copies).reduce((a, b) => a + b, 0);
  const num = S.base.widgets.find((w) => w.type === 'text' && /number of (additional|continuation) (statements|sheets)/i.test(w.label));
  const box = S.base.widgets.find((w) => isBtn(w.type) && /attached (additional|continuation) (statements|sheets)/i.test(w.label));
  const want = n ? String(n) : '';
  if (!num || (S.values.get(num.name) || '') === want) return toast(msg);
  toast(`${msg} Page ${num.page + 1} asks for “${num.label}”.`, { label: n ? `Set it to ${n}` : 'Clear it', run: () => {
    setValue(num.name, want);
    if (box) setValue(box.name, n ? box.onValue : 'Off');
  } });
}

/* ---------- build both views ---------- */
function build() {
  if (S.io) S.io.disconnect();
  const { widgets, fields } = S.model;
  S.controls = new Map(); S.rows = new Map(); S.overlays = new Map();
  const reg = (name, c) => { let a = S.controls.get(name); if (!a) S.controls.set(name, (a = [])); a.push(c); };

  const formRoot = $('formScroll'); formRoot.textContent = '';
  const frag = document.createDocumentFragment();
  let lastCtx = null;
  for (const p of S.pages) {
    const ws = widgets.filter((w) => w.page === p.index && (isBtn(w.type) || fields.get(w.name).widgets[0] === w));
    if (!ws.length) continue;
    const sec = el('section', 'pg'); sec.dataset.page = p.index;
    const h = el('h2', '', pageTitle(p));
    if (p.copy) { const b = el('button', 'btn quiet', 'Remove this copy'); b.type = 'button'; b.onclick = () => removeCopy(p.real + 1, p.copy); h.append(b); }
    else if (canRepeat(p.real + 1)) { const b = el('button', 'btn', '+ Add a copy of this page'); b.type = 'button'; b.title = 'For another account or asset: the same page again, with its own entries'; b.onclick = () => addCopy(p.real + 1); h.append(b); }
    h.append(el('span', '', '')); sec.append(h);
    for (const w of ws) {
      const row = el('label', 'row' + (isBtn(w.type) ? ' chk' : ''));
      row.dataset.wid = w.id;
      row.dataset.search = [w.line, w.label, w.context, w.name.split('.').pop()].join(' ').toLowerCase();
      row.append(el('span', 'ln', w.line || ''));
      const lbl = el('span', 'lbl');
      if (w.context && w.context !== lastCtx) lbl.append(el('small', '', w.context));
      lastCtx = w.context || null;
      lbl.append(el('span', '', w.label));
      const chip = el('button', 'chip'); chip.type = 'button'; chip.dataset.keep = w.name;
      chip.title = 'Carried over from an earlier year. Click to confirm it is still right.';
      lbl.append(chip);
      const c = makeControl(w, false);
      if (isBtn(w.type)) row.append(c, lbl); else row.append(lbl, c);
      reg(w.name, c);
      S.rows.set(w.id, row);
      sec.append(row);
    }
    frag.append(sec);
  }
  formRoot.append(frag);
  if (!widgets.length) {
    formRoot.append(note('No fillable fields in this PDF', 'This is a flat document (print-only or scanned). Use the fillable version from irs.gov and choose “Replace PDF…”.'));
  }

  const pagesRoot = $('pages'); pagesRoot.textContent = '';
  S.io = new IntersectionObserver((list) => {
    for (const en of list) { const p = S.pages[+en.target.dataset.page]; if (!p) continue; p.visible = en.isIntersecting; if (p.visible) queueRender(p); }
  }, { root: $('pageScroll'), rootMargin: '500px' });
  for (const p of S.pages) {
    const box = el('div', 'page'); box.dataset.page = p.index;
    const canvas = el('canvas'); const layer = el('div', 'layer');
    box.append(el('span', 'num', pageTitle(p)), canvas, layer);
    for (const w of widgets) {
      if (w.page !== p.index) continue;
      const c = makeControl(w, true);
      const vw = p.viewport.width, vh = p.viewport.height;
      c.style.left = (w.x0 / vw) * 100 + '%'; c.style.top = (w.y0 / vh) * 100 + '%';
      c.style.width = ((w.x1 - w.x0) / vw) * 100 + '%'; c.style.height = ((w.y1 - w.y0) / vh) * 100 + '%';
      layer.append(c); reg(w.name, c); S.overlays.set(w.id, c);
    }
    p.box = box; p.canvas = canvas; p.renderedScale = 0; p.visible = false;
    pagesRoot.append(box); S.io.observe(box);
  }

  $('head').hidden = false; $('progress').hidden = !widgets.length;
  $('docName').textContent = `${form().name} · ${S.year}`;
  for (const id of ['clearBtn', 'saveBtn']) $(id).disabled = !widgets.length;
  $('search').value = ''; setShow('all');
  layoutPages();
  for (const name of S.controls.keys()) paint(name);
  refreshCounts();
}

function makeControl(w, overlay) {
  let c;
  const h = w.y1 - w.y0, wd = w.x1 - w.x0;
  if (isBtn(w.type)) {
    c = el('input'); c.type = 'checkbox'; c.dataset.on = w.onValue;
  } else if (w.type === 'select') {
    c = el('select'); c.multiple = w.multiSelect;
    if (!w.multiSelect) c.append(new Option('', ''));
    for (const o of w.options) c.append(new Option(o.text, o.value));
  } else if (w.multiLine) {
    c = el('textarea'); if (!overlay) c.rows = 3;
  } else {
    c = el('input'); c.type = w.password ? 'password' : 'text';
    c.autocomplete = 'off'; c.spellcheck = false;
  }
  if (w.type === 'text') {
    if (w.maxLen) c.maxLength = w.maxLen;
    if (w.hint) { c.placeholder = w.hint; if (overlay) c.classList.add('hinted'); }
    if (w.comb && w.maxLen) c.classList.add('comb');
  }
  c.dataset.name = w.name; c.dataset.wid = w.id;
  if (w.readOnly) c.disabled = true;
  if (overlay) {
    c.classList.add('w');
    c.setAttribute('aria-label', w.label); c.title = (w.line ? w.line + ' · ' : '') + w.label;
    c.tabIndex = -1; // tab order lives in the form list; the page stays clickable
    if (!isBtn(w.type)) {
      let f = w.multiLine ? 9 : Math.max(4.5, Math.min(10, h * 0.7));
      if (w.comb && w.maxLen) {
        const cell = wd / w.maxLen;
        f = Math.min(f, cell / 0.72);
        const gap = cell - 0.6 * f;
        c.style.letterSpacing = `calc(var(--s) * ${gap.toFixed(3)}px)`;
        c.style.paddingLeft = `calc(var(--s) * ${(gap / 2).toFixed(3)}px)`;
      }
      c.style.fontSize = `calc(var(--s) * ${f.toFixed(2)}px)`;
    }
  }
  return c;
}

/* ---------- values ---------- */
function readControl(c) {
  if (c.type === 'checkbox') return c.checked ? c.dataset.on : 'Off';
  if (c.multiple) return [...c.selectedOptions].map((o) => o.value);
  return c.value;
}
function paint(name, except) {
  const v = S.values.get(name);
  const filled = isFilled(v);
  const from = S.carried.get(name);
  for (const c of S.controls.get(name) || []) {
    if (c !== except) {
      if (c.type === 'checkbox') c.checked = v === c.dataset.on;
      else if (c.multiple) for (const o of c.options) o.selected = Array.isArray(v) && v.includes(o.value);
      else if (c.value !== v) c.value = v ?? '';
    }
    const on = c.type === 'checkbox' ? c.checked : filled;
    c.classList.toggle('filled', on);
    c.classList.toggle('carried', !!from && on);
    const row = c.closest('.row');
    if (row) {
      row.classList.toggle('filled', on);
      row.classList.toggle('carried', !!from && on);
      if (from) row.querySelector('.chip').textContent = `from ${from} · keep`;
    }
  }
}
function setValue(name, v, except) {
  S.values.set(name, v); S.touched.add(name);
  S.carried.delete(name); // edited by hand: no longer just a carried-over value
  markChanged();
  paint(name, except); refreshCounts(); scheduleSave();
  if (S.show !== 'all') applyFilter(true);
}
function stats() {
  const fields = [...S.model.fields.values()];
  return { fields: fields.length, filled: fields.filter((f) => isFilled(S.values.get(f.name))).length, toCheck: S.carried.size };
}
function refreshCounts() {
  const st = stats(), pg = S.basePages.length, extra = S.pages.length - pg;
  const meta = $('docMeta');
  meta.textContent = `${plural(pg, 'page', 'pages')}${extra ? ` + ${plural(extra, 'copy', 'copies')}` : ''} · ${st.filled} of ${st.fields} fields filled` + (S.meta.sourceName ? ` · ${S.meta.sourceName}` : '');
  const fp = S.meta.filledPdf;
  if (fp && has(S.year, fp.file)) {
    const when = new Date(fp.savedAt);
    const a = el('a', fp.stale ? 'stale' : '', fp.stale ? `${fp.file} on disk is older than your entries` : `${fp.file} saved ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    a.href = 'data/' + D(S.year, fp.file); a.target = '_blank'; a.rel = 'noopener'; a.title = 'Open the saved PDF';
    meta.append(' · ', a);
  }
  $('progress').firstElementChild.style.width = st.fields ? (st.filled / st.fields) * 100 + '%' : '0';
  for (const sec of document.querySelectorAll('.pg')) {
    sec.querySelector('h2 > span').textContent = `${sec.querySelectorAll('.row.filled').length} / ${sec.querySelectorAll('.row').length}`;
  }
  const sc = $('showCarried'); sc.hidden = !st.toCheck; sc.textContent = `To check (${st.toCheck})`;
  if (!st.toCheck && S.show === 'carried') setShow('all');
  renderCarry();
}

/* ---------- saving: data/<year>/<form>.json ---------- */
let saveTimer = null, dirty = false, saveChain = Promise.resolve();
function snapshot() {
  const values = {}, labels = {};
  for (const name of S.touched) {
    const f = S.model.fields.get(name); if (!f) continue;
    const v = S.values.get(name);
    if (!isFilled(v) && !isFilled(S.initial.get(name))) continue;
    values[name] = v;
    const w = isBtn(f.type) ? f.widgets.find((x) => x.onValue === v) || f.widgets[0] : f.widgets[0];
    labels[name] = [f.copy && `Page ${S.pages[w.page].real + 1} copy ${f.copy}`, w.line && 'Line ' + w.line, w.context, w.label].filter(Boolean).join(' · ');
  }
  const out = {
    person: S.person, form: S.formId, formName: form().name, year: Number(S.year), pdf: `${S.formId}.pdf`,
    sourceName: S.meta.sourceName || undefined, savedAt: new Date().toISOString(),
    stats: stats(), values, labels,
  };
  if (S.carried.size) out.carried = Object.fromEntries(S.carried);
  if (S.meta.carryDismissed) out.carryDismissed = S.meta.carryDismissed;
  if (S.meta.filledPdf) out.filledPdf = S.meta.filledPdf;
  if (Object.keys(S.copies).length) out.pageCopies = S.copies;
  if (Object.keys(S.unmatched).length) out.unmatched = S.unmatched;
  return out;
}
function scheduleSave() {
  dirty = true; status('Saving…');
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !S.model) return saveChain;
  dirty = false;
  const { person, year, formId } = S; const snap = snapshot();
  saveChain = saveChain.then(async () => {
    try {
      await api.put('data/' + D(year, formId + '.json', person), JSON.stringify(snap, null, 2), 'application/json');
      treeYear(year, person)[formId + '.json'] = 1;
      if (person === S.person) { (S.summaries[year] ??= {})[formId] = snap; if (year === S.year) renderSidebar(); }
      if (!dirty) status(`Saved · data/${D(year, formId + '.json', person)} · ${clock()}`);
    } catch (e) {
      dirty = true;
      status('NOT SAVED — is the server still running? (' + e.message + ')', true);
    }
  });
  return saveChain;
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flushSave(); flushRates(); } });
addEventListener('beforeunload', (e) => { if (dirty || ratesDirty) { flushSave(); flushRates(); e.preventDefault(); e.returnValue = ''; } });

function clearAll() {
  markChanged();
  for (const f of S.model.fields.values()) {
    if (f.readOnly) continue;
    S.values.set(f.name, isBtn(f.type) ? 'Off' : f.type === 'select' && f.widgets[0].multiSelect ? [] : '');
    S.touched.add(f.name); S.carried.delete(f.name); paint(f.name);
  }
  S.meta.carryDismissed = undefined;
  refreshCounts(); applyFilter(true); scheduleSave(); prepareCarry(S.gen);
  toast('All fields in this form are empty now.');
}

/* ---------- carry over from the previous year ---------- */
async function prepareCarry(gen) {
  S.carryPlan = null; S.carryError = null; S.carryReport = false;
  const { formId } = S;
  const prev = Object.keys(S.tree.years).filter((y) => y < S.year && has(y, formId + '.pdf')).sort().pop();
  S.prevYear = prev || null;
  const btn = $('carryBtn'); btn.hidden = !prev; btn.textContent = prev ? `Carry over from ${prev}` : '';
  if (!prev) return renderCarry();
  try {
    const [bytes, old] = await Promise.all([api.bytes(D(prev, formId + '.pdf')), has(prev, formId + '.json') ? api.json(D(prev, formId + '.json')) : null]);
    const oldDoc = await readPdf(bytes, false);
    if (gen !== S.gen) return;
    // last year's answers = what was typed here, plus anything already filled in inside that PDF
    const oldValues = {};
    for (const f of oldDoc.model.fields.values()) if (isFilled(f.initial)) oldValues[f.name] = f.initial;
    Object.assign(oldValues, (old && old.values) || {});
    // extra page copies (accounts) of last year are matched copy for copy; missing ones are added on carry-over
    const oldCopies = cleanCopies(old && old.pageCopies, form().repeatPages, oldDoc.pageCount);
    const want = { ...S.copies };
    for (const [p, n] of Object.entries(oldCopies)) if (Number(p) <= S.basePages.length) want[p] = Math.max(want[p] || 0, n);
    S.carryCopies = want;
    S.carryPlan = plan(entries(expandModel(oldDoc.model, oldDoc.pageCount, oldCopies), prev), entries(expandModel(S.base, S.basePages.length, want), S.year), oldValues, S.values);
  } catch (e) {
    if (gen !== S.gen) return;
    console.error('carry-over check failed', e);
    S.carryError = (e && e.message) || String(e);
  }
  renderCarry();
}
const HOW = { line: 'line renumbered', similar: 'wording changed' };
function carryTable(rows, withNote) {
  const wrap = el('div', 'list'); const table = el('table');
  for (const t of rows) {
    const tr = el('tr'); const td = el('td', '', t.label);
    if (withNote && t.how !== 'exact') { const sm = el('small', '', `${HOW[t.how]} · ${S.prevYear}: ${t.fromLabel}`); td.append(sm); }
    const f = t.name && (S.model.fields.get(t.name) || S.base.fields.get(t.name.split(SEP)[0]));
    tr.append(td, el('td', '', t.value === true || (f && isBtn(f.type)) ? '✓' : Array.isArray(t.value) ? t.value.join(', ') : String(t.value))); table.append(tr);
  }
  wrap.append(table); return wrap;
}
function unmatchedDetails(p) {
  if (!p || !p.unmatched.length) return null;
  const det = el('details');
  det.append(el('summary', '', `${plural(p.unmatched.length, 'value', 'values')} from ${S.prevYear} ${p.unmatched.length === 1 ? 'has' : 'have'} no matching field in ${S.year} — copy by hand if still needed`));
  det.append(carryTable(p.unmatched, false));
  return det;
}
function renderCarry() {
  const box = $('carry'); box.textContent = '';
  const prev = S.prevYear, p = S.carryPlan, n = S.carried.size;
  const add = (...nodes) => box.append(...nodes.filter(Boolean));
  const button = (cls, text, fn) => { const b = el('button', cls, text); b.type = 'button'; b.onclick = fn; return b; };
  box.hidden = false;
  if (n) {
    const from = [...new Set(S.carried.values())].join(', ');
    add(el('span', '', `${plural(n, 'value was', 'values were')} carried over from ${from}. Check each one — it is last year's answer — then click its “keep” tag or type over it.`),
      button('btn', 'Show only these', () => { $('search').value = ''; setShow('carried'); }),
      button('btn', 'Keep all', () => { const names = [...S.carried.keys()]; S.carried.clear(); names.forEach((x) => paint(x)); refreshCounts(); scheduleSave(); }),
      button('btn quiet', 'Undo carry-over', undoCarry), unmatchedDetails(p));
    return;
  }
  if (prev && S.carryError && S.carryReport) {
    add(el('span', '', `The ${prev} form could not be compared with this one (${S.carryError}).`), button('btn quiet', 'Close', () => { S.carryReport = false; renderCarry(); }));
    return;
  }
  const offer = prev && p && p.transfers.length && (S.carryReport || String(S.meta.carryDismissed) !== prev);
  if (offer) {
    const parts = [`${p.exact} identical`]; if (p.renumbered) parts.push(`${p.renumbered} renumbered`); if (p.similar) parts.push(`${p.similar} reworded`);
    add(el('span', '', `${p.identical} of the ${p.oldTotal} fields on the ${prev} form have a counterpart here (${parts.join(', ')}). ${plural(p.transfers.length, 'value', 'values')} from ${prev} can be carried into fields that are still empty.`),
      button('btn primary', `Carry over ${plural(p.transfers.length, 'value', 'values')}`, applyCarry),
      button('btn quiet', 'Not now', () => { S.meta.carryDismissed = prev; S.carryReport = false; renderCarry(); scheduleSave(); }));
    const det = el('details'); det.append(el('summary', '', 'See what would be copied'), carryTable(p.transfers, true));
    add(det, unmatchedDetails(p));
    return;
  }
  if (prev && p && S.carryReport) {
    const why = !p.oldFilled ? `The ${prev} form has no entries yet, so there is nothing to carry over.`
      : p.unmatched.length === p.oldFilled ? `None of the ${plural(p.oldFilled, 'value', 'values')} entered for ${prev} has a matching field on this form.`
      : `Nothing more to carry over: every ${prev} value with a matching field is already filled in here.`;
    add(el('span', '', why), button('btn quiet', 'Close', () => { S.carryReport = false; renderCarry(); }), unmatchedDetails(p));
    return;
  }
  box.hidden = true;
}
function applyCarry() {
  markChanged();
  const p = S.carryPlan, prev = S.prevYear;
  if (!p || !p.transfers.length) { toast(prev ? `Nothing to carry over: no ${prev} value belongs to an identical field that is still empty here.` : 'There is no earlier year for this form yet.'); return; }
  if (p.transfers.some((t) => !S.model.fields.has(t.name)) && S.carryCopies) { S.copies = { ...S.carryCopies }; rebuild(); }
  let n = 0;
  for (const t of p.transfers) {
    if (!S.model.fields.has(t.name) || isFilled(S.values.get(t.name))) continue;
    S.values.set(t.name, t.value); S.touched.add(t.name); S.carried.set(t.name, prev); paint(t.name); n++;
  }
  S.carryPlan = { ...p, transfers: [] }; S.carryReport = false;
  refreshCounts(); scheduleSave();
  toast(`${plural(n, 'value', 'values')} carried over from ${prev}.`);
}
function undoCarry() {
  markChanged();
  for (const name of [...S.carried.keys()]) {
    const f = S.model.fields.get(name);
    S.values.set(name, isBtn(f.type) ? 'Off' : f.type === 'select' && f.widgets[0].multiSelect ? [] : '');
    S.carried.delete(name); paint(name);
  }
  S.meta.carryDismissed = S.prevYear;
  refreshCounts(); applyFilter(); scheduleSave();
  prepareCarry(S.gen);
}

/* ---------- adding PDFs ---------- */
let pickTarget = null;
async function addPdfs(files, targetId) {
  const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) { toast('Drop PDF files.'); return; }
  if (!S.person) { toast('Add a person first.'); return; }
  await flushSave();
  const year = S.year; let lastId = null, added = 0;
  for (const file of pdfs) {
    status(`Reading ${file.name}…`);
    let bytes, info;
    try { bytes = new Uint8Array(await file.arrayBuffer()); info = await readPdf(bytes.slice(), false); }
    catch (e) { toast(`${file.name} could not be read as a PDF.`); continue; }
    const guess = guessForm(file.name, info.header);
    let target = targetId ? form(targetId) : guess;
    if (targetId && guess && guess.id !== targetId && confirm(`${file.name} looks like ${guess.name} (${guess.title}), not ${target.name}.\n\nOK = file it under ${guess.name}\nCancel = keep it under ${target.name}`)) target = guess;
    if (!target && pdfs.length === 1 && !has(year, S.formId + '.pdf')) target = form();
    if (!target) {
      const base = file.name.replace(/\.pdf$/i, '');
      toast(`Could not tell which form ${file.name} is. Open its section and use “Choose PDF” there.`,
        { label: 'Add a form for it', run: () => { S.addPrefill = { irsFile: /^f[a-z0-9]+$/i.test(base) ? base.toLowerCase() : '' }; go(year, ADD_FORM); } });
      continue;
    }
    const y = guessYear(info.all);
    if (y && y !== year && !confirm(`${file.name} looks like the ${y} revision of ${target.name}, but you are working on ${year}.\n\nAdd it to ${year} anyway?`)) continue;
    if (has(year, target.id + '.pdf') && !confirm(`${target.name} already has a PDF for ${year}. Replace it?\n\nValues you entered are kept for every field that still exists in the new PDF.`)) continue;
    if (!info.model.widgets.length && !confirm(`${file.name} has no fillable fields (it is a flat or scanned PDF). Add it anyway?`)) continue;
    try {
      await storeBlank(year, target, bytes, file.name, info.model);
      lastId = target.id; added++;
    } catch (e) { status(`Could not store ${file.name}: ${e.message}`, true); }
  }
  if (!added) { status(''); return; }
  await refreshTree(); await loadSummaries(year);
  toast(added === 1 ? `${form(lastId).name} added to ${year}.` : `${added} forms added to ${year}.`);
  go(year, added === 1 ? lastId : (has(year, S.formId + '.pdf') ? S.formId : lastId));
}

/* Write the filled PDF next to the blank one: data/<year>/<form>-filled.pdf */
async function savePdf() {
  const btn = $('saveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  const { person, year, formId } = S; const file = `${formId}-filled.pdf`; const where = D(year, file, person);
  try {
    const st = S.pdf.annotationStorage;
    const put = (w) => { const v = S.values.get(w.name); st.setValue(w.baseId, { value: isBtn(w.type) ? v === w.onValue : v }); };
    // every extra copy: the same form saved once more with that copy's values on its page
    const copies = [];
    for (const cp of S.pages.filter((x) => x.copy)) {
      for (const w of S.model.widgets) if (w.page === cp.index && !w.readOnly) put(w);
      copies.push({ pageIndex: cp.real, bytes: await S.pdf.saveDocument() });
    }
    const repeated = new Set(copies.map((c) => c.pageIndex));
    for (const w of S.model.widgets) {
      if (w.copy || w.readOnly) continue;
      if (S.touched.has(w.name) || repeated.has(S.pages[w.page].real)) put(w); // also puts the original page back after its copies
    }
    let bytes = await S.pdf.saveDocument();
    if (copies.length) bytes = await mergeCopies(await import('./vendor/pdf-lib.esm.min.js'), bytes, copies);
    await api.put('data/' + where, bytes, 'application/pdf');
    treeYear(year, person)[file] = bytes.length;
    if (person !== S.person || year !== S.year || formId !== S.formId) return; // moved on while saving
    S.meta.filledPdf = { file, savedAt: new Date().toISOString() };
    dirty = true; await flushSave();
    refreshCounts();
    const unchecked = S.carried.size ? ` ${plural(S.carried.size, 'value is', 'values are')} still unchecked from ${[...new Set(S.carried.values())].join(', ')}.` : '';
    toast(`Saved to data/${where}.${unchecked}`, { label: 'Open', run: () => window.open('data/' + where, '_blank', 'noopener') });
  } catch (e) {
    console.error(e);
    toast('The filled PDF could not be saved (' + ((e && e.message) || e) + '). Your entries are still saved.');
    status('PDF NOT SAVED — ' + ((e && e.message) || e), true);
  } finally { btn.disabled = false; btn.textContent = 'Save to disk'; }
}
/* Entries changed after the PDF was written: the copy on disk no longer matches. */
function markChanged() { if (S.meta.filledPdf && !S.meta.filledPdf.stale) S.meta.filledPdf.stale = true; }

/* ---------- print every form of the year ---------- */
/* One form as it is stored on disk (blank PDF + .json), filled in. Returns { filled: 0 } when it has no entries. */
async function filledFromDisk(year, f, PDFLib) {
  const [raw, saved] = await Promise.all([api.bytes(D(year, f.id + '.pdf')), has(year, f.id + '.json') ? api.json(D(year, f.id + '.json')) : null]);
  const doc = await readPdf(raw, true);
  try {
    const x = expandModel(doc.model, doc.pages.length, cleanCopies(saved && saved.pageCopies, f.repeatPages, doc.pages.length));
    const values = new Map();
    for (const fld of x.fields.values()) values.set(fld.name, fld.initial);
    for (const [name, v] of Object.entries((saved && saved.values) || {})) if (x.fields.has(name)) values.set(name, v);
    const filled = [...x.fields.values()].filter((fld) => isFilled(values.get(fld.name))).length;
    if (!filled) return { filled: 0 };
    const st = doc.pdf.annotationStorage;
    const put = (w) => { const v = values.get(w.name); st.setValue(w.baseId, { value: isBtn(w.type) ? v === w.onValue : v }); };
    const copies = [];
    for (let index = 0; index < x.pages.length; index++) {
      if (!x.pages[index].copy) continue;
      for (const w of x.widgets) if (w.page === index && !w.readOnly) put(w);
      copies.push({ pageIndex: x.pages[index].real, bytes: await doc.pdf.saveDocument() });
    }
    for (const w of x.widgets) if (!w.copy && !w.readOnly) put(w); // every field, so each value gets a printable appearance
    let bytes = await doc.pdf.saveDocument();
    if (copies.length) bytes = await mergeCopies(PDFLib, bytes, copies);
    return { filled, bytes, toCheck: Object.keys((saved && saved.carried) || {}).length };
  } finally { try { await doc.pdf.loadingTask.destroy(); } catch {} }
}
let printUrl = null;
async function printYear() {
  const btn = $('printBtn'), year = S.year, who = personName();
  const todo = S.forms.filter((f) => has(year, f.id + '.pdf'));
  if (!todo.length) { toast(`${who} has no forms for ${year} yet.`); return; }
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    await flushSave(); await saveChain;
    const PDFLib = await import('./vendor/pdf-lib.esm.min.js');
    const docs = [], names = [], empty = []; let toCheck = 0;
    for (const f of todo) {
      status(`Preparing ${f.name}…`);
      const r = await filledFromDisk(year, f, PDFLib);
      if (!r.filled) { empty.push(f.name); continue; }
      docs.push(r.bytes); names.push(f.name); toCheck += r.toCheck || 0;
    }
    status('');
    if (!docs.length) { toast(`Nothing to print: none of the ${year} forms has an entry yet.`); return; }
    const out = await combineForPrint(PDFLib, docs, `${who} · ${year} · ${names.join(', ')}`);
    if (printUrl) URL.revokeObjectURL(printUrl);
    printUrl = URL.createObjectURL(new Blob([out.bytes], { type: 'application/pdf' }));
    // a hidden frame showing the PDF, then the browser's own print dialog
    let frame = document.getElementById('printFrame');
    if (frame) frame.remove();
    frame = el('iframe'); frame.id = 'printFrame'; frame.title = 'Print';
    let asked = false;
    frame.onload = () => { setTimeout(() => { try { frame.contentWindow.focus(); frame.contentWindow.print(); asked = true; } catch {} }, 300); };
    frame.src = printUrl; document.body.append(frame);
    // some browsers do not show a PDF inside a page; then the dialog never comes up by itself
    setTimeout(() => { if (!asked) toast('The print dialog did not open by itself in this browser.', { label: 'Open the PDF to print it', run: () => window.open(printUrl, '_blank') }); }, 5000);
    const extra = (empty.length ? ` Left out, no entries: ${empty.join(', ')}.` : '') + (toCheck ? ` ${plural(toCheck, 'carried-over value is', 'carried-over values are')} still unchecked.` : '');
    toast(`Printing ${names.join(', ')} for ${who}, ${year}: ${plural(out.pages, 'page', 'pages')}.${extra}`, { label: 'Open the PDF instead', run: () => window.open(printUrl, '_blank') });
  } catch (e) {
    console.error(e); status('');
    toast('The forms could not be prepared for printing (' + ((e && e.message) || e) + ').');
  } finally { btn.disabled = false; btn.textContent = `Print ${S.year}`; }
}

/* ---------- page rendering ---------- */
function layoutPages() {
  if (!S.pages.length) return;
  const pane = $('pageScroll');
  if (!pane.clientWidth) return;
  const maxW = Math.max(...S.pages.map((p) => p.viewport.width));
  const pad = parseFloat(getComputedStyle(pane).paddingLeft) * 2;
  const fit = Math.max(0.3, (pane.clientWidth - pad - 2) / maxW);
  S.scale = S.zoom === 'fit' ? fit : S.zoom;
  $('zoomPct').textContent = Math.round(S.scale * 100) + '%';
  for (const p of S.pages) {
    if (!p.box) continue;
    p.box.style.width = p.viewport.width * S.scale + 'px';
    p.box.style.height = p.viewport.height * S.scale + 'px';
    p.box.style.setProperty('--s', S.scale);
    if (p.visible) queueRender(p);
  }
}
function queueRender(p) {
  const gen = S.gen;
  S.renderChain = S.renderChain.then(async () => {
    if (gen !== S.gen || !p.visible) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = S.scale * dpr;
    scale = Math.min(scale, Math.sqrt(16e6 / (p.viewport.width * p.viewport.height))); // keep canvases under ~16 MP
    if (Math.abs(p.renderedScale - scale) < 0.01) return;
    const vp = p.page.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
    try {
      await p.page.render({ canvas: off, canvasContext: off.getContext('2d'), viewport: vp, annotationMode: S.lib.AnnotationMode.DISABLE }).promise;
    } catch (e) { if (gen === S.gen) console.warn('render failed', e); return; }
    if (gen !== S.gen) return;
    p.canvas.width = off.width; p.canvas.height = off.height;
    p.canvas.getContext('2d').drawImage(off, 0, 0);
    p.renderedScale = scale;
  });
}
function setZoom(z) { S.zoom = z; layoutPages(); }

/* ---------- filter / search ---------- */
function setShow(mode) {
  S.show = mode;
  for (const b of document.querySelectorAll('[data-show]')) b.setAttribute('aria-pressed', b.dataset.show === mode);
  applyFilter();
}
function applyFilter(keepFocused) {
  const terms = $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const sec of document.querySelectorAll('.pg')) {
    let any = false;
    for (const row of sec.querySelectorAll('.row')) {
      const stay = keepFocused && row.contains(document.activeElement);
      let ok = terms.every((t) => row.dataset.search.includes(t));
      if (ok && S.show === 'empty') ok = !row.classList.contains('filled') || stay;
      if (ok && S.show === 'filled') ok = row.classList.contains('filled') || stay;
      if (ok && S.show === 'carried') ok = row.classList.contains('carried') || stay;
      row.hidden = !ok; if (ok) { any = true; shown++; }
    }
    sec.hidden = !any;
  }
  let none = $('formScroll').querySelector('.note.nomatch');
  if (!shown && S.model && S.model.widgets.length) {
    if (!none) { none = note('Nothing to show', 'No field matches this search or filter.'); none.classList.add('nomatch'); $('formScroll').append(none); }
  } else if (none) none.remove();
}

/* ---------- linking the two views ---------- */
function link(wid, from) {
  if (S.linked) { S.linked.row?.classList.remove('linked'); S.linked.ov?.classList.remove('linked'); }
  const w = S.model.widgets.find((x) => x.id === wid); if (!w) return;
  const rowWid = S.rows.has(wid) ? wid : S.model.fields.get(w.name).widgets[0].id;
  const row = S.rows.get(rowWid), ov = S.overlays.get(wid);
  S.linked = { row, ov };
  if (from === 'form' && ov) { ov.classList.add('linked'); if ($('pagePane').offsetParent) ov.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
  if (from === 'page' && row) { row.classList.add('linked'); if (row.hidden) { $('search').value = ''; setShow('all'); } if ($('formPane').offsetParent) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

/* ---------- events ---------- */
document.addEventListener('input', (e) => {
  const c = e.target; if (!c.dataset || !c.dataset.name || !S.model) return;
  setValue(c.dataset.name, readControl(c), c.type === 'checkbox' ? null : c);
});
document.addEventListener('focusin', (e) => {
  const c = e.target; if (!c.dataset || !c.dataset.wid || !S.model) return;
  link(c.dataset.wid, c.classList.contains('w') ? 'page' : 'form');
});
document.addEventListener('click', (e) => {
  const chip = e.target.closest && e.target.closest('.chip'); if (!chip) return;
  e.preventDefault();
  S.carried.delete(chip.dataset.keep); paint(chip.dataset.keep); refreshCounts(); scheduleSave();
  if (S.show === 'carried') applyFilter();
});
$('formScroll').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
  e.preventDefault();
  const all = [...$('formScroll').querySelectorAll('.row:not([hidden]) [data-name]:not(:disabled)')];
  const next = all[all.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
  if (next) next.focus();
});
$('file').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; const t = pickTarget; pickTarget = null; addPdfs(files, t); };
$('replaceBtn').onclick = () => { pickTarget = S.formId; $('file').click(); };
$('saveBtn').onclick = savePdf;
$('carryBtn').onclick = () => {
  if (S.prevYear && !S.carryPlan && !S.carryError) { toast(`Still comparing with the ${S.prevYear} form…`); return; }
  S.carryReport = true; renderCarry(); $('carry').scrollIntoView({ block: 'nearest' });
};
$('clearBtn').onclick = () => { if (confirm(`Clear every field of ${form().name} for ${S.year}?`)) clearAll(); };
$('search').addEventListener('input', () => applyFilter());
for (const b of document.querySelectorAll('[data-show]')) b.onclick = () => setShow(b.dataset.show);
$('person').onchange = onPersonPicked;
$('printBtn').onclick = printYear;
function setView(v) {
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll('button[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === v);
  layoutPages();
}
for (const b of document.querySelectorAll('button[data-view]')) b.onclick = () => setView(b.dataset.view);
setView(matchMedia('(max-width: 1100px)').matches ? 'form' : 'split');
$('zoomIn').onclick = () => setZoom(Math.min(4, S.scale * 1.2));
$('zoomOut').onclick = () => setZoom(Math.max(0.3, S.scale / 1.2));
$('zoomFit').onclick = () => setZoom('fit');
let roTimer;
new ResizeObserver(() => { clearTimeout(roTimer); roTimer = setTimeout(() => { if (S.zoom === 'fit') layoutPages(); }, 80); }).observe($('pageScroll'));

let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  addPdfs(e.dataTransfer?.files || [], null);
});
addEventListener('hashchange', openSection);

/* ---------- start ---------- */
(async () => {
  try {
    await refreshTree();
    const cfg = S.tree.shared.includes('forms.json') ? await api.json('forms.json') : null;
    if (cfg && Array.isArray(cfg.forms) && cfg.forms.length) S.forms = cfg.forms.filter((f) => f && /^[\w.-]+$/.test(f.id || '') && !RESERVED.includes(f.id) && f.name).map((f) => ({ ...(DEFAULT_FORMS.find((d) => d.id === f.id) || {}), ...f }));
    await loadPeople();
    await loadRates();
    await openSection();
  } catch (e) {
    console.error(e);
    document.querySelector('.main').append(note('The file server is not reachable', 'Start it with “python3 server.py” (or “node server.js”) in the app folder and open the address it prints. Opening index.html directly cannot read or save files.'));
    status('Not connected', true);
  }
})();
