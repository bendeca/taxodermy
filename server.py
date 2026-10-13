#!/usr/bin/env python3
"""Taxodermy - tiny local file server. No database, no dependencies (Python 3.8+).

    python3 server.py [--port 8040] [--data ./data] [--no-open]

Serves the app from this folder and stores everything as plain files:

    data/forms.json                       which form sections exist
    data/people.json                      the people whose returns are kept here
    data/rates.json                       IRS yearly average exchange rate per year
    data/<person>/<year>/<form>.pdf       the blank PDF added for that person and year
    data/<person>/<year>/<form>.json      what was typed into it

It listens on 127.0.0.1 only, so nothing is reachable from other machines.
"""
import argparse
import json
import mimetypes
import os
import re
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
YEAR = re.compile(r"^(19|20)\d\d$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(pdf|json)$")
PERSON = re.compile(r"^(?=.*[a-z])[a-z0-9][a-z0-9-]{0,40}$")  # a folder name; never looks like a year
SHARED = ("forms.json", "people.json", "rates.json")
MAX_BODY = 80 * 1024 * 1024
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".json": "application/json; charset=utf-8", ".pdf": "application/pdf",
         ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Taxodermy/1"
    data_dir = os.path.join(ROOT, "data")
    hosts = set()

    # ---- helpers -------------------------------------------------------
    def log_message(self, fmt, *args):
        if self.command != "GET":
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def guard(self, write=False):
        """Only this machine's own browser tab may talk to us."""
        if self.headers.get("Host", "") not in self.hosts:
            self.send(403, {"error": "bad host"})
            return False
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc not in self.hosts:
            self.send(403, {"error": "bad origin"})
            return False
        if write and self.headers.get("X-Tax-Forms") != "1":
            self.send(403, {"error": "missing header"})
            return False
        return True

    def data_path(self, parts):
        """['forms.json'] or ['ada', '2025', '1040.json'] -> absolute path, or None."""
        if len(parts) == 1 and parts[0] in SHARED:
            return os.path.join(self.data_dir, parts[0])
        if len(parts) == 3 and PERSON.match(parts[0]) and YEAR.match(parts[1]) and NAME.match(parts[2]):
            return os.path.join(self.data_dir, *parts)
        return None

    def parts(self):
        path = unquote(urlsplit(self.path).path)
        return [p for p in path.split("/") if p]

    # ---- reading -------------------------------------------------------
    def do_GET(self):
        if not self.guard():
            return
        parts = self.parts()
        if parts == ["api", "list"]:
            return self.send(200, self.listing())
        if parts[:1] == ["data"]:
            target = self.data_path(parts[1:])
        else:
            rel = parts or ["index.html"]
            ok = rel == ["index.html"] or (rel[0] == "assets" and all(re.match(r"^[\w][\w.-]*$", p) for p in rel))
            target = os.path.join(ROOT, *rel) if ok else None
        if not target or not os.path.isfile(target):
            return self.send(404, {"error": "not found"})
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as fh:
            self.send(200, fh.read(), TYPES.get(ext) or mimetypes.guess_type(target)[0] or "application/octet-stream")

    do_HEAD = do_GET

    def years_in(self, folder):
        years = {}
        for year in sorted(os.listdir(folder)):
            sub = os.path.join(folder, year)
            if YEAR.match(year) and os.path.isdir(sub):
                years[year] = {n: os.path.getsize(os.path.join(sub, n)) for n in sorted(os.listdir(sub)) if NAME.match(n)}
        return years

    def listing(self):
        people = {}
        if os.path.isdir(self.data_dir):
            for entry in sorted(os.listdir(self.data_dir)):
                folder = os.path.join(self.data_dir, entry)
                if PERSON.match(entry) and os.path.isdir(folder):
                    people[entry] = {"years": self.years_in(folder)}
        # "legacy": year folders directly under data/, from before people were introduced
        shared = [n for n in SHARED if os.path.isfile(os.path.join(self.data_dir, n))]
        return {"people": people, "legacy": sorted(self.years_in(self.data_dir)), "shared": shared, "folder": self.data_dir}

    def adopt(self, person):
        """Move year folders that sit directly under data/ into data/<person>/."""
        target = os.path.join(self.data_dir, person)
        os.makedirs(target, exist_ok=True)
        moved, skipped = [], []
        for year in sorted(self.years_in(self.data_dir)):
            if os.path.exists(os.path.join(target, year)):
                skipped.append(year)
            else:
                os.rename(os.path.join(self.data_dir, year), os.path.join(target, year))
                moved.append(year)
        return {"ok": True, "moved": moved, "skipped": skipped}

    # ---- writing -------------------------------------------------------
    def do_PUT(self):
        if not self.guard(write=True):
            return
        parts = self.parts()
        if len(parts) == 3 and parts[:2] == ["api", "people"] and PERSON.match(parts[2]):
            os.makedirs(os.path.join(self.data_dir, parts[2]), exist_ok=True)
            return self.send(200, {"ok": True})
        if len(parts) == 4 and parts[:2] == ["api", "years"] and PERSON.match(parts[2]) and YEAR.match(parts[3]):
            os.makedirs(os.path.join(self.data_dir, parts[2], parts[3]), exist_ok=True)
            return self.send(200, {"ok": True})
        if len(parts) == 3 and parts[:2] == ["api", "adopt"] and PERSON.match(parts[2]):
            return self.send(200, self.adopt(parts[2]))
        target = self.data_path(parts[1:]) if parts[:1] == ["data"] else None
        length = int(self.headers.get("Content-Length") or 0)
        if not target or length > MAX_BODY:
            return self.send(400, {"error": "bad path or file too large"})
        body = self.rfile.read(length)
        if target.endswith(".pdf") and not body.startswith(b"%PDF"):
            return self.send(400, {"error": "not a PDF"})
        if target.endswith(".json"):
            try:
                json.loads(body.decode("utf-8"))
            except ValueError:
                return self.send(400, {"error": "not valid JSON"})
        os.makedirs(os.path.dirname(target), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".tmp-")
        with os.fdopen(fd, "wb") as fh:  # write beside, then swap in: never a half-written file
            fh.write(body)
        os.replace(tmp, target)
        self.send(200, {"ok": True, "bytes": len(body)})

    def do_DELETE(self):
        if not self.guard(write=True):
            return
        parts = self.parts()
        target = self.data_path(parts[1:]) if parts[:1] == ["data"] and len(parts) == 4 else None
        if not target:
            return self.send(400, {"error": "bad path"})
        if os.path.isfile(target):
            os.remove(target)
        self.send(200, {"ok": True})


def main():
    ap = argparse.ArgumentParser(description="Taxodermy local server")
    ap.add_argument("--port", type=int, default=8040)
    ap.add_argument("--data", default=os.path.join(ROOT, "data"), help="folder for PDFs and saved values")
    ap.add_argument("--no-open", action="store_true", help="do not open the browser")
    args = ap.parse_args()
    Handler.data_dir = os.path.abspath(args.data)
    Handler.hosts = {"127.0.0.1:%d" % args.port, "localhost:%d" % args.port}
    os.makedirs(Handler.data_dir, exist_ok=True)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as err:
        sys.exit("Could not start on port %d (%s). Try: python3 server.py --port 8041" % (args.port, err))
    url = "http://127.0.0.1:%d/" % args.port
    print("Taxodermy is running at %s\nData folder: %s\nPress Ctrl+C to stop." % (url, Handler.data_dir), flush=True)
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
