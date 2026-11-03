"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseTrips, parseStopfinder, walkMinutes, leaveBase, expired } = require("../lib/parse");

const pt = (name, kind, planned, estimated) => ({
  name, parent: { name },
  [`${kind}TimePlanned`]: planned,
  ...(estimated ? { [`${kind}TimeEstimated`]: estimated } : {})
});
const leg = (cls, line, o, d, extra = {}) => ({
  transportation: { disassembledName: line, product: { class: cls }, destination: { name: "Ziel" } },
  origin: o, destination: d, ...extra
});
const info = (text, subtitle) => ({ type: "lineInfo", infoLinks: [{ urlText: text, subtitle }] });

const NOW = new Date("2026-11-03T04:30:00Z");
const json = {
  journeys: [
    { // bereits abgefahren
      legs: [leg(1, "S1", pt("Start", "departure", "2026-11-03T04:20:00Z"), pt("Umstieg", "arrival", "2026-11-03T04:52:00Z"))]
    },
    { // S1 +5, Umstieg in Tram 5
      legs: [
        leg(1, "S1", pt("Start", "departure", "2026-11-03T04:40:00Z", "2026-11-03T04:45:00Z"),
          pt("Umstieg", "arrival", "2026-11-03T05:12:00Z", "2026-11-03T05:17:00Z"),
          { infos: [info("Bauarbeiten im Bereich Musterstr.", "Bauarbeiten im Bereich Musterstr., vom 15.09. bis 23.10."), info("Sperrung Talstrecke"), info("Weichenstörung bei Musterdorf")] }),
        { transportation: { product: { class: 99, name: "footpath" } }, duration: 120 },
        leg(4, "5", pt("Umstieg", "departure", "2026-11-03T05:23:00Z", "2026-11-03T05:23:00Z"),
          pt("Ziel", "arrival", "2026-11-03T05:35:00Z", "2026-11-03T05:35:00Z"),
          { infos: [info("Weichenstörung bei Musterdorf"), info("UPDATE: Sperrung Talstrecke")] })
      ]
    },
    { // Regionalzug fällt aus
      legs: [leg(0, "RE 47", pt("Start", "departure", "2026-11-03T05:18:00Z"), pt("Mitte", "arrival", "2026-11-03T05:39:00Z"),
        { realtimeStatus: ["TRIP_CANCELLED"] })]
    },
    { // nur Bus
      legs: [leg(6, "334", pt("Start", "departure", "2026-11-03T04:50:00Z"), pt("Mitte", "arrival", "2026-11-03T05:50:00Z"))]
    }
  ]
};

test("abgefahrene Verbindungen fallen weg, Reihenfolge nach Abfahrt", () => {
  const r = parseTrips(json, { now: NOW });
  assert.deepStrictEqual(r.connections.map(c => c.legs[0].line), ["S1", "334", "RE 47"]);
});

test("Verspätung, Umstieg und Produkte", () => {
  const c = parseTrips(json, { now: NOW }).connections[0];
  assert.strictEqual(c.dep.delay, 5);
  assert.strictEqual(c.dep.planned, "2026-11-03T04:40:00Z");
  assert.strictEqual(c.arr.delay, 0);
  assert.strictEqual(c.arr.realtime, true);
  assert.deepStrictEqual(c.legs.map(l => l.product), ["sbahn", "tram"]);
  assert.deepStrictEqual(c.via, ["Umstieg"]);
  assert.strictEqual(c.changes, 1);
});

test("Ausfall wird erkannt", () => {
  const c = parseTrips(json, { now: NOW }).connections.find(x => x.legs[0].line === "RE 47");
  assert.strictEqual(c.cancelled, true);
  assert.strictEqual(c.dep.realtime, false);
});

test("Meldungen: ohne Duplikate, abgelaufene und ignorierte fallen weg", () => {
  assert.deepStrictEqual(parseTrips(json, { now: NOW }).infos, ["UPDATE: Sperrung Talstrecke", "Weichenstörung bei Musterdorf"]);
  assert.deepStrictEqual(parseTrips(json, { now: NOW, ignoreInfos: ["weichen", "talstrecke"] }).infos, []);
});

test("Filter: Produkte, Vorlaufzeit, Anzahl", () => {
  const r = parseTrips(json, { now: NOW, excludeProducts: ["bus"], minTimeUntilDeparture: 20, max: 1 });
  assert.deepStrictEqual(r.connections.map(c => c.legs[0].line), ["RE 47"]);
});

test("gleiche erste Fahrt nur einmal, früheste Ankunft gewinnt", () => {
  const mk = arr => ({ legs: [
    leg(0, "RE 47", pt("Start", "departure", "2026-11-03T05:18:00Z"), pt("Mitte", "arrival", "2026-11-03T05:39:00Z")),
    leg(4, "5", pt("Mitte", "departure", "2026-11-03T05:48:00Z"), pt("Ziel", "arrival", arr))] });
  const r = parseTrips({ journeys: [mk("2026-11-03T06:15:00Z"), mk("2026-11-03T05:55:00Z")] }, { now: NOW });
  assert.strictEqual(r.connections.length, 1);
  assert.strictEqual(r.connections[0].arr.planned, "2026-11-03T05:55:00Z");
});

test("allowWalkAtStart: false verwirft Fußweg am Anfang", () => {
  const j = { journeys: [{ legs: [
    { transportation: { product: { class: 99 } }, duration: 600 },
    leg(0, "RE 31", pt("Start Süd", "departure", "2026-11-03T05:03:00Z"), pt("Mitte", "arrival", "2026-11-03T05:18:00Z"))] }] };
  assert.strictEqual(parseTrips(j, { now: NOW }).connections.length, 1);
  assert.strictEqual(parseTrips(j, { now: NOW, allowWalkAtStart: false }).connections.length, 0);
});

test("expired", () => {
  const now = new Date(2026, 10, 3);
  assert.strictEqual(expired("vom 15.09. bis 23.10.", now), true);
  assert.strictEqual(expired("bis 20.12.", now), false);
  assert.strictEqual(expired("bis 01.02.2026", now), true);
  assert.strictEqual(expired("bis 20.12.", new Date(2027, 0, 10)), true);
  assert.strictEqual(expired("Sperrung Talstrecke", now), false);
});

test("parseStopfinder nimmt die beste Haltestelle", () => {
  const s = parseStopfinder({ locations: [
    { id: "street:1", type: "street", name: "Straße" },
    { id: "de:00000:1", type: "stop", name: "A", matchQuality: 100 },
    { id: "de:00000:2", type: "stop", name: "Musterstadt, Ziel", matchQuality: 900 }
  ] });
  assert.deepStrictEqual(s, { id: "de:00000:2", name: "Musterstadt, Ziel", coord: null });
  assert.strictEqual(parseStopfinder({ locations: [] }), null);
});

test("parseStopfinder mit Adresse und Koordinaten", () => {
  const j = { locations: [{ id: "streetID:1", type: "singlehouse", name: "Ort, Weg 1", isBest: true, coord: [49.5, 11.43] }] };
  assert.strictEqual(parseStopfinder(j), null);
  assert.deepStrictEqual(parseStopfinder(j, true), { id: "streetID:1", name: "Ort, Weg 1", coord: [49.5, 11.43] });
});

test("walkMinutes: 1 km Luftlinie ≈ 17 min (×1,3 bei 4,8 km/h)", () => {
  const a = [49.5, 11.43], b = [49.5 + 1 / 111.195, 11.43];   // 1 km nach Norden
  assert.strictEqual(walkMinutes(a, b), 17);
  assert.strictEqual(walkMinutes(a, b, 1, 6), 10);
  assert.strictEqual(walkMinutes(a, a), 1);
});

test("leaveBase: Verspätung unter der Grenze zählt fürs Losgehen nicht", () => {
  const t = (delay, est) => ({ planned: "2026-11-03T05:00:00Z", estimated: est, delay });
  const P = Date.parse("2026-11-03T05:00:00Z");
  assert.strictEqual(leaveBase(t(5, "2026-11-03T05:05:00Z"), 10), P);
  assert.strictEqual(leaveBase(t(9, "2026-11-03T05:09:00Z"), 10), P);
  assert.strictEqual(leaveBase(t(10, "2026-11-03T05:10:00Z"), 10), P + 10 * 60e3);
  assert.strictEqual(leaveBase(t(-2, "2026-11-03T04:58:00Z"), 10), P - 2 * 60e3);
  assert.strictEqual(leaveBase(t(5, "2026-11-03T05:05:00Z"), 0), P + 5 * 60e3);
});

test("Fußweg-Filter: 5 min verspätet zählt wie pünktlich", () => {
  const j = { journeys: [{ legs: [leg(1, "S1", pt("Start", "departure", "2026-11-03T04:38:00Z", "2026-11-03T04:43:00Z"), pt("Ziel", "arrival", "2026-11-03T05:00:00Z"))] }] };
  // 10 min Fußweg ab 04:30: geplante Abfahrt 04:38 nicht mehr erreichbar, obwohl der Zug erst 04:43 fährt
  assert.strictEqual(parseTrips(j, { now: NOW, minTimeUntilDeparture: 10, ignoreDelayBelow: 10 }).connections.length, 0);
  assert.strictEqual(parseTrips(j, { now: NOW, minTimeUntilDeparture: 10 }).connections.length, 1);
});
