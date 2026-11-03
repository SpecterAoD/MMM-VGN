// MMM-VGN – holt Verbindungen von der VGN-Verbindungsauskunft (EFA).
// Pro Modul-Instanz (identifier) eine eigene Abfrage-Schleife.
"use strict";
const NodeHelper = require("node_helper");
const { parseTrips, parseStopfinder, walkMinutes } = require("./lib/parse");

const isGlobalId = s => /^[a-z]{2}:\d+:\d+(:\d+)*$/i.test(String(s || "").trim());

module.exports = NodeHelper.create({
  start() {
    this.instances = {};
  },

  socketNotificationReceived(n, p) {
    if (n !== "VGN_HELLO" || !p || !p.id) return;
    const inst = this.instances[p.id];
    if (!inst) {
      this.instances[p.id] = { cfg: p.config || {}, stops: {}, state: null, timer: null };
      this.loop(p.id);
    } else if (inst.state) {
      this.sendSocketNotification("VGN_DATA", { id: p.id, ...inst.state });
    }
  },

  async loop(id) {
    const inst = this.instances[id];
    try {
      inst.state = await this.update(inst);
    } catch (e) {
      console.error(`MMM-VGN: ${e.message}`);
      // Letzte Verbindungen behalten, nur den Fehler dazuschreiben
      inst.state = { ...(inst.state || {}), error: this.reason(e.message) };
    }
    this.sendSocketNotification("VGN_DATA", { id, ...inst.state });
    const h = new Date().getHours();
    const night = h >= 1 && h < 4;
    const every = Math.max(60, Number(inst.cfg.updateInterval) || 120) * (night ? 5 : 1);
    inst.timer = setTimeout(() => this.loop(id), every * 1000);
  },

  reason(m) {
    if (/timeout|aborted/i.test(m)) return "VGN antwortet nicht";
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(m)) return "keine Verbindung zum VGN";
    return m.slice(0, 80);
  },

  async get(cfg, path, params) {
    const base = String(cfg.apiBase || "https://efa.vgn.de/vgnExt_oeffi").replace(/\/+$/, "");
    const url = `${base}/${path}?${new URLSearchParams({ outputFormat: "rapidJSON", ...params })}`;
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "MMM-VGN (MagicMirror module)" } });
    } catch (e) {
      const c = e.cause && (e.cause.code || e.cause.message);
      throw new Error(`${e.name === "TimeoutError" ? "timeout" : e.message}${c ? ` (${c})` : ""}`);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },

  // Haltestellenname → globale Kennung (einmal, danach gemerkt)
  async stop(inst, value) {
    const v = String(value || "").trim();
    if (!v) throw new Error("Haltestelle fehlt (from/to)");
    if (isGlobalId(v)) return v;
    if (!inst.stops[v]) {
      const s = parseStopfinder(await this.get(inst.cfg, "XML_STOPFINDER_REQUEST", { type_sf: "any", name_sf: v }));
      if (!s) throw new Error(`Haltestelle nicht gefunden: ${v}`);
      console.log(`MMM-VGN: „${v}“ → ${s.name} (${s.id})`);
      inst.stops[v] = s.id;
    }
    return inst.stops[v];
  },

  // Ort (Adresse oder Haltestelle) mit Koordinaten in Grad
  async locate(cfg, value, anyType) {
    const s = parseStopfinder(await this.get(cfg, "XML_STOPFINDER_REQUEST", {
      type_sf: "any", name_sf: String(value).trim(), coordOutputFormat: "WGS84[dd.ddddd]"
    }), anyType);
    if (!s || !s.coord) throw new Error(`Ort nicht gefunden: ${value}`);
    return s;
  },

  // Gehzeit zur Starthaltestelle: fest (walkMinutes) oder einmal aus walkFrom geschätzt
  async walk(inst, from) {
    const cfg = inst.cfg;
    if (Number(cfg.walkMinutes) > 0) return Number(cfg.walkMinutes);
    if (!cfg.walkFrom) return 0;
    if (inst.walk === undefined) {
      const [home, stop] = [await this.locate(cfg, cfg.walkFrom, true), await this.locate(cfg, from, false)];
      inst.walk = walkMinutes(home.coord, stop.coord, Number(cfg.walkFactor) || 1.3, Number(cfg.walkSpeed) || 4.8);
      console.log(`MMM-VGN: Fußweg zu ${stop.name} geschätzt: ${inst.walk} min (mit walkMinutes festlegbar)`);
    }
    return inst.walk;
  },

  async update(inst) {
    const cfg = inst.cfg;
    const [from, to] = [await this.stop(inst, cfg.from), await this.stop(inst, cfg.to)];
    const max = Math.max(1, Number(cfg.maxConnections) || 4);
    const walk = await this.walk(inst, from);
    const lead = Math.max(0, Number(cfg.minTimeUntilDeparture) || 0) + walk;
    const at = new Date(Date.now() + lead * 60e3);
    const pad = n => String(n).padStart(2, "0");
    const json = await this.get(cfg, "XML_TRIP_REQUEST2", {
      type_origin: "any", name_origin: from,
      type_destination: "any", name_destination: to,
      itdDate: `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`,
      itdTime: `${pad(at.getHours())}${pad(at.getMinutes())}`,
      itdTripDateTimeDepArr: "dep",
      calcNumberOfTrips: String(max + 4),
      useRealtime: "1",
      locationServerActive: "1"
    });
    const res = parseTrips(json, {
      now: new Date(),
      max,
      minTimeUntilDeparture: lead,
      ignoreDelayBelow: walk ? Number(cfg.walkIgnoreDelayBelow ?? 10) : 0,
      excludeProducts: cfg.excludeProducts,
      ignoreInfos: cfg.ignoreInfos,
      allowWalkAtStart: cfg.allowWalkAtStart
    });
    return { ...res, walk, error: null, updated: Date.now() };
  }
});
