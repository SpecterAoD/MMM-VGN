/* MMM-VGN – nächste Verbindungen im VGN (Nürnberg/Franken) mit Verspätungen
 * und Störungsmeldungen. Daten: VGN-Verbindungsauskunft (EFA). */
Module.register("MMM-VGN", {
  defaults: {
    from: "",                  // Start-Haltestelle: Name oder globale Kennung ("de:…")
    to: "",                    // Ziel-Haltestelle, ebenso
    maxConnections: 4,
    updateInterval: 120,       // Sekunden (mindestens 60)
    minTimeUntilDeparture: 0,  // zusätzliche Minuten Puffer
    walkFrom: "",              // Adresse ("Ort, Straße Nr."): Gehzeit zur Start-Haltestelle wird daraus geschätzt
    walkMinutes: 0,            // Gehzeit fest vorgeben (hat Vorrang vor walkFrom)
    walkFactor: 1.3,           // Umweg gegenüber der Luftlinie
    walkSpeed: 4.8,            // km/h
    walkIgnoreDelayBelow: 10,  // kleinere Verspätungen zählen fürs Losgehen nicht (könnten aufgeholt werden)
    excludeProducts: [],       // z. B. ["bus"] oder Liniennamen wie ["RE 31"]
    allowWalkAtStart: true,    // false: keine Verbindungen, die mit Fußweg zu einer anderen Haltestelle beginnen
    showVia: true,             // Umstiegshaltestelle anzeigen
    showArrival: true,
    showCountdown: true,       // "in 12 min"
    countdownMax: 60,          // Countdown nur bis so viele Minuten, danach leer
    showInfos: true,           // Störungen und Hinweise
    maxInfos: 2,
    ignoreInfos: [],           // Textteile, deren Meldungen ausgeblendet werden
    delayThreshold: 1,         // ab so vielen Minuten Verspätung rot anzeigen
    apiBase: "https://efa.vgn.de/vgnExt_oeffi"
  },

  start() {
    this.state = null;
    const hello = () => this.sendSocketNotification("VGN_HELLO", { id: this.identifier, config: this.config });
    hello();
    // nach einem Neustart von MagicMirror (ohne neu geladene Seite) wieder anmelden
    setInterval(hello, 5 * 60e3);
    // Countdown und abgefahrene Verbindungen ohne neue Abfrage aktualisieren
    setInterval(() => { if (this.state) this.updateDom(); }, 30e3);
  },

  getStyles() {
    return ["MMM-VGN.css"];
  },

  getTranslations() {
    return { de: "translations/de.json", en: "translations/en.json" };
  },

  socketNotificationReceived(n, p) {
    if (n === "VGN_DATA" && p && p.id === this.identifier) {
      this.state = p;
      this.updateDom(500);
    }
  },

  el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  },

  hhmm(isoString) {
    const d = new Date(isoString);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },

  // geplante Zeit, dahinter +N in Rot (bzw. grün, wenn pünktlich mit Echtzeit)
  timeCell(cls, t, cancelled) {
    const td = this.el("td", cls);
    const main = this.el("span", cancelled ? "vgn-time vgn-strike" : "vgn-time", this.hhmm(t.planned));
    td.appendChild(main);
    if (cancelled) return td;
    if (t.delay >= this.config.delayThreshold) td.appendChild(this.el("span", "vgn-delay", `+${t.delay}`));
    else if (t.delay < 0) td.appendChild(this.el("span", "vgn-early", `${t.delay}`));
    else if (t.realtime) td.classList.add("vgn-ontime");
    return td;
  },

  icon(product) {
    const img = this.el("img", "vgn-icon");
    img.src = this.file(`assets/${product || "default"}.svg`);
    img.alt = product || "";
    return img;
  },

  getDom() {
    const root = this.el("div", "vgn");
    const s = this.state;
    if (!s) { root.appendChild(this.el("div", "dimmed small", this.translate("LOADING"))); return root; }

    const now = Date.now();
    const walk = (Number(s.walk) || 0) * 60e3;
    const depAt = c => Date.parse(c.dep.estimated || c.dep.planned);
    // Bezugszeit fürs Losgehen (wie leaveBase in lib/parse.js)
    const leaveAt = c => {
      const d = c.dep.delay, lim = Number(this.config.walkIgnoreDelayBelow) || 0;
      return (d > 0 && d < lim ? Date.parse(c.dep.planned) : depAt(c)) - walk;
    };
    // zu Fuß nicht mehr erreichbar → weg (30 s Kulanz)
    const list = (s.connections || []).filter(c => (walk ? leaveAt(c) : depAt(c)) >= now - 30e3);
    if (!list.length) {
      root.appendChild(this.el("div", "dimmed small", s.error || this.translate("NONE")));
      return root;
    }

    const tbl = this.el("table", "vgn-table small");
    for (const c of list) {
      const tr = tbl.insertRow();
      if (c.cancelled) tr.className = "vgn-cancelled";

      const dep = this.timeCell("vgn-dep", c.dep, c.legs[0].cancelled);
      if (walk && !c.cancelled) {
        const w = this.el("div", "vgn-sub vgn-walk");
        w.appendChild(this.icon("walk"));
        w.appendChild(document.createTextNode(this.hhmm(new Date(leaveAt(c)))));
        dep.appendChild(w);
      }
      tr.appendChild(dep);

      const legs = this.el("td", "vgn-legs");
      const chain = this.el("div", "vgn-chain");
      c.legs.forEach((l, i) => {
        if (i) chain.appendChild(this.el("span", "vgn-sep", "›"));
        const part = this.el("span", l.cancelled ? "vgn-leg vgn-strike" : "vgn-leg");
        part.appendChild(this.icon(l.product));
        part.appendChild(this.el("span", "vgn-line", l.line));
        chain.appendChild(part);
      });
      legs.appendChild(chain);
      if (c.cancelled) legs.appendChild(this.el("div", "vgn-sub vgn-delay", this.translate("CANCELLED")));
      else if (this.config.showVia && c.via.length) legs.appendChild(this.el("div", "vgn-sub dimmed", `${this.translate("VIA")} ${c.via.join(", ")}`));
      tr.appendChild(legs);

      if (this.config.showArrival) {
        const arr = this.timeCell("vgn-arr", c.arr, c.legs[c.legs.length - 1].cancelled);
        arr.insertBefore(this.el("span", "vgn-label dimmed", `${this.translate("ARR")} `), arr.firstChild);
        tr.appendChild(arr);
      }
      if (this.config.showCountdown) {
        // mit Fußweg: Zeit bis zum Losgehen
        const min = Math.max(0, Math.round(((walk ? leaveAt(c) : depAt(c)) - now) / 60e3));
        const [kNow, kIn] = walk ? ["LEAVE_NOW", "LEAVE_IN"] : ["NOW", "IN_MIN"];
        const txt = c.cancelled ? "" : min === 0 ? this.translate(kNow) : min <= this.config.countdownMax ? this.translate(kIn, { min }) : "";
        tr.appendChild(this.el("td", "vgn-until dimmed", txt));
      }
    }
    root.appendChild(tbl);

    if (this.config.showInfos && (s.infos || []).length) {
      const box = this.el("div", "vgn-infos xsmall");
      for (const t of s.infos.slice(0, this.config.maxInfos)) box.appendChild(this.el("div", "vgn-info", `⚠ ${t}`));
      root.appendChild(box);
    }
    if (s.error) root.appendChild(this.el("div", "vgn-error xsmall dimmed", s.error));
    return root;
  }
});
