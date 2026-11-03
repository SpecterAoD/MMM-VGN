#!/usr/bin/env node
/* Vorschau von MMM-VGN im Browser, ohne MagicMirror.
 *
 *   node tools/preview.js --from "<Start>" --to "<Ziel>" [--port 8099] [--config '{"walkFrom":"<Adresse>"}']
 *   → http://localhost:8099  (Echtdaten, Aktualisierung jede Minute)
 *   → http://localhost:8099/?demo=1  (zusätzlich Beispiel-Verspätung und -Ausfall)
 *
 * Hört nur auf 127.0.0.1. Beenden mit Strg+C.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const PORT = Number(arg("port", 8099));

// node_helper von MagicMirror durch eine Attrappe ersetzen
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "node_helper") return path.join(__dirname, "node_helper_stub.js");
  return origResolve.call(this, req, ...rest);
};

const src = fs.readFileSync(path.join(ROOT, "MMM-VGN.js"), "utf8");
const defaults = {};
// Standardwerte aus dem Modul übernehmen (Module.register in einer Sandbox auswerten)
new Function("Module", src)({ register: (n, d) => Object.assign(defaults, d.defaults) });
const cfg = {
  ...defaults,
  from: arg("from", ""),
  to: arg("to", ""),
  ...JSON.parse(arg("config", "{}"))
};

if (!cfg.from || !cfg.to) {
  console.error('Bitte Start und Ziel angeben: --from "<Haltestelle>" --to "<Haltestelle>"');
  process.exit(2);
}

const helper = require(path.join(ROOT, "node_helper.js"));
helper.start();
const inst = { cfg, stops: {} };

function demo(state) {
  const s = JSON.parse(JSON.stringify(state));
  const [a, b] = s.connections;
  if (a) {
    a.dep.estimated = new Date(Date.parse(a.dep.planned) + 5 * 60e3).toISOString();
    a.dep.delay = 5; a.dep.realtime = true; a.arr.delay = 3; a.arr.realtime = true;
  }
  if (b) { b.cancelled = true; b.legs[0].cancelled = true; }
  return s;
}

const page = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>MMM-VGN Vorschau</title>
<style>
body { background:#000; color:#999; font-family:"Roboto Condensed","Roboto",Arial,sans-serif; font-size:20px; margin:40px; }
.small { font-size:20px; line-height:25px; } .xsmall { font-size:15px; line-height:20px; } .dimmed { color:#666; }
header { text-transform:uppercase; font-size:15px; color:#999; border-bottom:1px solid #666; padding-bottom:5px; margin-bottom:10px; display:inline-block; min-width:420px; }
#note { position:fixed; bottom:10px; right:14px; font-size:12px; color:#444; }
</style><link rel="stylesheet" href="/MMM-VGN.css"></head><body>
<header>MMM-VGN</header><div class="module MMM-VGN"><div id="m"></div></div>
<div id="note"></div>
<script>
let def; const Module = { register: (n, d) => { def = d; } };
</script><script src="/MMM-VGN.js"></script><script>
(async () => {
  const tr = await (await fetch("/translations/de.json")).json();
  const m = Object.assign(Object.create(def), {
    config: Object.assign({}, def.defaults, ${JSON.stringify({ ...cfg })}), identifier: "vorschau", state: null,
    translate: (k, v) => (tr[k] || k).replace(/\\{(\\w+)\\}/g, (_, x) => (v && v[x] !== undefined ? v[x] : "")),
    file: f => "/" + f,
    updateDom() { const el = document.getElementById("m"); el.replaceChildren(this.getDom()); }
  });
  const load = async () => {
    try { m.state = await (await fetch("/data" + location.search)).json(); }
    catch (e) { m.state = Object.assign({}, m.state, { error: "Vorschau: " + e.message }); }
    m.updateDom();
    document.getElementById("note").textContent = "Stand " + new Date().toLocaleTimeString("de-DE") + (location.search.includes("demo") ? " · Demo: +5 und Ausfall sind gesetzt" : " · Echtdaten");
  };
  await load(); setInterval(load, 60e3); setInterval(() => m.updateDom(), 30e3);
})();
</script></body></html>`;

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
const ALLOWED = /^\/(MMM-VGN\.(js|css)|assets\/[\w.-]+\.(svg|png)|translations\/[\w-]+\.json)$/;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    } else if (url.pathname === "/data") {
      let state;
      try { state = await helper.update(inst); } catch (e) { state = { connections: [], infos: [], error: helper.reason(e.message) }; }
      if (url.searchParams.get("demo")) state = demo(state);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(state));
    } else if (ALLOWED.test(url.pathname)) {
      const f = path.join(ROOT, url.pathname);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "text/plain" }).end(fs.readFileSync(f));
    } else {
      res.writeHead(404).end();
    }
  } catch (e) {
    res.writeHead(500).end(String(e.message));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`MMM-VGN Vorschau: http://localhost:${PORT}  (Demo: /?demo=1)`));
