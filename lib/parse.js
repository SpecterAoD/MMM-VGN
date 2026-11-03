// Wandelt die Antwort der VGN-Verbindungsauskunft (EFA, rapidJSON) in eine
// schlanke Liste von Verbindungen um. Reine Funktionen ohne Netzwerk, damit
// sie sich ohne MagicMirror testen lassen.
"use strict";

// EFA-Produktklassen → Name des Symbols in assets/
const PRODUCT = {
  0: "bahn", 13: "bahn", 14: "bahn", 15: "bahn", 16: "bahn",
  1: "sbahn",
  2: "ubahn",
  3: "tram", 4: "tram",
  5: "bus", 6: "bus", 7: "bus", 8: "bus", 10: "bus", 11: "bus", 17: "bus", 19: "bus"
};
const WALK = new Set([97, 98, 99, 100]);

const iso = v => (typeof v === "string" && v ? v : null);
const minutes = (a, b) => (a && b ? Math.round((Date.parse(a) - Date.parse(b)) / 60e3) : 0);

function time(point, kind) {
  const planned = iso(point && point[`${kind}TimePlanned`]) || iso(point && point[`${kind}TimeBaseTimetable`]);
  const estimated = iso(point && point[`${kind}TimeEstimated`]);
  return { planned, estimated, delay: estimated ? minutes(estimated, planned) : 0, realtime: Boolean(estimated) };
}

// Bezugszeit fürs Losgehen: kleine Verspätungen (unter ignoreBelow Minuten) zählen nicht,
// sie können wieder aufgeholt werden. Frühere Abfahrt gilt immer.
function leaveBase(t, ignoreBelow = 0) {
  const planned = Date.parse(t.planned), est = Date.parse(t.estimated || t.planned);
  if (!Number.isFinite(est)) return planned;
  return t.delay > 0 && t.delay < ignoreBelow ? planned : est;
}

function isCancelled(leg) {
  if (leg.isCancelled === true || leg.cancelled === true) return true;
  const rs = [].concat(leg.realtimeStatus || [], (leg.transportation && leg.transportation.realtimeStatus) || []);
  return rs.some(s => /CANCEL/i.test(String(s)));
}

function stopName(p) {
  return (p && ((p.parent && p.parent.name) || p.name)) || "";
}

// "… vom 15.09. bis 23.10." oder "bis 23.10.2026" → Ende in der Vergangenheit?
function expired(text, now) {
  const m = /bis\s+(?:einschl(?:ießlich|\.)\s*)?(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?/i.exec(text);
  if (!m) return false;
  let y = m[3] ? Number(m[3]) : now.getFullYear();
  if (y < 100) y += 2000;
  const end = new Date(y, Number(m[2]) - 1, Number(m[1]), 23, 59, 59);
  // Ohne Jahr: ein Ende weit in der "Zukunft" (z. B. im Januar "bis 20.12.") meint das Vorjahr
  if (!m[3] && end - now > 200 * 864e5) end.setFullYear(y - 1);
  return end < now;
}

function infoTexts(leg) {
  const out = [];
  for (const i of leg.infos || []) {
    for (const l of i.infoLinks || []) {
      const t = String(l.urlText || l.subtitle || l.title || "").replace(/\s+/g, " ").trim();
      // Enddatum steht oft nur im Untertitel → für die Prüfung mitgeben
      const full = [l.urlText, l.subtitle, l.htmlText].filter(Boolean).join(" ").replace(/<[^>]*>/g, " ");
      if (t) out.push({ text: t, full });
    }
    if (!(i.infoLinks || []).length) {
      const t = String(i.title || i.subtitle || "").replace(/\s+/g, " ").trim();
      if (t) out.push({ text: t, full: `${i.title || ""} ${i.subtitle || ""}` });
    }
  }
  return out;
}

function parseLeg(leg) {
  const t = leg.transportation || {};
  const cls = t.product && Number(t.product.class);
  if (WALK.has(cls) || (!t.product && !t.number)) {
    return { walk: true, minutes: Math.round((leg.duration || 0) / 60) };
  }
  return {
    walk: false,
    product: PRODUCT[cls] || "default",
    line: String(t.disassembledName || t.number || t.name || "").replace(/\s+/g, " ").trim(),
    direction: (t.destination && t.destination.name) || "",
    from: stopName(leg.origin),
    to: stopName(leg.destination),
    platform: (leg.origin && leg.origin.properties && (leg.origin.properties.platformName || leg.origin.properties.platform)) || "",
    dep: time(leg.origin, "departure"),
    arr: time(leg.destination, "arrival"),
    cancelled: isCancelled(leg),
    infos: infoTexts(leg)
  };
}

/**
 * @param {object} json   Antwort von XML_TRIP_REQUEST2 (outputFormat=rapidJSON)
 * @param {object} opt    { now: Date, minTimeUntilDeparture, ignoreDelayBelow, excludeProducts, ignoreInfos, allowWalkAtStart, max }
 * @returns {{connections: object[], infos: string[]}}
 */
function parseTrips(json, opt = {}) {
  const now = opt.now || new Date();
  const minDep = now.getTime() + (Number(opt.minTimeUntilDeparture) || 0) * 60e3;
  const exclude = new Set(opt.excludeProducts || []);
  const ignore = (opt.ignoreInfos || []).map(s => String(s).toLowerCase()).filter(Boolean);
  const connections = [];
  const infos = [];

  for (const j of (json && json.journeys) || []) {
    const all = (j.legs || []).map(parseLeg);
    const legs = all.filter(l => !l.walk);
    if (!legs.length) continue;
    // Fußweg zu einer anderen Haltestelle vor der ersten Fahrt
    if (opt.allowWalkAtStart === false && all[0].walk) continue;
    if (legs.some(l => exclude.has(l.product) || exclude.has(l.line))) continue;
    const first = legs[0], last = legs[legs.length - 1];
    // Fußweg vor der ersten Fahrt verschiebt die Abfahrt an der Starthaltestelle nicht
    const depAt = leaveBase(first.dep, Number(opt.ignoreDelayBelow) || 0);
    if (!Number.isFinite(depAt) || depAt < minDep) continue;

    const c = {
      dep: first.dep,
      arr: last.arr,
      legs: legs.map(({ product, line, direction, from, to, platform, cancelled, dep, arr }) =>
        ({ product, line, direction, from, to, platform, cancelled, dep, arr })),
      changes: legs.length - 1,
      via: legs.slice(1).map(l => l.from),
      walkFirst: all[0] && all[0].walk ? all[0].minutes : 0,
      cancelled: legs.some(l => l.cancelled)
    };
    const firstKey = `${first.line}@${first.dep.planned}`;
    const same = connections.findIndex(x => x.firstKey === firstKey);
    c.firstKey = firstKey;
    if (same >= 0) {
      if (Date.parse(c.arr.estimated || c.arr.planned) < Date.parse(connections[same].arr.estimated || connections[same].arr.planned)) connections[same] = c;
    } else {
      connections.push(c);
    }

    for (const l of legs) {
      for (const { text, full } of l.infos) {
        if (expired(full, now) || ignore.some(s => full.toLowerCase().includes(s)) || infos.includes(text)) continue;
        // "UPDATE: X" und "X" nur einmal
        const bare = text.replace(/^update:\s*/i, "");
        const dup = infos.findIndex(x => x.replace(/^update:\s*/i, "") === bare);
        if (dup >= 0) { infos[dup] = text; continue; }
        infos.push(text);
      }
    }
  }
  connections.sort((a, b) => Date.parse(a.dep.estimated || a.dep.planned) - Date.parse(b.dep.estimated || b.dep.planned));
  return { connections: opt.max ? connections.slice(0, opt.max) : connections, infos };
}

// Bester Treffer aus XML_STOPFINDER_REQUEST (Standard: nur Haltestellen, mit anyType auch Adressen)
function parseStopfinder(json, anyType = false) {
  const locs = ((json && json.locations) || []).filter(l => l.id && (anyType || l.type === "stop"));
  if (!locs.length) return null;
  const best = locs.find(l => l.isBest) || locs.slice().sort((a, b) => (b.matchQuality || 0) - (a.matchQuality || 0))[0];
  const c = Array.isArray(best.coord) && best.coord.length === 2 ? best.coord.map(Number) : null;
  return { id: best.id, name: best.name, coord: c && c.every(Number.isFinite) ? c : null };
}

// Geschätzte Gehzeit in Minuten: Luftlinie × Umwegfaktor bei Gehgeschwindigkeit (km/h).
// a, b: [lat, lon] in Grad (WGS84)
function walkMinutes(a, b, factor = 1.3, speed = 4.8) {
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h));
  return Math.max(1, Math.ceil(km * factor / speed * 60));
}

module.exports = { parseTrips, parseStopfinder, walkMinutes, leaveBase, expired, PRODUCT };
