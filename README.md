# Taxodermy

*Stuffing last year's numbers into this year's forms.*

Every spring the IRS hands you the same forms as last year, with a few lines renumbered just to keep you on your toes. Taxodermy opens the official fillable PDFs as tidy forms in your browser, then carries last year's answers over into this year's forms. It matches fields by the label printed next to each box, not by internal field names that change every year. Keep returns for several people side by side, convert Swiss francs at the IRS yearly rate, and save the filled PDFs ready to print and sign. It does not do your taxes: you still decide every number, it just spares you the retyping.

**Made with Americans abroad in mind.** The forms that come set up are the usual expat set: Form 1040 with Schedules 1 and 3, Form 2555 (Foreign Earned Income), Form 1116 (Foreign Tax Credit) and Form 8938 (Foreign Financial Assets). That's only a starting point. Click **+ Add a form** to add any other IRS form, and remove the ones you don't need, so the list fits your own return.

> **Everything stays on your computer.** There is no cloud, no account, no tracking and no database. The app is a tiny server that listens only on your own machine (127.0.0.1), and your entries are plain files in the `data` folder. Nothing is ever uploaded or sent anywhere: the app makes no outside requests. The only time anything touches the internet is when you click a link to irs.gov yourself.

## Start

```
python3 server.py        # or: node server.js
```

Then open http://127.0.0.1:8040/ (it opens by itself). Options: `--port 8041`, `--data /path/to/folder`, `--no-open`.

Opening `index.html` directly does not work: a browser page cannot write files, which is all the small server is for. It listens on 127.0.0.1 only and needs nothing installed besides Python 3 or Node.

## Use

1. Pick the **person** at the top left. "Add a person…" in the same menu creates another one; each person has their own folder.
2. Pick the tax year (`+ Year` adds one for the selected person).
3. Each form has its own section on the left. Add the blank fillable PDF for that year with **Choose PDF**, or drop several PDFs anywhere and they are sorted into the right sections. If another person already has that year's blank forms, you can copy them with one click; a PDF that already contains someone's entries is never copied.
4. Type in the generated form or directly on the page. Every change is saved straight away.
5. When a form also exists in an earlier year of the same person, **Carry over from <year>** copies last year's values into matching fields that are still empty, and lists the values that found no match. Carried values are marked "from <year>" until you confirm or change them.
6. **Save to disk** writes your entries into a copy of the PDF in the same folder (`1040-filled.pdf` next to `1040.pdf`). If you change entries afterwards, the app tells you the copy on disk is out of date until you save again.
7. **Extra copies of a page.** Form 8938 takes one page 2 per account or asset. In its Page 2 section, **+ Add a copy of this page** gives you the same page again with its own entries; add as many as you need. In the saved PDF each copy follows page 2 with its entries printed on it.
8. **Print <year>** (top bar) puts every form of the selected person and year that has entries into one document, in the order of the sections, and opens the print dialog. It uses your current entries; nothing is written to disk.
9. **+ Add a form** (below the forms) adds a section for another IRS form, e.g. Schedule 2: enter its name, the title printed on the form and, optionally, the IRS file name (`f1040s2`). It shows up for every person and year. A section that nobody has a PDF or entries for yet has **Remove this section**.
10. **Exchange rate** (below the forms) holds the IRS yearly average rate for the Swiss franc, one number per tax year, shared by everyone. The converter in the sidebar turns CHF amounts into U.S. dollars at the selected year's rate.

## Files

```
index.html
assets/                  app code, styles, PDF engine (pdf.js)
server.py  server.js     the same tiny file server, twice
data/
  forms.json             the list of form sections (edit to add e.g. Schedule 2)
  people.json            the people and their display names
  rates.json             IRS yearly average CHF rate per tax year, for everyone
  ada-lovelace/          one folder per person
    2024/
      1040.pdf           the blank PDF added for 2024
      1040.json          what was entered: values, readable labels, counts
      1040-filled.pdf    the filled PDF, written by Save to disk
      2555.pdf  2555.json  …
    2025/
      …
  byron-lovelace/
    …
```

Back up or move your data by copying the `data` folder. It contains tax details unencrypted.

Renaming a person in the app changes the display name in `people.json`; the folder keeps its name.

**Coming from a version without people:** start the new `server.py` / `server.js`. The app finds the year folders directly under `data/`, asks whose returns they are, and moves them into that person's folder. Per-year `rates.json` files are merged into `data/rates.json`.

## How carry-over decides what matches

Internal PDF field names are renumbered by the IRS whenever a line is added, so they are not trusted. Fields are paired by what is printed next to them, in three steps:

1. **Identical**: same kind (text, tick box, list), same line number, same label.
2. **Renumbered**: same label, but the line got a letter (11 became 11a) or the surrounding question was reworded.
3. **Reworded**: same line, wording changed a little ("Add lines 12 and 13" became "Add lines 12e, 13a, and 13b"), or an unnumbered box whose text was only extended.

Years in a label are compared relative to the tax year. Anything ambiguous is left alone, for example a box that was split into two.

The values taken from the earlier year are what you typed here plus anything already filled in inside that year's PDF, so you can also add last year's completed return as the PDF. Only fields that are still empty are filled. Before copying, the app shows what would be copied (non-identical matches are marked) and which of last year's values found no matching field, so you can copy those by hand.

Labels are read from the text printed around each box, so check carried-over values before filing.

## Adding a form

Use **+ Add a form** in the app, or add an entry to `data/forms.json` by hand:

```json
{ "id": "1040-schedule-2", "name": "Schedule 2", "title": "Additional Taxes",
  "irsFile": "f1040s2", "detect": "Additional Taxes" }
```

`id` becomes the file name, `irsFile` is the IRS download name used to recognise dropped files, `detect` is text from the form's title. Add `"repeatPages": [2]` to let page 2 of a form be added several times, as Form 8938 does.
