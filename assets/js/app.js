/* Yield Tracker 3000
   Reads Treasury's Daily Par Yield Curve CSVs (one file per year). The saved
   copies in data/treasury/ load first because home.treasury.gov can take ~20s
   to answer; the current year is then re-checked live against treasury.gov,
   which allows cross-origin reads. */
(() => {
  "use strict";

  const FIRST_YEAR = 1990;
  const LIVE_TIMEOUT_MS = 60000;
  const TREASURY_CSV = y =>
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/" +
    `${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`;
  const TREASURY_PAGE = y =>
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView" +
    `?type=daily_treasury_yield_curve&field_tdr_date_value=${y}`;
  const SNAPSHOT = y => `./data/treasury/${y}.csv`;

  const COMPARE = {
    "1w": { days: -7 },
    "1m": { months: -1 },
    "1y": { months: -12 },
    "5y": { months: -60 },
  };
  // maturities kept when the even axis is too narrow to label all of them
  const KEY_TENORS = new Set([1, 3, 6, 12, 24, 60, 120, 360]);

  const $ = id => document.getElementById(id);
  const el = {
    year: $("year-select"), date: $("date-select"), compare: $("compare-select"),
    prev: $("prev-day"), next: $("next-day"), latest: $("latest-btn"),
    svg: $("chart-svg"), chart: $("chart"), tooltip: $("tooltip"),
    title: $("chart-title"), sub: $("chart-sub"), legend: $("legend"),
    tiles: $("tiles"), table: $("yields-table"), status: $("data-status"),
    srcPage: $("src-textview"), srcCsv: $("src-csv"), ledeSrc: $("lede-source"),
  };

  const state = {
    latestYear: new Date().getFullYear(),
    snapshotFetchedAt: null,
    live: "pending",          // pending | ok | failed
    liveCheckedAt: null,
    liveNewDays: 0,
    followLatest: true,       // false once the reader picks a date
    main: null,               // { date, points }
    compare: null,
    compareKey: "",
    scale: "even",
    shownYear: null,
    token: 0,
  };

  /* ---------- dates ---------- */
  const asDate = s => new Date(s + "T00:00:00Z");
  const fmt = (s, o) => asDate(s).toLocaleDateString("en-US", { timeZone: "UTC", ...o });
  const fmtLong = s => fmt(s, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const fmtShort = s => fmt(s, { month: "short", day: "numeric", year: "numeric" });
  const fmtOption = s => fmt(s, { weekday: "short", month: "short", day: "numeric" });
  const yearOf = s => +s.slice(0, 4);

  function shiftDate(s, { days = 0, months = 0 }) {
    const d = asDate(s);
    if (months) {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
    }
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /* ---------- numbers ---------- */
  const pct = v => `${v.toFixed(2)}%`;
  const bp = v => {
    const n = Math.round(v * 100);
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} bp`;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------- Treasury CSV ---------- */
  // Headers look like "1 Mo", "1.5 Month", "10 Yr"; columns vary by year.
  function parseTenor(h) {
    const m = /^([\d.]+)\s*(mo|month|months|yr|year|years)$/i.exec(h.replace(/"/g, "").trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    const years = /^y/i.test(m[2]);
    return {
      months: years ? n * 12 : n,
      short: `${n}${years ? "Y" : "M"}`,
      long: `${n}-${years ? "year" : "month"}`,
    };
  }

  function parseCsv(text, year) {
    const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
    const header = lines[0].split(",").map(s => s.replace(/"/g, "").trim());
    if (header[0] !== "Date" || !header.includes("10 Yr")) throw new Error("not a Treasury yield curve CSV");
    const tenors = header.map((h, i) => (i ? parseTenor(h) : null));
    const rows = [];
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const [mm, dd, yyyy] = cells[0].split("/");
      if (+yyyy !== year) continue;
      const points = [];
      tenors.forEach((t, i) => {
        if (!t || cells[i] === undefined || cells[i].trim() === "") return;
        const v = parseFloat(cells[i]);
        if (Number.isFinite(v)) points.push({ t, y: v });
      });
      // holiday rows can carry only a stray value or two; they are not a curve
      if (points.length >= 4) {
        points.sort((a, b) => a.t.months - b.t.months);
        rows.push({ date: `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`, points });
      }
    }
    return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  async function fetchText(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const fetchLive = y => fetchText(TREASURY_CSV(y), LIVE_TIMEOUT_MS).then(t => parseCsv(t, y));

  const yearCache = new Map();  // year -> Promise<rows>
  function loadYear(y) {
    if (!yearCache.has(y)) {
      const p = fetchText(SNAPSHOT(y))
        .then(t => parseCsv(t, y))
        .catch(() => fetchLive(y));
      p.catch(() => yearCache.delete(y));
      yearCache.set(y, p);
    }
    return yearCache.get(y);
  }

  // Latest trading day on or before `date`, looking back into earlier years if needed.
  async function findOnOrBefore(date) {
    for (let y = yearOf(date); y >= FIRST_YEAR && y >= yearOf(date) - 1; y--) {
      let rows;
      try { rows = await loadYear(y); } catch { continue; }
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date <= date) return rows[i];
    }
    return null;
  }

  /* ---------- selection ---------- */
  async function selectDate(date, { follow = false } = {}) {
    const token = ++state.token;
    const y = Math.min(Math.max(yearOf(date), FIRST_YEAR), state.latestYear);
    let rows;
    try {
      rows = await loadYear(y);
    } catch {
      el.sub.textContent = `Could not load ${y} from the saved copy or from treasury.gov. Try again later.`;
      return;
    }
    if (token !== state.token) return;
    let row = null;
    for (const r of rows) if (r.date <= date) row = r;
    row = row || rows[0];
    if (!row) return;

    state.main = row;
    state.followLatest = follow;
    fillDateSelect(y, rows);
    el.date.value = row.date;
    el.year.value = String(y);
    updateSourceLinks(y);
    await updateCompare(token);
    if (token !== state.token) return;
    render();
    writeHash();
  }

  async function updateCompare(token = state.token) {
    const spec = COMPARE[state.compareKey];
    state.compare = null;
    if (!spec || !state.main) return;
    const target = shiftDate(state.main.date, spec);
    const row = await findOnOrBefore(target);
    if (token === state.token && row && row.date !== state.main.date) state.compare = row;
  }

  function fillDateSelect(y, rows) {
    if (state.shownYear === y && el.date.options.length === rows.length) return;
    state.shownYear = y;
    el.date.innerHTML = rows.slice().reverse()
      .map(r => `<option value="${r.date}">${fmtOption(r.date)}</option>`).join("");
  }

  function fillYearSelect() {
    let html = "";
    for (let y = state.latestYear; y >= FIRST_YEAR; y--) html += `<option value="${y}">${y}</option>`;
    el.year.innerHTML = html;
  }

  async function step(dir) {
    if (!state.main) return;
    const y = yearOf(state.main.date);
    const rows = await loadYear(y);
    const i = rows.findIndex(r => r.date === state.main.date);
    if (rows[i + dir]) return selectDate(rows[i + dir].date);
    const ny = y + dir;
    if (ny < FIRST_YEAR || ny > state.latestYear) return;
    const other = await loadYear(ny);
    if (other.length) selectDate(dir < 0 ? other[other.length - 1].date : other[0].date);
  }

  async function latestDate() {
    for (let y = state.latestYear; y >= state.latestYear - 1; y--) {
      try {
        const rows = await loadYear(y);
        if (rows.length) return rows[rows.length - 1].date;
      } catch { /* try the year before */ }
    }
    return null;
  }

  async function updateStepButtons() {
    if (!state.main) return;
    const rows = await loadYear(yearOf(state.main.date));
    const i = rows.findIndex(r => r.date === state.main.date);
    const latest = await latestDate();
    el.prev.disabled = yearOf(state.main.date) === FIRST_YEAR && i === 0;
    el.next.disabled = state.main.date === latest;
    el.latest.disabled = state.main.date === latest;
  }

  /* ---------- URL hash: #date=2026-10-22&compare=1y&scale=time ---------- */
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(p.get("date") || "") ? p.get("date") : null;
    return {
      date,
      compare: COMPARE[p.get("compare")] ? p.get("compare") : "",
      scale: p.get("scale") === "time" ? "time" : "even",
    };
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (!state.followLatest && state.main) p.set("date", state.main.date);
    if (state.compareKey) p.set("compare", state.compareKey);
    if (state.scale !== "even") p.set("scale", state.scale);
    const h = p.toString();
    history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
  }

  function updateSourceLinks(y) {
    el.srcPage.href = TREASURY_PAGE(y);
    el.ledeSrc.href = TREASURY_PAGE(y);
    el.srcCsv.href = TREASURY_CSV(y);
    el.srcCsv.textContent = `download ${y} as CSV`;
  }

  /* ---------- render ---------- */
  function series() {
    const out = [{ key: "main", row: state.main }];
    if (state.compare) out.push({ key: "compare", row: state.compare });
    return out;
  }

  function render() {
    renderHeader();
    renderChart();
    renderTiles();
    renderTable();
    renderStatus();
    updateStepButtons();
  }

  function renderHeader() {
    const m = state.main, c = state.compare;
    el.title.textContent = `Treasury par yield curve, ${fmtShort(m.date)}`;
    el.sub.textContent = c
      ? `${fmtLong(m.date)}, compared with ${fmtLong(c.date)}. Percent, bond-equivalent basis.`
      : `${fmtLong(m.date)}. Percent, bond-equivalent basis.` +
        (state.compareKey ? " No earlier curve to compare with: Treasury's series starts January 2, 1990." : "");
    el.legend.hidden = !c;
    if (c) {
      el.legend.innerHTML = series().map(s =>
        `<li><span class="legend__swatch legend__swatch--${s.key}" style="border-color:var(--series-${s.key})"></span>${fmtShort(s.row.date)}</li>`
      ).join("");
    }
  }

  function tenorUnion() {
    const byMonths = new Map();
    for (const s of series()) for (const p of s.row.points) byMonths.set(p.t.months, p.t);
    return [...byMonths.values()].sort((a, b) => a.months - b.months);
  }

  function niceScale(lo, hi) {
    if (hi - lo < 0.4) { const mid = (lo + hi) / 2; lo = mid - 0.2; hi = mid + 0.2; }
    const pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    const raw = (hi - lo) / 5;
    const step = [0.1, 0.2, 0.25, 0.5, 1, 2].find(s => s >= raw) || 2;
    const t0 = Math.floor(lo / step) * step;
    const t1 = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = t0; v <= t1 + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
    const dec = step >= 1 ? 0 : step === 0.25 ? 2 : 1;
    return { lo: t0, hi: t1, ticks, dec };
  }

  let geom = null;  // what the hover layer needs from the last draw

  function renderChart() {
    const svg = el.svg;
    const W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !state.main) return;
    const narrow = W < 560;
    const ss = series();
    const endLabels = ss.length > 1 && !narrow;
    const m = { top: 14, right: endLabels ? 100 : 18, bottom: 58, left: narrow ? 54 : 66 };
    const pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    const tenors = tenorUnion();
    const inset = 14;

    const xEven = new Map(tenors.map((t, i) => [t.months, i]));
    const x = state.scale === "time"
      ? months => m.left + inset + (months / 360) * (pw - 2 * inset)
      : months => m.left + inset + (tenors.length > 1 ? xEven.get(months) / (tenors.length - 1) : 0.5) * (pw - 2 * inset);

    const all = ss.flatMap(s => s.row.points.map(p => p.y));
    const ys = niceScale(Math.min(...all), Math.max(...all));
    const y = v => m.top + ph - ((v - ys.lo) / (ys.hi - ys.lo)) * ph;

    let g = `<desc id="chart-desc">${esc(describe())}</desc>`;

    // horizontal grid + y labels
    for (const t of ys.ticks) {
      g += `<line class="grid-line" x1="${m.left}" x2="${m.left + pw}" y1="${y(t)}" y2="${y(t)}"/>`;
      g += `<text class="tick-label" x="${m.left - 10}" y="${y(t)}" text-anchor="end" dominant-baseline="middle">${t.toFixed(ys.dec)}%</text>`;
    }
    if (ys.lo < 0 && ys.hi > 0) g += `<line class="zero-line" x1="${m.left}" x2="${m.left + pw}" y1="${y(0)}" y2="${y(0)}"/>`;

    // x axis
    const base = m.top + ph;
    g += `<line class="axis-line" x1="${m.left}" x2="${m.left + pw}" y1="${base}" y2="${base}"/>`;
    if (state.scale === "time") {
      for (let yr = 0; yr <= 30; yr += 5) {
        const xx = x(yr * 12);
        g += `<line class="axis-line" x1="${xx}" x2="${xx}" y1="${base}" y2="${base + 5}"/>`;
        g += `<text class="tick-label" x="${xx}" y="${base + 20}" text-anchor="middle">${yr === 0 ? "0" : yr + "Y"}</text>`;
      }
    } else {
      // when crowded, label only key maturities, skipping any that would touch the last label
      const crowded = pw / Math.max(tenors.length - 1, 1) < 34;
      let lastLabel = -Infinity;
      for (const t of tenors) {
        const xx = x(t.months);
        g += `<line class="axis-line" x1="${xx}" x2="${xx}" y1="${base}" y2="${base + 5}"/>`;
        if (!crowded || (KEY_TENORS.has(t.months) && xx - lastLabel >= 32)) {
          g += `<text class="tick-label" x="${xx}" y="${base + 20}" text-anchor="middle">${t.short}</text>`;
          lastLabel = xx;
        }
      }
    }

    // axis titles
    const xTitle = state.scale === "time" ? "Years to maturity (drawn to scale)" : "Maturity (M = months, Y = years)";
    g += `<text class="axis-title" x="${m.left + pw / 2}" y="${H - 8}" text-anchor="middle">${xTitle}</text>`;
    g += `<text class="axis-title" transform="translate(14 ${m.top + ph / 2}) rotate(-90)" text-anchor="middle">Yield (percent)</text>`;

    // curves: compare first so the selected date draws on top
    const order = ss.slice().reverse();
    for (const s of order) {
      const d = s.row.points.map((p, i) => `${i ? "L" : "M"}${x(p.t.months).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
      g += `<path class="curve curve--${s.key}" d="${d}"/>`;
    }
    for (const s of order) {
      for (const p of s.row.points) {
        g += `<circle class="dot dot--${s.key}" cx="${x(p.t.months).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="4"/>`;
      }
    }

    // direct labels at the long end, nudged apart when they collide
    if (endLabels) {
      const labels = ss.map(s => {
        const p = s.row.points[s.row.points.length - 1];
        return { s, x: x(p.t.months) + 10, y: y(p.y) };
      }).sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) {
        if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
      }
      for (const l of labels) {
        g += `<text class="end-label" x="${l.x}" y="${l.y}" dominant-baseline="middle">${fmtShort(l.s.row.date)}</text>`;
      }
    }

    // hover layer
    g += `<line class="crosshair" id="crosshair" y1="${m.top}" y2="${base}" visibility="hidden"/>`;
    for (const s of ss) g += `<circle class="hover-dot" id="hover-${s.key}" r="6" fill="var(--series-${s.key})" visibility="hidden"/>`;
    g += `<rect id="hit" x="${m.left}" y="${m.top}" width="${pw}" height="${ph + m.bottom - 24}" fill="transparent"/>`;

    svg.innerHTML = g;
    geom = { x, y, tenors, ss, W };
    bindHover();
  }

  function bindHover() {
    const hit = document.getElementById("hit");
    const cross = document.getElementById("crosshair");
    const show = ev => {
      const box = el.svg.getBoundingClientRect();
      const px = ev.clientX - box.left;
      let best = null, bestD = Infinity;
      for (const t of geom.tenors) {
        const d = Math.abs(geom.x(t.months) - px);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best) return;
      const xx = geom.x(best.months);
      cross.setAttribute("x1", xx); cross.setAttribute("x2", xx);
      cross.setAttribute("visibility", "visible");
      const vals = geom.ss.map(s => ({ s, p: s.row.points.find(p => p.t.months === best.months) }));
      let topY = Infinity;
      for (const { s, p } of vals) {
        const dot = document.getElementById(`hover-${s.key}`);
        if (p) {
          dot.setAttribute("cx", xx); dot.setAttribute("cy", geom.y(p.y));
          dot.setAttribute("visibility", "visible");
          topY = Math.min(topY, geom.y(p.y));
        } else {
          dot.setAttribute("visibility", "hidden");
        }
      }
      let html = `<div class="tooltip__title">${best.long} Treasury</div>`;
      for (const { s, p } of vals) {
        html += `<div class="tooltip__row"><span><i class="tooltip__key" style="background:var(--series-${s.key})"></i>${fmtShort(s.row.date)}</span><b>${p ? pct(p.y) : "not published"}</b></div>`;
      }
      if (vals.length > 1 && vals[0].p && vals[1].p) {
        html += `<div class="tooltip__row"><span>Change</span><b>${bp(vals[0].p.y - vals[1].p.y)}</b></div>`;
      }
      const tip = el.tooltip;
      tip.innerHTML = html;
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = xx + 14;
      if (left + tw > geom.W) left = xx - tw - 14;
      const top = Math.max(0, (Number.isFinite(topY) ? topY : 40) - th - 12);
      tip.style.transform = `translate(${Math.max(0, left)}px, ${top}px)`;
    };
    const hide = () => {
      el.tooltip.hidden = true;
      cross.setAttribute("visibility", "hidden");
      for (const s of geom.ss) document.getElementById(`hover-${s.key}`).setAttribute("visibility", "hidden");
    };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide);
  }

  function describe() {
    const m = state.main;
    return `Treasury par yield curve on ${fmtLong(m.date)}: ` +
      m.points.map(p => `${p.t.long} ${pct(p.y)}`).join(", ") + ".";
  }

  const yieldAt = (row, months) => row && (row.points.find(p => p.t.months === months) || {}).y;

  function renderTiles() {
    const m = state.main, c = state.compare;
    const tile = (label, months, spreadFrom) => {
      const val = row => {
        const a = yieldAt(row, months);
        if (a === undefined) return undefined;
        if (spreadFrom === undefined) return a;
        const b = yieldAt(row, spreadFrom);
        return b === undefined ? undefined : a - b;
      };
      const show = v => v === undefined ? "—" : spreadFrom === undefined ? pct(v) : bp(v);
      const v = val(m);
      const flag = spreadFrom !== undefined && v !== undefined && v < 0 ? `<span class="tile__flag">Inverted</span>` : "";
      let note = spreadFrom === undefined ? "Yield" : "Spread, basis points";
      if (c) {
        const cv = val(c);
        note = `${show(cv)} on ${fmtShort(c.date)}`;
      }
      return `<div class="tile"><div class="tile__label">${label}</div><div class="tile__value">${show(v)}${flag}</div><div class="tile__note">${note}</div></div>`;
    };
    el.tiles.innerHTML =
      tile("10-year yield", 120) +
      tile("10-year minus 2-year", 120, 24) +
      tile("10-year minus 3-month", 120, 3);
  }

  function renderTable() {
    const m = state.main, c = state.compare;
    let html = `<thead><tr><th scope="col">Maturity</th><th scope="col">${fmtShort(m.date)}</th>`;
    if (c) html += `<th scope="col">${fmtShort(c.date)}</th><th scope="col">Change</th>`;
    html += "</tr></thead><tbody>";
    for (const t of tenorUnion()) {
      const a = yieldAt(m, t.months);
      html += `<tr><th scope="row">${t.long}</th>`;
      html += a === undefined ? `<td class="na">not published</td>` : `<td>${pct(a)}</td>`;
      if (c) {
        const b = yieldAt(c, t.months);
        html += b === undefined ? `<td class="na">not published</td>` : `<td>${pct(b)}</td>`;
        html += a === undefined || b === undefined ? `<td class="na">—</td>`
          : `<td class="${a - b < 0 ? "neg" : ""}">${bp(a - b)}</td>`;
      }
      html += "</tr>";
    }
    el.table.innerHTML = html + "</tbody>";
  }

  async function renderStatus() {
    const latest = await latestDate();
    const parts = [];
    if (latest) parts.push(`Data runs from January 2, 1990 through ${fmtLong(latest)}.`);
    const saved = state.snapshotFetchedAt
      ? `the copy of Treasury's files saved ${new Date(state.snapshotFetchedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
      : "the saved copy of Treasury's files";
    if (state.live === "pending") parts.push(`Showing ${saved} while checking treasury.gov for newer data…`);
    else if (state.live === "ok") {
      const at = state.liveCheckedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      parts.push(state.liveNewDays
        ? `Checked treasury.gov at ${at} and added ${state.liveNewDays} newer day${state.liveNewDays > 1 ? "s" : ""}.`
        : `Checked treasury.gov at ${at}: up to date.`);
    } else parts.push(`treasury.gov did not respond, so this is ${saved}.`);
    el.status.textContent = parts.join(" ");
  }

  /* ---------- live refresh of the current year ---------- */
  async function refreshLive() {
    const y = new Date().getFullYear();
    try {
      const live = await fetchLive(y);
      let saved = [];
      try { saved = await loadYear(y); } catch { /* new year, nothing saved yet */ }
      state.live = "ok";
      state.liveCheckedAt = new Date();
      const lastSaved = saved.length ? saved[saved.length - 1].date : "";
      state.liveNewDays = live.filter(r => r.date > lastSaved).length;
      if (live.length && (live.length !== saved.length || state.liveNewDays)) {
        yearCache.set(y, Promise.resolve(live));
        if (y > state.latestYear) { state.latestYear = y; fillYearSelect(); }
        if (state.shownYear === y) state.shownYear = null;  // rebuild the date list
        if (state.followLatest) return selectDate(live[live.length - 1].date, { follow: true });
        if (state.main && yearOf(state.main.date) === y) fillDateSelect(y, live);
        el.date.value = state.main.date;
        el.year.value = String(yearOf(state.main.date));
      }
    } catch {
      state.live = "failed";
    }
    if (state.main) { renderStatus(); updateStepButtons(); }
  }

  /* ---------- wiring ---------- */
  el.year.addEventListener("change", async () => {
    const y = +el.year.value;
    try {
      const rows = await loadYear(y);
      // keep the same calendar day when switching years where possible
      const same = state.main ? `${y}${state.main.date.slice(4)}` : `${y}-12-31`;
      const target = rows.some(r => r.date <= same) ? same : rows[0].date;
      selectDate(target);
    } catch {
      el.sub.textContent = `Could not load ${y}. Try again later.`;
    }
  });
  el.date.addEventListener("change", () => selectDate(el.date.value));
  el.prev.addEventListener("click", () => step(-1));
  el.next.addEventListener("click", () => step(1));
  el.latest.addEventListener("click", async () => {
    const d = await latestDate();
    if (d) selectDate(d, { follow: true });
  });
  el.compare.addEventListener("change", async () => {
    state.compareKey = el.compare.value;
    const token = ++state.token;
    await updateCompare(token);
    if (token !== state.token) return;
    render();
    writeHash();
  });
  document.querySelectorAll("[data-scale]").forEach(b => b.addEventListener("click", () => {
    state.scale = b.dataset.scale;
    document.querySelectorAll("[data-scale]").forEach(o => o.setAttribute("aria-checked", String(o === b)));
    renderChart();
    writeHash();
  }));
  document.addEventListener("keydown", ev => {
    if (ev.target.closest("select, input, textarea") || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === "ArrowLeft") { ev.preventDefault(); step(-1); }
    if (ev.key === "ArrowRight") { ev.preventDefault(); step(1); }
  });
  new ResizeObserver(() => renderChart()).observe(el.chart);

  async function init() {
    try {
      const man = JSON.parse(await fetchText("./data/treasury/manifest.json"));
      state.snapshotFetchedAt = man.fetched_at;
      if (man.years && man.years.length) state.latestYear = Math.max(...man.years);
    } catch { /* fall back to the calendar year */ }
    fillYearSelect();

    const h = readHash();
    state.compareKey = h.compare;
    state.scale = h.scale;
    el.compare.value = h.compare;
    document.querySelectorAll("[data-scale]").forEach(o => o.setAttribute("aria-checked", String(o.dataset.scale === h.scale)));

    if (h.date) await selectDate(h.date);
    else {
      const d = await latestDate();
      if (d) await selectDate(d, { follow: true });
      else el.sub.textContent = "Could not load Treasury data. Try again later.";
    }
    refreshLive();
  }

  init();
})();
