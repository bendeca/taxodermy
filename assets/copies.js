/* Repeatable pages: some forms (Form 8938, page 2) are filed with the same page several times,
 * one per account. A copy is the same PDF page with its own set of values.
 *
 * In the app a copy's fields are ordinary fields whose names carry a suffix, e.g.
 *   topmostSubform[0].Page2[0].f2_01[0]@@copy2
 * In the saved PDF a copy becomes an extra page right after the original. Its values are
 * printed onto the page (not fillable there any more); the app keeps them editable.
 */

export const SEP = '@@copy';
const isBtn = (t) => t === 'checkbox' || t === 'radio';
const blank = (w) => (isBtn(w.type) ? 'Off' : w.type === 'select' && w.multiSelect ? [] : '');

/* Sanitise { "2": 3 } (page number -> extra copies) against what the form allows. */
export function cleanCopies(raw, repeatPages, pageCount) {
  const out = {};
  for (const p of repeatPages || []) {
    const n = Math.floor(Number(raw && raw[p]));
    if (p >= 1 && p <= pageCount && n > 0) out[p] = Math.min(n, 60);
  }
  return out;
}

/* base model (+ extra copies per page number) -> display model.
 * Returns { widgets, fields, pages } where pages lists what to show, in order:
 * [{ real: 0, copy: 0 }, { real: 1, copy: 0 }, { real: 1, copy: 2 }, …]  (copy 0 = the original). */
export function expandModel(base, pageCount, copies) {
  const pages = [];
  for (let real = 0; real < pageCount; real++) {
    pages.push({ real, copy: 0 });
    for (let k = 2; k <= (copies[real + 1] || 0) + 1; k++) pages.push({ real, copy: k });
  }
  const widgets = [];
  pages.forEach((pg, index) => {
    for (const w of base.widgets) {
      if (w.page !== pg.real) continue;
      widgets.push(pg.copy
        ? { ...w, page: index, id: w.id + SEP + pg.copy, name: w.name + SEP + pg.copy, baseId: w.id, baseName: w.name, copy: pg.copy, initial: blank(w) }
        : { ...w, page: index, baseId: w.id, baseName: w.name, copy: 0 });
    }
  });
  const fields = new Map();
  for (const w of widgets) {
    let f = fields.get(w.name);
    if (!f) { f = { name: w.name, baseName: w.baseName, copy: w.copy, type: w.type, widgets: [], initial: w.initial, readOnly: w.readOnly }; fields.set(w.name, f); }
    f.widgets.push(w);
    if (isBtn(w.type) && w.initial !== 'Off') f.initial = w.initial;
  }
  for (const f of fields.values()) f.exclusive = isBtn(f.type) && new Set(f.widgets.map((w) => w.onValue)).size > 1;
  return { widgets, fields, pages };
}

/* Drop copy `k` of page `pageNo` from a values object and renumber the copies after it. */
export function removeCopyKeys(obj, baseNames, k, total) {
  const out = { ...obj };
  for (const name of baseNames) {
    for (let i = k; i <= total + 1; i++) {
      const next = out[name + SEP + (i + 1)];
      if (i <= total && next !== undefined) out[name + SEP + i] = next; else delete out[name + SEP + i];
    }
  }
  return out;
}

/* Print the current appearance of every form field into the page itself and drop the fields,
 * so the page looks the same in any viewer and can be moved into another document. */
function flattenPage(PDFLib, doc, page) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFStream, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return;
  const keep = [];
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i); const a = annots.lookup(i);
    if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) { keep.push(ref); continue; }
    // the appearance for the widget's current state
    const ap = a.lookupMaybe(PDFName.of('AP'), PDFDict);
    let n = ap ? ap.get(PDFName.of('N')) : undefined;
    let stream = n instanceof PDFRef ? doc.context.lookup(n) : n;
    if (stream instanceof PDFDict && !(stream instanceof PDFStream)) {
      const state = a.get(PDFName.of('AS'));
      n = state ? stream.get(state) : undefined;
      stream = n instanceof PDFRef ? doc.context.lookup(n) : n;
    }
    if (!(n instanceof PDFRef) || !(stream instanceof PDFStream)) continue; // empty field or unticked box: nothing to print
    const rect = a.lookup(PDFName.of('Rect'), PDFArray).asRectangle();
    const bb = stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray);
    const box = bb ? bb.asRectangle() : { x: 0, y: 0, width: rect.width, height: rect.height };
    if (!(box.width > 0) || !(box.height > 0) || !(rect.width > 0) || !(rect.height > 0)) continue;
    const sx = rect.width / box.width, sy = rect.height / box.height;
    const key = page.node.newXObject('Filled', n);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rect.x - box.x * sx, rect.y - box.y * sy), drawObject(key), popGraphicsState());
  }
  page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
}

/* Put the copies into the saved PDF.
 *   mainBytes  the filled form (all pages, still fillable)
 *   copies     [{ pageIndex, bytes }] in order; `bytes` is the same form saved with that copy's
 *              values in the fields of page `pageIndex`
 * Each copy page gets its field appearances drawn into the page content, loses its form
 * fields, and is inserted after the original page. */
export async function mergeCopies(PDFLib, mainBytes, copies) {
  const { PDFDocument, PDFName, PDFDict } = PDFLib;
  const main = await PDFDocument.load(mainBytes, { updateMetadata: false });
  // A hybrid XFA form describes a fixed set of pages; with extra pages only the plain form may remain.
  const acro = main.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acro) acro.delete(PDFName.of('XFA'));

  const inserted = new Map(); // pageIndex -> how many copies already follow it
  for (const c of copies) {
    const doc = await PDFDocument.load(c.bytes, { updateMetadata: false });
    flattenPage(PDFLib, doc, doc.getPage(c.pageIndex));
    const [copy] = await main.copyPages(doc, [c.pageIndex]);
    const after = (inserted.get(c.pageIndex) || 0) + 1;
    inserted.set(c.pageIndex, after);
    // earlier pages that already received copies shift this page's position
    let shift = 0; for (const [idx, n] of inserted) if (idx < c.pageIndex) shift += n;
    main.insertPage(c.pageIndex + shift + after, copy);
  }
  return main.save({ updateFieldAppearances: false });
}

/* Several filled forms -> one PDF for printing: every page with its entries printed on it. */
export async function combineForPrint(PDFLib, documents, title) {
  const { PDFDocument } = PDFLib;
  const out = await PDFDocument.create();
  if (title) out.setTitle(title);
  for (const bytes of documents) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const page of doc.getPages()) flattenPage(PDFLib, doc, page);
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
  }
  return { bytes: await out.save(), pages: out.getPageCount() };
}
