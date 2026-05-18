const fs = require("fs");
const path = require("path");

const root = __dirname;
const simulationCsv = path.join(root, "prova_ufficiale_simulazione.csv");
const reportPath = path.join(root, "report_kpi_grafici.html");

function parseNumber(value) {
  const text = String(value ?? "").replace(/^"|"$/g, "").replace(/""/g, '"').trim();
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function unquote(value) {
  return String(value ?? "").replace(/^"|"$/g, "").replace(/""/g, '"');
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ";" && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

const lines = fs.readFileSync(simulationCsv, "utf8").split(/\r?\n/);
const summary = {};
let hourlyStart = lines.findIndex(line => line.trim() === "RISULTATI ORARI");

for (let i = 2; i < hourlyStart - 1; i += 1) {
  const [key, value] = parseCsvLine(lines[i]);
  if (key) summary[unquote(key)] = parseNumber(value);
}

const header = parseCsvLine(lines[hourlyStart + 1]).map(unquote);
const rows = lines.slice(hourlyStart + 2)
  .filter(Boolean)
  .map(line => {
    const cells = parseCsvLine(line).map(unquote);
    const row = {};
    header.forEach((name, index) => {
      row[name] = index <= 1 ? cells[index] : parseNumber(cells[index]);
    });
    return row;
  });

const bessCapacityKwh = summary.bessKwh || Math.max(1, ...rows.map(row => row.SOC || 0));

function socPercentFromRow(row) {
  if (Object.prototype.hasOwnProperty.call(row, "SOC [%]")) return row["SOC [%]"];
  if (Object.prototype.hasOwnProperty.call(row, "soc_percent")) return row.soc_percent;
  return bessCapacityKwh > 0 ? Math.min(100, Math.max(0, row.SOC / bessCapacityKwh * 100)) : 0;
}

const byHour = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  load: 0,
  fv2: 0,
  charge: 0,
  discharge: 0,
  postBess: 0,
  arbitrageExport: 0,
  export: 0,
  socPct: 0,
  count: 0,
}));
const byMonth = new Map();

for (const row of rows) {
  const bucket = byHour[Number(row.Ora)];
  if (!bucket) continue;
  bucket.load += row["Prelievo rete"];
  bucket.fv2 += row["Prod. FV2"];
  bucket.charge += row["Carica BESS"];
  bucket.discharge += row["Scarica BESS"];
  bucket.postBess += row["Prelievo rete Post BESS"];
  bucket.arbitrageExport += row["Vendita BESS a rete"] || row.vendita_bess_rete_kwh || 0;
  bucket.export += row["Immessa post BESS"];
  bucket.socPct += socPercentFromRow(row);
  bucket.count += 1;

  const dateParts = String(row.Data).split("/");
  const monthNumber = dateParts.length === 3 ? Number(dateParts[1]) : 0;
  if (!byMonth.has(monthNumber)) {
    byMonth.set(monthNumber, { month: monthNumber, load: 0, postFv: 0, postBess: 0 });
  }
  const month = byMonth.get(monthNumber);
  month.load += row["Prelievo rete"];
  month.postFv += row["Prelievo rete Post FV"];
  month.postBess += row["Prelievo rete Post BESS"];
}

const hourly = byHour.map(item => ({
  hour: item.hour,
  load: item.count ? item.load / item.count : 0,
  fv2: item.count ? item.fv2 / item.count : 0,
  charge: item.count ? item.charge / item.count : 0,
  discharge: item.count ? item.discharge / item.count : 0,
  postBess: item.count ? item.postBess / item.count : 0,
  arbitrageExport: item.count ? item.arbitrageExport / item.count : 0,
  export: item.count ? item.export / item.count : 0,
  socPct: item.count ? item.socPct / item.count : 0,
}));
const monthLabels = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];
const monthly = monthLabels.map((label, index) => {
  const monthNumber = index + 1;
  const item = byMonth.get(monthNumber) || { month: monthNumber, load: 0, postFv: 0, postBess: 0 };
  return { ...item, label };
});

function euro(value) {
  return Math.round(value).toLocaleString("it-IT") + " €";
}

function kwh(value) {
  return value.toLocaleString("it-IT", { maximumFractionDigits: 1 }) + " kWh";
}

function years(value) {
  return value ? value.toLocaleString("it-IT", { maximumFractionDigits: 1 }) + " anni" : "-";
}

function percent(value) {
  return value.toLocaleString("it-IT", { maximumFractionDigits: 1 }) + "%";
}

function roiSummary() {
  const isArbitrage = summary.bessMode === "arbitrage";
  const investment = summary.investmentEuro || summary.costoSistemaEuro || 0;
  const revenue = isArbitrage
    ? (Number.isFinite(summary.annualArbitrageNetRevenueEuro)
      ? summary.annualArbitrageNetRevenueEuro
      : (summary.annualArbitrageRevenueEuro || 0) - (summary.annualGridChargeCostEuro || 0))
    : (summary.ricavoImmissioneEuro || 0);
  const saving = isArbitrage ? 0 : (summary.risparmioTotaleEuro || 0);
  const payback = summary.paybackYears || (revenue + saving > 0 ? investment / (revenue + saving) : 0);
  return { investment, revenue, saving, payback };
}

function barChart(labels, series, colors) {
  const max = Math.max(1, ...series.flatMap(item => item.values));
  const groups = labels.map((label, index) => {
    const bars = series.map((item, sIndex) => {
      const height = item.values[index] / max * 160;
      return `<div class="bar" style="height:${height}px;background:${colors[sIndex]}"><span>${item.values[index].toLocaleString("it-IT", { maximumFractionDigits: 0 })}</span></div>`;
    }).join("");
    return `<div class="bar-group"><div class="bars">${bars}</div><div class="x-label">${label}</div></div>`;
  }).join("");
  const legend = series.map((item, index) => `<span><i style="background:${colors[index]}"></i>${item.name}</span>`).join("");
  return `<div class="legend">${legend}</div><div class="chart">${groups}</div>`;
}

function lineChart(labels, series, colors, unit) {
  const width = 920;
  const height = 310;
  const pad = { left: 58, right: 24, top: 24, bottom: 42 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap(item => item.values));
  const x = index => pad.left + index / (labels.length - 1) * plotW;
  const y = value => pad.top + plotH - value / max * plotH;

  const paths = series.map((item, index) => {
    const d = item.values.map((value, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${colors[index]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join("");

  const labelStep = labels.length === 12 && labels.every(label => !/^\d+$/.test(String(label))) ? 1 : 3;
  const xLabels = labels
    .map((label, index) => ({ label, index }))
    .filter(item => item.index % labelStep === 0)
    .map(item => {
      const label = String(item.label);
      const display = label.includes("/") ? label.slice(0, 5) : (label.includes("-") ? label.slice(5) + "/" + label.slice(2, 4) : (/^\d+$/.test(label) ? `${label}:00` : label));
      return `<text x="${x(item.index).toFixed(1)}" y="${height - 14}" text-anchor="middle">${display}</text>`;
    })
    .join("");

  const grid = [0, 0.25, 0.5, 0.75, 1].map(mark => {
    const gy = pad.top + plotH - mark * plotH;
    const value = max * mark;
    return `<line x1="${pad.left}" y1="${gy}" x2="${width - pad.right}" y2="${gy}" /><text x="8" y="${gy + 4}">${value.toLocaleString("it-IT", { maximumFractionDigits: 0 })} ${unit}</text>`;
  }).join("");

  const legend = series.map((item, index) => `<span><i style="background:${colors[index]}"></i>${item.name}</span>`).join("");

  return `<div class="legend">${legend}</div>
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img">
      <g class="grid-lines">${grid}</g>
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
      <g class="x-axis">${xLabels}</g>
      ${paths}
    </svg>`;
}

function dualAxisLineChart(labels, leftSeries, rightSeries, leftColors, rightColors, leftUnit, rightUnit) {
  const width = 920;
  const height = 330;
  const pad = { left: 62, right: 68, top: 30, bottom: 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const leftMax = Math.max(1, ...leftSeries.flatMap(item => item.values));
  const rightMax = Math.max(1, ...rightSeries.flatMap(item => item.values));
  const x = index => pad.left + index / Math.max(1, labels.length - 1) * plotW;
  const yLeft = value => pad.top + plotH - value / leftMax * plotH;
  const yRight = value => pad.top + plotH - value / rightMax * plotH;

  const makePath = (item, y) => item.values
    .map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
    .join(" ");

  const leftPaths = leftSeries.map((item, index) =>
    `<path d="${makePath(item, yLeft)}" fill="none" stroke="${leftColors[index]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`
  ).join("");
  const rightPaths = rightSeries.map((item, index) =>
    `<path d="${makePath(item, yRight)}" fill="none" stroke="${rightColors[index]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="7 5" />`
  ).join("");

  const xLabels = labels
    .map((label, index) => ({ label, index }))
    .filter(item => item.index % 3 === 0 || item.index === labels.length - 1)
    .map(item => `<text x="${x(item.index).toFixed(1)}" y="${height - 14}" text-anchor="middle">${item.label}:00</text>`)
    .join("");

  const grid = [0, 0.25, 0.5, 0.75, 1].map(mark => {
    const gy = pad.top + plotH - mark * plotH;
    const leftValue = leftMax * mark;
    const rightValue = rightMax * mark;
    return `<line x1="${pad.left}" y1="${gy}" x2="${width - pad.right}" y2="${gy}" />
      <text x="8" y="${gy + 4}">${leftValue.toLocaleString("it-IT", { maximumFractionDigits: 0 })} ${leftUnit}</text>
      <text x="${width - 8}" y="${gy + 4}" text-anchor="end" class="right-axis-label">${rightValue.toLocaleString("it-IT", { maximumFractionDigits: 0 })} ${rightUnit}</text>`;
  }).join("");

  const legendItems = [
    ...leftSeries.map((item, index) => ({ ...item, color: leftColors[index] })),
    ...rightSeries.map((item, index) => ({ ...item, color: rightColors[index], dashed: true })),
  ];
  const legend = legendItems.map(item =>
    `<span><i style="background:${item.color}"></i>${item.name}${item.dashed ? " (asse destro)" : ""}</span>`
  ).join("");

  return `<div class="legend">${legend}</div>
    <svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img">
      <g class="grid-lines">${grid}</g>
      <line class="axis" x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" />
      <line class="axis right-axis" x1="${width - pad.right}" y1="${pad.top}" x2="${width - pad.right}" y2="${height - pad.bottom}" />
      <text x="${pad.left}" y="18" class="axis-title">${leftUnit} prelievi / BESS</text>
      <text x="${width - pad.right}" y="18" text-anchor="end" class="axis-title right-axis-label">${rightUnit} FV2</text>
      <g class="x-axis">${xLabels}</g>
      ${leftPaths}
      ${rightPaths}
    </svg>`;
}

function compactLineChart(labels, series, colors, unit) {
  const maxPoints = 90;
  const step = Math.max(1, Math.ceil(labels.length / maxPoints));
  const compactLabels = labels.filter((_, index) => index % step === 0);
  const compactSeries = series.map(item => ({
    name: item.name,
    values: item.values.filter((_, index) => index % step === 0),
  }));
  return lineChart(compactLabels, compactSeries, colors, unit);
}

function combinedOverview() {
  const postFvReduction = summary.prelievoAttualeReteKwh > 0
    ? (1 - summary.prelievoRetePostFvKwh / summary.prelievoAttualeReteKwh) * 100
    : 0;
  const postBessReduction = summary.prelievoAttualeReteKwh > 0
    ? (1 - summary.prelievoRetePostBessKwh / summary.prelievoAttualeReteKwh) * 100
    : 0;
  const cost = barChart(
    ["Attuale", "Post FV", "Post BESS"],
    [{ name: "Costo energia", values: [summary.costoAttualeEuro, summary.costoPostFvEuro, summary.costoPostBessEuro] }],
    ["#2f5d8c"]
  );

  const energy = barChart(
    ["Prelievo rete", "Produzione FV2", "Prelievo rete post FV", "Scarica BESS", "Prelievo rete post BESS", "Immessa post BESS"],
    [{
      name: "Energia",
      values: [
        summary.prelievoAttualeReteKwh,
        summary.produzioneFv2Kwh,
        summary.prelievoRetePostFvKwh,
        summary.kwhScaricatiBess,
        summary.prelievoRetePostBessKwh,
        summary.immessaPostBessKwh,
      ],
    }],
    ["#0f766e"]
  );

  return `<section class="combo">
    <div>
      <h3>Costi energia</h3>
      ${cost}
    </div>
    <div>
      <h3>Bilancio energetico</h3>
      ${energy}
      <div class="chart-notes">
        <span>Riduzione prelievo post FV: ${percent(postFvReduction)}</span>
        <span>Riduzione prelievo post BESS: ${percent(postBessReduction)}</span>
      </div>
    </div>
  </section>`;
}

const overviewChart = combinedOverview();
const roi = roiSummary();
const isArbitrageReport = summary.bessMode === "arbitrage";
const annualSaleRevenue = isArbitrageReport
  ? (summary.annualArbitrageRevenueEuro || 0)
  : (Number.isFinite(summary.annualSaleRevenueEuro)
    ? summary.annualSaleRevenueEuro
    : (summary.ricavoImmissioneEuro || 0) + (summary.annualArbitrageRevenueEuro || 0));

const dailyChart = dualAxisLineChart(
  hourly.map(item => item.hour),
  [
    { name: "Prelievo rete", values: hourly.map(item => item.load) },
    { name: "Prelievo rete post BESS", values: hourly.map(item => item.postBess) },
    { name: "Scarica BESS", values: hourly.map(item => item.discharge) },
  ],
  [
    { name: "Produzione FV2", values: hourly.map(item => item.fv2) },
  ],
  ["#2f5d8c", "#0f766e", "#7c3aed"],
  ["#d97706"],
  "kWh",
  "kWh"
);

const monthlyEnergyChart = lineChart(
  monthly.map(item => item.label),
  [
    { name: "Prelievo energia", values: monthly.map(item => item.load) },
    { name: "Prelievo post FV", values: monthly.map(item => item.postFv) },
    { name: "Prelievo post BESS", values: monthly.map(item => item.postBess) },
  ],
  ["#2f5d8c", "#d97706", "#0f766e"],
  "kWh"
);

const hourlyTableHead = isArbitrageReport
  ? "<tr><th>Ora</th><th>Carica BESS da rete</th><th>Scarica BESS</th><th>Vendita BESS a rete</th><th>Post BESS</th><th>SOC medio [%]</th></tr>"
  : "<tr><th>Ora</th><th>Prelievo</th><th>FV2</th><th>Carica BESS</th><th>Scarica BESS</th><th>Post BESS</th><th>Immessa</th><th>SOC medio [%]</th></tr>";
const hourlyTableRows = hourly.map(item => isArbitrageReport
  ? `<tr><td>${item.hour}</td><td>${kwh(item.charge)}</td><td>${kwh(item.discharge)}</td><td>${kwh(item.arbitrageExport)}</td><td>${kwh(item.postBess)}</td><td>${percent(item.socPct)}</td></tr>`
  : `<tr><td>${item.hour}</td><td>${kwh(item.load)}</td><td>${kwh(item.fv2)}</td><td>${kwh(item.charge)}</td><td>${kwh(item.discharge)}</td><td>${kwh(item.postBess)}</td><td>${kwh(item.export)}</td><td>${percent(item.socPct)}</td></tr>`
).join("");

const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Report KPI FV + BESS</title>
  <style>
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #1f2933; background: #f5f6f4; }
    header { background: #11231f; color: white; padding: 24px 32px; border-bottom: 4px solid #0f766e; }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0; font-size: 26px; }
    h2 { margin: 28px 0 12px; font-size: 18px; }
    .subtitle { margin-top: 6px; color: #c8d7d1; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .card, section { background: white; border: 1px solid #d9dfd7; border-radius: 8px; padding: 14px; }
    .label { color: #64748b; font-size: 12px; font-weight: 700; }
    .value { margin-top: 8px; color: #2f5d8c; font-size: 22px; font-weight: 750; }
    .chart { height: 250px; display: flex; align-items: end; gap: 10px; border-bottom: 1px solid #cbd5c6; padding-top: 30px; overflow-x: auto; }
    .bar-group { min-width: 86px; display: grid; align-items: end; justify-items: center; gap: 6px; }
    .bars { height: 170px; display: flex; align-items: end; gap: 2px; }
    .bar { width: 12px; min-height: 1px; border-radius: 3px 3px 0 0; position: relative; }
    .bar span { display: block; position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); color: #334155; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .x-label { width: 86px; font-size: 11px; color: #64748b; white-space: normal; line-height: 1.2; text-align: center; }
    .legend { display: flex; flex-wrap: wrap; gap: 12px; color: #475569; font-size: 13px; margin-bottom: 8px; }
    .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
    .combo { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .combo h3 { margin: 0 0 12px; font-size: 15px; color: #334155; }
    .chart-notes { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; color: #334155; font-size: 13px; font-weight: 700; }
    .chart-notes span { background: #f7f9f6; border: 1px solid #d9dfd7; border-radius: 6px; padding: 6px 8px; }
    .line-chart { width: 100%; height: auto; background: #fbfcfa; border: 1px solid #d9dfd7; border-radius: 8px; }
    .grid-lines line { stroke: #d9dfd7; stroke-width: 1; }
    .grid-lines text, .x-axis text { fill: #64748b; font-size: 12px; }
    .right-axis-label { fill: #d97706 !important; }
    .axis-title { fill: #475569; font-size: 12px; font-weight: 700; }
    .axis { stroke: #94a3b8; stroke-width: 1; }
    .right-axis { stroke: #d97706; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; background: white; }
    th, td { border-bottom: 1px solid #d9dfd7; padding: 8px; text-align: right; }
    th:first-child, td:first-child { text-align: left; }
    th { color: #64748b; background: #f7f9f6; }
    @media (max-width: 900px) { .combo { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Report KPI FV + BESS</h1>
    <div class="subtitle">Riepilogo simulazione con KPI e grafici</div>
  </header>
  <main>
    <h2>KPI Energia</h2>
    <div class="grid">
      <div class="card"><div class="label">Prelievo attuale rete</div><div class="value">${kwh(summary.prelievoAttualeReteKwh)}</div></div>
      <div class="card"><div class="label">Produzione FV2</div><div class="value">${kwh(summary.produzioneFv2Kwh)}</div></div>
      <div class="card"><div class="label">Surplus FV totale</div><div class="value">${kwh(summary.surplusFvTotaleKwh)}</div></div>
      <div class="card"><div class="label">Prelievo post BESS</div><div class="value">${kwh(summary.prelievoRetePostBessKwh)}</div></div>
      <div class="card"><div class="label">kWh scaricati BESS</div><div class="value">${kwh(summary.kwhScaricatiBess)}</div></div>
      <div class="card"><div class="label">Immessa post BESS</div><div class="value">${kwh(summary.immessaPostBessKwh)}</div></div>
    </div>

    <h2>KPI Euro</h2>
    <div class="grid">
      <div class="card"><div class="label">Costo energia senza intervento</div><div class="value">${euro(summary.costoAttualeEuro)}</div></div>
      <div class="card"><div class="label">Costo energia dopo nuovo FV</div><div class="value">${euro(summary.costoPostFvEuro)}</div></div>
      <div class="card"><div class="label">Costo energia dopo FV + BESS</div><div class="value">${euro(summary.costoPostBessEuro)}</div></div>
      <div class="card"><div class="label">Risparmio netto generato dal BESS</div><div class="value">${euro(summary.risparmioBessEuro)}</div></div>
      <div class="card"><div class="label">Mancato ricavo FV2 caricata nel BESS</div><div class="value">${euro(summary.mancatoRicavoCaricaBessEuro || summary.annualBessOpportunityCostEuro || 0)}</div></div>
      <div class="card"><div class="label">Risparmio annuo sui costi energia</div><div class="value">${euro(summary.risparmioTotaleEuro)}</div></div>
      <div class="card"><div class="label">${isArbitrageReport ? "Ricavo vendita BESS a rete" : "Ricavo annuo da vendita energia FV2 immessa"}</div><div class="value">${euro(isArbitrageReport ? annualSaleRevenue : summary.ricavoImmissioneEuro)}</div></div>
      <div class="card"><div class="label">Beneficio economico annuo totale</div><div class="value">${euro(summary.beneficioTotaleEuro)}</div></div>
    </div>

    <h2>KPI ROI</h2>
    <div class="grid">
      <div class="card"><div class="label">Investimento sistema FV + BESS</div><div class="value">${euro(roi.investment)}</div></div>
      <div class="card"><div class="label">${isArbitrageReport ? "Ricavi annui netti (vendita - ricarica)" : "Ricavi annui da vendita energia FV2"}</div><div class="value">${euro(roi.revenue)}</div></div>
      <div class="card"><div class="label">Risparmio annuo sui costi energia</div><div class="value">${euro(roi.saving)}</div></div>
      <div class="card"><div class="label">Tempo di rientro investimento</div><div class="value">${years(roi.payback)}</div></div>
    </div>

    <h2>Quadro Economico ed Energetico</h2>
    ${overviewChart}

    <h2>Andamento Mensile Prelievi</h2>
    <section>${monthlyEnergyChart}</section>

    <h2>Profilo Medio Giornaliero</h2>
    <section>${dailyChart}</section>

    <h2>Profilo Medio per Ora</h2>
    <table>
      <thead>${hourlyTableHead}</thead>
      <tbody>
        ${hourlyTableRows}
      </tbody>
    </table>
  </main>
</body>
</html>`;

fs.writeFileSync(reportPath, html, "utf8");
console.log(reportPath);
