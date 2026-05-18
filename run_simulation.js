const fs = require("fs");
const path = require("path");

const root = __dirname;
const consumptionPath = path.join(root, "sim_consumption.csv");
const pvPath = path.join(root, "sim_pv_zero.csv");
const outputPath = path.join(root, "prova_ufficiale_simulazione.csv");

const params = {
  fvKwp: 500,
  specificYield: 1200,
  monthlyProfile: [5, 6, 8, 10, 11, 12, 13, 12, 9, 7, 4, 3],
  bessKwh: 466,
  chargePowerKw: 200,
  dischargePowerKw: 200,
  socMinPct: 10,
  socInitialPct: 100,
  etaCharge: 0.95,
  etaDischarge: 0.95,
  chargeFromSurplus: true,
  allowGridCharge: false,
  punChargeThreshold: 80,
  punDischargeThreshold: 130,
  gridImportLimitKw: 5200,
  gridExportLimitKw: 5200,
  fixedPriceEuroKwh: 0.25,
  sellPriceEuroKwh: 0.07,
  costFvEuroKwp: 700,
  costBessEuro: 139800,
};

function parseNumber(value) {
  if (value === undefined || value === null) return NaN;
  const text = String(value).trim();
  if (!text) return NaN;
  if (text.includes(",")) return Number(text.replace(/\./g, "").replace(",", "."));
  return Number(text);
}

function splitLine(line) {
  return line.includes(";") ? line.split(";") : line.split(",");
}

function rowKey(date, hour) {
  return `${String(date).trim()}|${Number(hour)}`;
}

function parseRows(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = splitLine(line);
      return {
        date: parts[0],
        hour: parseNumber(parts[1]),
        value: parseNumber(parts[2]) || 0,
      };
    })
    .filter(row => Number.isFinite(row.hour));
}

function parseMonth(date) {
  const parts = String(date).trim().split(/[/-]/);
  return Number(parts.length === 3 ? parts[1] : 1) || 1;
}

function parseYear(date) {
  const parts = String(date).trim().split(/[/-]/);
  return Number(parts.length === 3 ? parts[2] : 2025) || 2025;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function quickPvProduction(row) {
  const hourShape = {
    7: 0.02, 8: 0.05, 9: 0.09, 10: 0.13, 11: 0.16,
    12: 0.18, 13: 0.16, 14: 0.12, 15: 0.07, 16: 0.02,
  };
  const shapeTotal = Object.values(hourShape).reduce((sum, value) => sum + value, 0);
  const hourShare = (hourShape[Number(row.hour)] || 0) / shapeTotal;
  const month = Math.min(12, Math.max(1, parseMonth(row.date)));
  const year = parseYear(row.date);
  const profileTotal = params.monthlyProfile.reduce((sum, value) => sum + value, 0);
  const monthShare = params.monthlyProfile[month - 1] / profileTotal;
  const annualProduction = params.fvKwp * params.specificYield;
  return annualProduction * monthShare / daysInMonth(year, month) * hourShare;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function socPercent(socKwh) {
  return params.bessKwh > 0 ? Math.min(100, Math.max(0, socKwh / params.bessKwh * 100)) : 0;
}

function allocateExportBySource(fileSurplus, fv2Surplus, exportLimit) {
  const limit = exportLimit > 0 ? exportLimit : Infinity;
  const fileExport = Math.min(fileSurplus, limit);
  const fv2Export = Math.min(fv2Surplus, Math.max(0, limit - fileExport));
  return {
    fileExport,
    fv2Export,
    totalExport: fileExport + fv2Export,
  };
}

const consumption = parseRows(consumptionPath).map(row => ({
  date: row.date,
  hour: row.hour,
  load: row.value,
}));

const pvMap = new Map(parseRows(pvPath).map(row => [rowKey(row.date, row.hour), row.value]));
let soc = Math.min(params.bessKwh, Math.max(params.bessKwh * params.socMinPct / 100, params.bessKwh * params.socInitialPct / 100));
const rows = [];
const totals = {
  load: 0,
  exportedFvFile: 0,
  pv2: 0,
  surplusFv: 0,
  postFv: 0,
  discharge: 0,
  postBess: 0,
  exportResidual: 0,
  exportRevenueFv2: 0,
  exportWithoutBess: 0,
  lostExportForBess: 0,
  lostExportRevenueFv2: 0,
  currentCost: 0,
  postFvCost: 0,
  postBessCost: 0,
};

for (const row of consumption) {
  const exportedFv1 = pvMap.get(rowKey(row.date, row.hour)) || 0;
  const price = params.fixedPriceEuroKwh;
  const fv2 = quickPvProduction(row);
  const fv2ToLoad = Math.min(row.load, fv2);
  const postFv = Math.max(0, row.load - fv2ToLoad);
  const surplusFv2 = Math.max(0, fv2 - fv2ToLoad);
  const surplusFv = exportedFv1 + surplusFv2;
  let remainingFileSurplus = exportedFv1;
  let remainingFv2Surplus = surplusFv2;
  let chargeFromFv = 0;
  let chargeFromFvFile = 0;
  let chargeFromFv2 = 0;
  const hasSurplusFv = surplusFv > 0;

  if (params.chargeFromSurplus && surplusFv > 0) {
    const roomFromPv = Math.max(0, (params.bessKwh - soc) / params.etaCharge);
    chargeFromFv = Math.min(surplusFv, params.chargePowerKw, roomFromPv);
    chargeFromFvFile = Math.min(remainingFileSurplus, chargeFromFv);
    chargeFromFv2 = chargeFromFv - chargeFromFvFile;
    remainingFileSurplus -= chargeFromFvFile;
    remainingFv2Surplus -= chargeFromFv2;
    soc += chargeFromFv * params.etaCharge;
  }

  const deliverable = Math.max(0, (soc - params.bessKwh * params.socMinPct / 100) * params.etaDischarge);
  const discharge = hasSurplusFv ? 0 : Math.min(postFv, params.dischargePowerKw, deliverable);
  soc -= discharge / params.etaDischarge;

  const postBess = Math.max(0, postFv - discharge);
  const exportWithoutBessParts = allocateExportBySource(exportedFv1, surplusFv2, params.gridExportLimitKw);
  const exportResidualParts = allocateExportBySource(remainingFileSurplus, remainingFv2Surplus, params.gridExportLimitKw);
  const exportWithoutBess = exportWithoutBessParts.totalExport;
  const exportResidual = exportResidualParts.totalExport;
  const exportResidualFv2 = exportResidualParts.fv2Export;
  const lostExportForBess = Math.max(0, exportWithoutBess - exportResidual);
  const lostExportRevenueFv2 = Math.max(0, exportWithoutBessParts.fv2Export - exportResidualFv2);
  const remainingSurplus = remainingFileSurplus + remainingFv2Surplus;
  const curtailment = Math.max(0, remainingSurplus - exportResidual);

  totals.load += row.load;
  totals.exportedFvFile += exportedFv1;
  totals.pv2 += fv2;
  totals.surplusFv += surplusFv;
  totals.postFv += postFv;
  totals.discharge += discharge;
  totals.postBess += postBess;
  totals.exportResidual += exportResidual;
  totals.exportRevenueFv2 += exportResidualFv2;
  totals.exportWithoutBess += exportWithoutBess;
  totals.lostExportForBess += lostExportForBess;
  totals.lostExportRevenueFv2 += lostExportRevenueFv2;
  totals.currentCost += row.load * price;
  totals.postFvCost += postFv * price;
  totals.postBessCost += postBess * price;

  rows.push([
    row.date, row.hour, price * 1000, row.load, exportedFv1, fv2, surplusFv,
    postFv, chargeFromFv, discharge, socPercent(soc), postBess, exportResidual,
    exportResidualFv2, curtailment,
  ]);
}

const annualFactor = consumption.length ? 8760 / consumption.length : 0;
const summary = {
  rows: consumption.length,
  annualFactor,
  bessKwh: params.bessKwh,
  socMinPct: params.socMinPct,
  socInitialPct: params.socInitialPct,
  prelievoAttualeReteKwh: totals.load * annualFactor,
  immessaFvFileKwh: totals.exportedFvFile * annualFactor,
  produzioneFv2Kwh: totals.pv2 * annualFactor,
  surplusFvTotaleKwh: totals.surplusFv * annualFactor,
  prelievoRetePostFvKwh: totals.postFv * annualFactor,
  kwhScaricatiBess: totals.discharge * annualFactor,
  prelievoRetePostBessKwh: totals.postBess * annualFactor,
  exportSenzaBessKwh: totals.exportWithoutBess * annualFactor,
  mancataCessioneCaricaBessKwh: totals.lostExportForBess * annualFactor,
  mancataCessioneCaricaBessFv2Kwh: totals.lostExportRevenueFv2 * annualFactor,
  immessaPostBessKwh: totals.exportResidual * annualFactor,
  immessaPostBessFv2ValorizzataKwh: totals.exportRevenueFv2 * annualFactor,
  costoAttualeEuro: totals.currentCost * annualFactor,
  costoPostFvEuro: totals.postFvCost * annualFactor,
  costoPostBessEuro: totals.postBessCost * annualFactor,
  risparmioFvEuro: (totals.currentCost - totals.postFvCost) * annualFactor,
  risparmioBessLordoEuro: (totals.postFvCost - totals.postBessCost) * annualFactor,
  mancatoRicavoCaricaBessEuro: totals.lostExportRevenueFv2 * annualFactor * params.sellPriceEuroKwh,
  risparmioBessEuro: (totals.postFvCost - totals.postBessCost) * annualFactor - totals.lostExportRevenueFv2 * annualFactor * params.sellPriceEuroKwh,
  risparmioTotaleEuro: (totals.currentCost - totals.postBessCost) * annualFactor,
  ricavoImmissioneEuro: totals.exportRevenueFv2 * annualFactor * params.sellPriceEuroKwh,
};
summary.beneficioTotaleEuro = summary.risparmioTotaleEuro + summary.ricavoImmissioneEuro;
summary.investmentEuro = params.fvKwp * params.costFvEuroKwp + params.costBessEuro;
summary.paybackYears = summary.beneficioTotaleEuro > 0 ? summary.investmentEuro / summary.beneficioTotaleEuro : 0;

const lines = [
  "RIEPILOGO PROVA",
  "campo;valore",
  ...Object.entries(summary).map(row => row.map(csvCell).join(";")),
  "",
  "RISULTATI ORARI",
  [
    "Data", "Ora", "Prezzo", "Prelievo rete", "Immesso FV file", "Prod. FV2",
    "Surplus FV totale", "Prelievo rete Post FV", "Carica BESS", "Scarica BESS",
    "SOC [%]", "Prelievo rete Post BESS", "Immessa post BESS",
    "Immessa post BESS FV2 valorizzata", "FV non valorizzabile",
  ].join(";"),
  ...rows.map(row => row.map(csvCell).join(";")),
];

fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
console.log(JSON.stringify({ outputPath, summary }, null, 2));
