'use strict';

// Everything below runs in the browser only: the uploaded file is read into
// memory, analysed, and dropped when the tab is closed or another file is loaded.

const REQUIRED_COLUMNS = [
  'DeliveryDateCET', 'Area', 'SupplyDemand', 'HourIndex_1_25',
  'StartTimeUTC', 'SeqNr', 'Qty_MWH', 'PriceAmount_EUR',
];

const els = {
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  browse: document.getElementById('browse-button'),
  fileName: document.getElementById('file-name'),
  error: document.getElementById('error'),
  results: document.getElementById('results'),
  stats: document.getElementById('stats'),
  seriesLabel: document.getElementById('series-label'),
  periodSelect: document.getElementById('period-select'),
  zoomToggle: document.getElementById('zoom-toggle'),
  curveTitle: document.getElementById('curve-title'),
  tableBody: document.querySelector('#results-table tbody'),
  exportButton: document.getElementById('export-button'),
};

let periods = [];
let priceChart = null;
let curveChart = null;

// ---------- CSV parsing ----------

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('The file has no data rows.');

  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const clean = (v) => v.trim().replace(/^"(.*)"$/, '$1');
  const header = lines[0].split(delimiter).map(clean);
  const col = {};
  for (const name of REQUIRED_COLUMNS) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Column "${name}" is missing. Expected columns: ${REQUIRED_COLUMNS.join(', ')}.`);
    col[name] = i;
  }
  const toNumber = (v) => Number(delimiter === ';' ? v.replace(',', '.') : v);

  const groups = new Map();
  for (let n = 1; n < lines.length; n++) {
    const f = lines[n].split(delimiter).map(clean);
    const side = (f[col.SupplyDemand] || '').toUpperCase();
    if (side !== 'S' && side !== 'D') {
      throw new Error(`Line ${n + 1}: SupplyDemand must be "S" or "D", got "${f[col.SupplyDemand]}".`);
    }
    const seq = toNumber(f[col.SeqNr]);
    const q = toNumber(f[col.Qty_MWH]);
    const p = toNumber(f[col.PriceAmount_EUR]);
    if (![seq, q, p].every(Number.isFinite)) throw new Error(`Line ${n + 1}: SeqNr, Qty_MWH and PriceAmount_EUR must be numbers.`);

    const date = f[col.DeliveryDateCET];
    const area = f[col.Area];
    const start = f[col.StartTimeUTC];
    const key = `${date}|${area}|${start}`;
    let g = groups.get(key);
    if (!g) {
      g = { date, area, hourIndex: Number(f[col.HourIndex_1_25]), start: new Date(start), S: [], D: [] };
      if (Number.isNaN(g.start.getTime())) throw new Error(`Line ${n + 1}: StartTimeUTC "${start}" is not a valid timestamp.`);
      groups.set(key, g);
    }
    g[side].push({ seq, q, p });
  }

  const list = [...groups.values()];
  for (const g of list) {
    if (!g.S.length || !g.D.length) {
      throw new Error(`${g.date} ${g.area} hour ${g.hourIndex}: both a supply and a demand curve are required.`);
    }
    g.S.sort((a, b) => a.seq - b.seq);
    g.D.sort((a, b) => a.seq - b.seq);
  }
  list.sort((a, b) => a.area.localeCompare(b.area) || a.start - b.start);
  return list;
}

// ---------- Clearing price ----------

// Range [min, max] of quantities at which the polyline passes through price p.
// Prices outside the curve's price range map to the nearest end point.
function qtyRangeAt(curve, p) {
  let minP = Infinity, maxP = -Infinity;
  for (const pt of curve) { minP = Math.min(minP, pt.p); maxP = Math.max(maxP, pt.p); }
  const price = Math.min(Math.max(p, minP), maxP);

  let lo = Infinity, hi = -Infinity;
  const take = (q) => { lo = Math.min(lo, q); hi = Math.max(hi, q); };
  for (let i = 0; i < curve.length; i++) {
    const a = curve[i];
    if (a.p === price) take(a.q);
    const b = curve[i + 1];
    if (b && (a.p - price) * (b.p - price) < 0) {
      take(a.q + (b.q - a.q) * (price - a.p) / (b.p - a.p));
    }
  }
  return [lo, hi];
}

// Excess demand D(p) - S(p) as an interval; it is non-increasing in p.
function excessAt(period, p) {
  const [dLo, dHi] = qtyRangeAt(period.D, p);
  const [sLo, sHi] = qtyRangeAt(period.S, p);
  return { lo: dLo - sHi, hi: dHi - sLo };
}

function tradedVolume(period, p) {
  const [dLo, dHi] = qtyRangeAt(period.D, p);
  const [sLo, sHi] = qtyRangeAt(period.S, p);
  const lo = Math.max(dLo, sLo);
  const hi = Math.min(dHi, sHi);
  // Overlapping ranges: the curves share that stretch at price p.
  return lo <= hi ? (lo + hi) / 2 : (Math.min(dHi, sHi) + Math.max(dLo, sLo)) / 2;
}

function clearingPrice(period) {
  // Between two neighbouring break-point prices both curves are straight lines,
  // so excess demand is linear there and its root can be interpolated exactly.
  const prices = [...new Set([...period.S, ...period.D].map((pt) => pt.p))].sort((a, b) => a - b);
  const ex = prices.map((p) => excessAt(period, p));

  const k = ex.findIndex((e) => e.lo <= 0);
  if (k === -1) {
    const p = prices[prices.length - 1];
    return { price: p, volume: tradedVolume(period, p), note: 'Demand exceeds supply at the maximum price' };
  }

  if (ex[k].hi >= 0) {
    // Zero lies inside the jump at this price: the curves meet on a flat segment.
    let last = k;
    while (last + 1 < prices.length && ex[last + 1].hi >= 0) last++;
    const p = (prices[k] + prices[last]) / 2;
    const note = last > k ? `Curves overlap from ${fmt(prices[k])} to ${fmt(prices[last])}; midpoint used` : '';
    return { price: p, volume: tradedVolume(period, p), note };
  }

  if (k === 0) {
    const p = prices[0];
    return { price: p, volume: tradedVolume(period, p), note: 'Supply exceeds demand at the minimum price' };
  }

  // Root between prices[k-1] (excess just above it > 0) and prices[k] (excess just below it < 0).
  const p0 = prices[k - 1], e0 = ex[k - 1].lo;
  const p1 = prices[k], e1 = ex[k].hi;
  const p = p0 + (p1 - p0) * e0 / (e0 - e1);
  return { price: p, volume: tradedVolume(period, p), note: '' };
}

// ---------- Formatting ----------

const numberFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const volumeFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function fmt(v) {
  const r = Math.round(v * 100) / 100;
  return numberFmt.format(Object.is(r, -0) ? 0 : r);
}

function timeIn(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function periodLabel(period, timeZone) {
  const end = new Date(period.start.getTime() + period.durationMs);
  return `${timeIn(period.start, timeZone)}–${timeIn(end, timeZone)}`;
}

function shortLabel(period) {
  return periods.some((p) => p.area !== period.area || p.date !== period.date)
    ? `${period.date} ${period.area} ${periodLabel(period, 'Europe/Brussels')}`
    : periodLabel(period, 'Europe/Brussels');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- Rendering ----------

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
  els.results.hidden = true;
}

function renderStats() {
  const prices = periods.map((p) => p.result.price);
  const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
  const minP = periods.reduce((m, p) => (p.result.price < m.result.price ? p : m));
  const maxP = periods.reduce((m, p) => (p.result.price > m.result.price ? p : m));
  const volume = periods.reduce((s, p) => s + p.result.volume, 0);
  const areas = [...new Set(periods.map((p) => p.area))].join(', ');
  const dates = [...new Set(periods.map((p) => p.date))].join(', ');

  const tiles = [
    ['Average price', `${fmt(avg)}`, `EUR/MWh · ${dates} · ${areas}`],
    ['Lowest', fmt(minP.result.price), `EUR/MWh · ${periodLabel(minP, 'Europe/Brussels')} CET`],
    ['Highest', fmt(maxP.result.price), `EUR/MWh · ${periodLabel(maxP, 'Europe/Brussels')} CET`],
    ['Traded volume', volumeFmt.format(volume), `MWh · ${periods.length} periods`],
  ];
  els.stats.replaceChildren(...tiles.map(([label, value, sub]) => {
    const div = document.createElement('div');
    div.className = 'stat';
    div.innerHTML = '<div class="stat-label"></div><div class="stat-value"></div><div class="stat-sub"></div>';
    div.children[0].textContent = label;
    div.children[1].textContent = value;
    div.children[2].textContent = sub;
    return div;
  }));
}

function renderTable() {
  els.tableBody.replaceChildren(...periods.map((p, i) => {
    const tr = document.createElement('tr');
    tr.dataset.index = i;
    const cells = [
      [p.date], [p.area], [p.hourIndex, 'num'],
      [periodLabel(p, 'Europe/Brussels')], [periodLabel(p, 'Europe/Vilnius')],
      [fmt(p.result.price), 'num price'], [volumeFmt.format(p.result.volume), 'num'], [p.result.note, 'note'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    tr.addEventListener('click', () => selectPeriod(i));
    return tr;
  }));
}

function renderPriceChart() {
  if (priceChart) priceChart.destroy();
  els.seriesLabel.textContent = 'Click a bar to see its curves';
  priceChart = new Chart(document.getElementById('price-chart'), {
    type: 'bar',
    data: {
      labels: periods.map(shortLabel),
      datasets: [{
        label: 'Clearing price, EUR/MWh',
        data: periods.map((p) => Math.round(p.result.price * 100) / 100),
        backgroundColor: cssVar('--accent'),
        borderRadius: 3,
      }],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${fmt(c.parsed.y)} EUR/MWh` } },
      },
      scales: {
        x: { ticks: { color: cssVar('--muted'), maxRotation: 60, autoSkip: true }, grid: { display: false } },
        y: { title: { display: true, text: 'EUR/MWh', color: cssVar('--muted') }, ticks: { color: cssVar('--muted') }, grid: { color: cssVar('--border') } },
      },
      onClick: (_, items) => { if (items.length) selectPeriod(items[0].index); },
    },
  });
}

function curveWindow(period) {
  const { price, volume } = period.result;
  const xSpan = Math.max(250, volume * 0.12);
  const x = [volume - xSpan, volume + xSpan];
  const inX = [...period.S, ...period.D].filter((pt) => pt.q >= x[0] && pt.q <= x[1]).map((pt) => pt.p);
  const ySpan = 250;
  let yMin = Math.max(Math.min(price, ...inX), price - ySpan);
  let yMax = Math.min(Math.max(price, ...inX), price + ySpan);
  const pad = Math.max(5, (yMax - yMin) * 0.1);
  // Round the window to whole steps so the axes start and end on readable ticks.
  const floor = (v, step) => Math.floor(v / step) * step;
  const ceil = (v, step) => Math.ceil(v / step) * step;
  return { x: [floor(x[0], 50), ceil(x[1], 50)], y: [floor(yMin - pad, 10), ceil(yMax + pad, 10)] };
}

function renderCurveChart(period) {
  const { price, volume } = period.result;
  const zoom = els.zoomToggle.checked ? curveWindow(period) : null;
  const muted = cssVar('--muted');
  const grid = cssVar('--border');
  const allQ = [...period.S, ...period.D].map((pt) => pt.q);
  const xRange = zoom ? zoom.x : [Math.min(...allQ), Math.max(...allQ)];

  const datasets = [
    { label: 'Supply', data: period.S.map((pt) => ({ x: pt.q, y: pt.p })), borderColor: cssVar('--supply'), backgroundColor: cssVar('--supply') },
    { label: 'Demand', data: period.D.map((pt) => ({ x: pt.q, y: pt.p })), borderColor: cssVar('--demand'), backgroundColor: cssVar('--demand') },
    {
      label: `Price: ${fmt(price)} EUR/MWh`,
      data: [{ x: xRange[0], y: price }, { x: xRange[1], y: price }],
      borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent'), borderDash: [6, 4], borderWidth: 1.5,
    },
    {
      label: 'Intersection',
      data: [{ x: volume, y: price }],
      showLine: false, pointRadius: 6, pointHoverRadius: 7,
      borderColor: cssVar('--text'), backgroundColor: cssVar('--surface'), borderWidth: 2,
    },
  ];
  for (const ds of datasets.slice(0, 3)) Object.assign(ds, { showLine: true, pointRadius: 0, pointHoverRadius: 3, borderWidth: ds.borderWidth || 2 });

  els.curveTitle.textContent = `Supply and demand · ${period.date} ${periodLabel(period, 'Europe/Brussels')} CET`;
  if (curveChart) curveChart.destroy();
  curveChart = new Chart(document.getElementById('curve-chart'), {
    type: 'scatter',
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { labels: { color: muted, usePointStyle: true, pointStyle: 'line' } },
        tooltip: {
          callbacks: { label: (c) => `${c.dataset.label.split(':')[0]}: ${volumeFmt.format(c.parsed.x)} MWh @ ${fmt(c.parsed.y)} EUR/MWh` },
        },
      },
      scales: {
        x: {
          type: 'linear', min: xRange[0], max: xRange[1],
          title: { display: true, text: 'Volume, MWh', color: muted },
          ticks: { color: muted }, grid: { color: grid },
        },
        y: {
          min: zoom ? zoom.y[0] : undefined, max: zoom ? zoom.y[1] : undefined,
          title: { display: true, text: 'EUR/MWh', color: muted },
          ticks: { color: muted }, grid: { color: grid },
        },
      },
    },
  });
}

function selectPeriod(index) {
  els.periodSelect.value = String(index);
  for (const tr of els.tableBody.children) tr.classList.toggle('active', Number(tr.dataset.index) === index);
  renderCurveChart(periods[index]);
}

function renderAll() {
  els.periodSelect.replaceChildren(...periods.map((p, i) => new Option(`${shortLabel(p)} · ${fmt(p.result.price)}`, String(i))));
  renderStats();
  renderTable();
  els.results.hidden = false;
  renderPriceChart();
  const highest = periods.reduce((m, p, i) => (p.result.price > periods[m].result.price ? i : m), 0);
  selectPeriod(highest);
}

function exportCsv() {
  const rows = [['DeliveryDateCET', 'Area', 'HourIndex_1_25', 'StartTimeUTC', 'PeriodCET', 'ClearingPrice_EUR_MWh', 'Volume_MWh', 'Note']];
  for (const p of periods) {
    rows.push([p.date, p.area, p.hourIndex, p.start.toISOString().replace('.000', ''), periodLabel(p, 'Europe/Brussels'),
      p.result.price.toFixed(4), p.result.volume.toFixed(3), p.result.note]);
  }
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `ClearingPrices_${periods[0].date}_${periods[0].area}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- File handling ----------

async function handleFile(file) {
  if (!file) return;
  els.error.hidden = true;
  els.fileName.hidden = false;
  els.fileName.textContent = file.name;
  try {
    const parsed = parseCsv(await file.text());
    const starts = [...new Set(parsed.map((p) => p.start.getTime()))].sort((a, b) => a - b);
    const step = starts.slice(1).reduce((m, t, i) => Math.min(m, t - starts[i]), Infinity);
    const durationMs = Number.isFinite(step) ? step : 3600 * 1000;
    periods = parsed.map((p) => ({ ...p, durationMs, result: clearingPrice(p) }));
    renderAll();
  } catch (err) {
    periods = [];
    showError(err.message);
  }
}

els.browse.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  handleFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});
els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('dragging'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragging'));
els.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('dragging');
  handleFile(e.dataTransfer.files[0]);
});
els.periodSelect.addEventListener('change', () => selectPeriod(Number(els.periodSelect.value)));
els.zoomToggle.addEventListener('change', () => selectPeriod(Number(els.periodSelect.value)));
els.exportButton.addEventListener('click', exportCsv);
