const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const htmlPath = path.join(root, "index.html");
const reportPath = path.join(root, "report_kpi_grafici.html");
const punDbPath = path.join(root, "pun_prices_2025.json");
const demoFiles = new Set([
  "sim_consumption.csv",
  "sim_pv_zero.csv",
  "prova_ufficiale_simulazione.csv",
  "pun_prices_2025.json",
]);
const port = Number(process.env.PORT || 8080);
const clients = new Set();
let punDbCache = null;
const gmeApiBase = "https://api.mercatoelettrico.org/request";

function send(res, status, type, body) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function withLiveReload(html) {
  const script = `
<script>
(() => {
  const source = new EventSource("/__reload");
  source.onmessage = event => {
    if (event.data === "reload") location.reload();
  };
})();
</script>`;
  const bodyEnd = html.lastIndexOf("</body>");
  if (bodyEnd < 0) return html;
  return `${html.slice(0, bodyEnd)}${script}\n${html.slice(bodyEnd)}`;
}

function pvgisUrl(searchParams, tool = "seriescalc") {
  const trackingType = Number(searchParams.get("trackingtype") || "0");
  const mode = searchParams.get("mode") || "grid";
  const isTracking = mode === "tracking" || trackingType > 0;
  const params = new URLSearchParams({
    lat: searchParams.get("lat") || "45",
    lon: searchParams.get("lon") || "9",
    peakpower: searchParams.get("peakpower") || "1",
    loss: searchParams.get("loss") || "14",
    usehorizon: searchParams.get("usehorizon") || "1",
    pvtechchoice: searchParams.get("pvtechchoice") || "crystSi",
    pvcalculation: "1",
    outputformat: "json",
  });

  if (tool === "seriescalc") {
    params.set("startyear", searchParams.get("year") || "2023");
    params.set("endyear", searchParams.get("year") || "2023");
  }

  if (isTracking) {
    params.set("trackingtype", String(trackingType || 2));
    params.set("angle", searchParams.get("angle") || "0");
    params.set("aspect", searchParams.get("aspect") || "0");
    params.set("fixed", "0");
    if (tool === "PVcalc") {
      if (trackingType === 2) {
        params.set("twoaxis", "1");
      } else if (trackingType === 3) {
        params.set("vertical_axis", "1");
        params.set("verticalaxisangle", searchParams.get("angle") || "0");
      } else {
        params.set("inclined_axis", "1");
        params.set("inclinedaxisangle", searchParams.get("angle") || "0");
      }
    }
  } else {
    params.set("fixed", "1");
    params.set("trackingtype", "0");
    params.set("angle", searchParams.get("angle") || "10");
    params.set("aspect", searchParams.get("aspect") || "0");
  }

  const database = searchParams.get("raddatabase");
  if (database) params.set("raddatabase", database);

  return `https://re.jrc.ec.europa.eu/api/v5_3/${tool}?${params.toString()}`;
}

function proxyPvgis(req, res, tool = "seriescalc") {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const target = pvgisUrl(url.searchParams, tool);

  https.get(target, upstream => {
    let body = "";
    upstream.setEncoding("utf8");
    upstream.on("data", chunk => {
      body += chunk;
    });
    upstream.on("end", () => {
      send(res, upstream.statusCode || 502, "application/json; charset=utf-8", body);
    });
  }).on("error", err => {
    send(res, 502, "application/json; charset=utf-8", JSON.stringify({
      error: "PVGIS non raggiungibile",
      detail: err.message,
    }));
  });
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload || {});
    const request = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    }, response => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        responseBody += chunk;
      });
      response.on("end", () => {
        try {
          const json = JSON.parse(responseBody || "{}");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(json.Reason || json.reason || json.error || `HTTP ${response.statusCode}`));
            return;
          }
          resolve(json);
        } catch (error) {
          reject(new Error(`Risposta GME non JSON: ${error.message}`));
        }
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function xmlDecode(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrs(text) {
  const result = {};
  String(text || "").replace(/([A-Za-z_:][A-Za-z0-9_:.-]*)="([^"]*)"/g, (_, key, value) => {
    result[key] = xmlDecode(value);
    return "";
  });
  return result;
}

function findZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("File XLSX non valido: archivio zip non riconosciuto.");

  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let pos = cdOffset;

  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + nameLength).toString("utf8");

    entries.set(name, { method, compressedSize, localOffset });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipText(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return "";
  const local = entry.localOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`Entry XLSX non valida: ${name}`);
  }
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const compressed = buffer.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed.toString("utf8");
  if (entry.method === 8) return require("zlib").inflateRawSync(compressed).toString("utf8");
  throw new Error(`Compressione XLSX non supportata: ${entry.method}`);
}

function firstZipEntryName(entries, extension = ".json") {
  for (const name of entries.keys()) {
    if (String(name).toLowerCase().endsWith(extension)) return name;
  }
  return entries.keys().next().value || "";
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRegex = /<[^:>]*:?si\b[^>]*>([\s\S]*?)<\/[^:>]*:?si>/g;
  let match;
  while ((match = siRegex.exec(xml))) {
    const parts = [];
    match[1].replace(/<[^:>]*:?t\b[^>]*>([\s\S]*?)<\/[^:>]*:?t>/g, (_, text) => {
      parts.push(xmlDecode(text));
      return "";
    });
    strings.push(parts.join(""));
  }
  return strings;
}

function columnIndex(ref) {
  const letters = String(ref || "").replace(/[^A-Z]/g, "");
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function excelDate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const text = String(value || "").trim();
    const dmyMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
    if (dmyMatch) {
      const year = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
      return [
        dmyMatch[1].padStart(2, "0"),
        dmyMatch[2].padStart(2, "0"),
        year,
      ].join("/");
    }
    const ymdMatch = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/);
    if (ymdMatch) {
      return [
        ymdMatch[3].padStart(2, "0"),
        ymdMatch[2].padStart(2, "0"),
        ymdMatch[1],
      ].join("/");
    }
    return text;
  }
  const utc = Date.UTC(1899, 11, 30) + numeric * 86400000;
  const date = new Date(utc);
  return [
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    date.getUTCFullYear(),
  ].join("/");
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  const rowRegex = /<[^:>]*:?row\b[^>]*>([\s\S]*?)<\/[^:>]*:?row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml))) {
    const row = [];
    let nextIndex = 0;
    const cellRegex = /<[^:>]*:?c\b([^>]*)>([\s\S]*?)<\/[^:>]*:?c>/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const cellAttrs = attrs(cellMatch[1]);
      let index = columnIndex(cellAttrs.r);
      if (index < 0) index = nextIndex;
      const valueMatch = cellMatch[2].match(/<[^:>]*:?v\b[^>]*>([\s\S]*?)<\/[^:>]*:?v>/);
      const inlineMatches = [...cellMatch[2].matchAll(/<[^:>]*:?t\b[^>]*>([\s\S]*?)<\/[^:>]*:?t>/g)];
      let value = "";
      if (cellAttrs.t === "inlineStr") {
        value = inlineMatches.map(item => xmlDecode(item[1])).join("");
      } else if (valueMatch) {
        value = xmlDecode(valueMatch[1]);
        if (cellAttrs.t === "s") value = sharedStrings[Number(value)] || "";
      }
      row[index] = value;
      nextIndex = index + 1;
    }
    rows.push(row.map(value => value ?? ""));
  }
  return rows;
}

function firstWorksheetPath(buffer, entries) {
  const workbook = readZipText(buffer, entries, "xl/workbook.xml");
  const rels = readZipText(buffer, entries, "xl/_rels/workbook.xml.rels");
  const sheetMatch = workbook.match(/<[^:>]*:?sheet\b[^>]*r:id="([^"]+)"/);
  if (!sheetMatch) return "xl/worksheets/sheet1.xml";
  const relId = sheetMatch[1];
  const relRegex = /<Relationship\b([^>]*)\/?>/g;
  let relMatch;
  while ((relMatch = relRegex.exec(rels))) {
    const relAttrs = attrs(relMatch[1]);
    if (relAttrs.Id === relId) {
      const target = String(relAttrs.Target || "").replace(/^\/+/, "");
      return target.startsWith("xl/") ? target : `xl/${target}`;
    }
  }
  return "xl/worksheets/sheet1.xml";
}

function isIntervalHeader(value) {
  return /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(String(value || "").trim());
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  const raw = String(value).trim();
  const text = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function normalizeHour(value) {
  const raw = String(value ?? "").trim();
  const timeMatch = raw.match(/^(\d{1,2}):(\d{2})/);
  if (timeMatch) return Number(timeMatch[1]);
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return NaN;
  if (numeric > 0 && numeric < 1) return Math.round(numeric * 24) % 24;
  return numeric;
}

function normalizePunHour(value) {
  const hour = normalizeHour(value);
  if (!Number.isFinite(hour)) return NaN;
  if (hour >= 1 && hour <= 24) return hour - 1;
  return hour;
}

function normalizeZoneName(value) {
  return String(value || "").trim().toLowerCase();
}

function gmeZoneAliases(zone) {
  const normalized = normalizeZoneName(zone);
  const aliases = {
    "italia": ["pun", "italia"],
    "nord": ["nord"],
    "centro nord": ["cnor", "centro nord", "centronord"],
    "centro sud": ["csud", "centro sud", "centrosud"],
    "sud": ["sud"],
    "sardegna": ["sard", "sardegna"],
    "sicilia": ["sici", "sicilia"],
    "calabria": ["cala", "calabria"],
  };
  return new Set([normalized, ...(aliases[normalized] || [])].map(normalizeZoneName));
}

function normalizeGmeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return text;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function flattenObjects(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach(item => flattenObjects(item, result));
    return result;
  }
  if (value && typeof value === "object") {
    if (
      Object.prototype.hasOwnProperty.call(value, "FlowDate") &&
      Object.prototype.hasOwnProperty.call(value, "Hour") &&
      Object.prototype.hasOwnProperty.call(value, "Zone") &&
      Object.prototype.hasOwnProperty.call(value, "Price")
    ) {
      result.push(value);
    }
    Object.values(value).forEach(item => flattenObjects(item, result));
  }
  return result;
}

function decodeGmeContentResponse(contentResponse) {
  const buffer = Buffer.from(contentResponse || "", "base64");
  const entries = findZipEntries(buffer);
  const jsonEntry = firstZipEntryName(entries, ".json");
  if (!jsonEntry) throw new Error("Archivio GME senza file JSON.");
  const jsonText = readZipText(buffer, entries, jsonEntry);
  return JSON.parse(jsonText || "[]");
}

async function fetchGmeZonalPrices(zone, intervalStart, intervalEnd) {
  const login = process.env.GME_API_LOGIN || process.env.GME_LOGIN;
  const password = process.env.GME_API_PASSWORD || process.env.GME_PASSWORD;
  if (!login || !password) {
    throw new Error("Credenziali GME API non configurate. Imposta GME_API_LOGIN e GME_API_PASSWORD.");
  }

  const auth = await postJson(`${gmeApiBase}/api/v1/Auth`, { Login: login, Password: password });
  const token = auth.token || auth.Token;
  if (!auth.Success || !token) {
    throw new Error(auth.Reason || "Autenticazione GME non riuscita.");
  }

  const attributes = Number(intervalStart) >= 20251001 ? { GranularityType: "PT60" } : {};
  const payload = {
    Platform: "PublicMarketResults",
    Segment: "MGP",
    DataName: "ME_ZonalPrices",
    IntervalStart: Number(intervalStart),
    IntervalEnd: Number(intervalEnd),
    Attributes: attributes,
  };
  const response = await postJson(`${gmeApiBase}/api/v1/RequestData`, payload, {
    Authorization: `Bearer ${token}`,
  });

  const result = String(response.ResultRequest || response.resultRequest || "");
  if (result && !/^ok|success/i.test(result)) {
    throw new Error(result);
  }

  const content = response.ContentResponse || response.contentResponse;
  if (!content) throw new Error("Risposta GME senza contenuto dati.");

  const decoded = decodeGmeContentResponse(content);
  const records = flattenObjects(decoded);
  const aliases = gmeZoneAliases(zone);
  let total = 0;
  let count = 0;
  const lines = [];
  const zones = new Set();

  for (const record of records) {
    const recordZone = normalizeZoneName(record.Zone);
    zones.add(String(record.Zone || ""));
    if (!aliases.has(recordZone)) continue;
    const date = normalizeGmeDate(record.FlowDate);
    const hour = normalizePunHour(record.Hour);
    const price = toNumber(record.Price);
    if (!date || !Number.isFinite(hour) || !Number.isFinite(price)) continue;
    total += price;
    count += 1;
    lines.push(`${date};${hour};${price}`);
  }

  if (!lines.length) {
    throw new Error(`Nessun prezzo GME trovato per zona ${zone}. Zone disponibili: ${[...zones].filter(Boolean).join(", ")}`);
  }

  return {
    csv: lines.join("\n"),
    rowCount: lines.length,
    average: count ? total / count : 0,
    zones: [...zones].filter(Boolean),
    intervalStart,
    intervalEnd,
    source: "gme_api",
    detected: `gme_api_ME_ZonalPrices_${zone}`,
  };
}

function normalizeXlsxRows(rows) {
  if (!rows.length) return { csv: "", rowCount: 0, detected: "empty" };
  const header = rows[0].map(value => String(value || "").trim());
  const intervalColumns = header
    .map((value, index) => ({ value, index }))
    .filter(item => isIntervalHeader(item.value));

  if (intervalColumns.length >= 24) {
    const lines = [];
    for (const row of rows.slice(1)) {
      const date = excelDate(row[0]);
      if (!date || date === "0") continue;
      for (let hour = 0; hour < 24; hour += 1) {
        const sum = intervalColumns
          .filter(item => Number(item.value.slice(0, 2)) === hour)
          .reduce((total, item) => total + toNumber(row[item.index]), 0);
        lines.push(`${date};${hour};${sum}`);
      }
    }
    return {
      csv: lines.join("\n"),
      rowCount: lines.length,
      detected: "aggregato_15_minuti_sommato_a_ore",
    };
  }

  const first = header.map(value => value.toLowerCase());
  const hasHeader = first.includes("data") || first.includes("ora");
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const csvLines = dataRows
    .map((row, index) => {
      const date = excelDate(row[0]);
      const hour = normalizeHour(row[1]);
      const normalizedHour = Number.isFinite(hour) ? hour : index % 24;
      const value = row[2] ?? "";
      const pun = row[3] ?? "";
      return [date, normalizedHour, value, pun].join(";");
    })
    .filter(line => line.replace(/[;]/g, "").trim());
  return {
    csv: csvLines.join("\n"),
    rowCount: csvLines.length,
    detected: hasHeader ? "righe_orarie_con_intestazione" : "righe_orarie",
  };
}

function readXlsxRowsBase64(base64) {
  const buffer = Buffer.from(base64, "base64");
  const entries = findZipEntries(buffer);
  const sharedStrings = parseSharedStrings(readZipText(buffer, entries, "xl/sharedStrings.xml"));
  const sheetPath = firstWorksheetPath(buffer, entries);
  const sheetXml = readZipText(buffer, entries, sheetPath);
  const rows = parseSheetRows(sheetXml, sharedStrings);
  return { sheetPath, rows };
}

function parseXlsxBase64(base64) {
  const { sheetPath, rows } = readXlsxRowsBase64(base64);
  return {
    sheetPath,
    ...normalizeXlsxRows(rows),
  };
}

function decodeTextBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString("utf16le");
  }
  const sample = buffer.slice(0, Math.min(buffer.length, 200));
  let zeroBytes = 0;
  for (const byte of sample) {
    if (byte === 0) zeroBytes += 1;
  }
  if (zeroBytes > sample.length / 4) {
    return buffer.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function stripCellText(value) {
  return xmlDecode(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim());
}

function parseSpreadsheetMlRows(text) {
  const rows = [];
  const rowRegex = /<[^:>]*:?Row\b[^>]*>([\s\S]*?)<\/[^:>]*:?Row>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(text))) {
    const row = [];
    const cellRegex = /<[^:>]*:?Cell\b([^>]*)>([\s\S]*?)<\/[^:>]*:?Cell>/gi;
    let cellMatch;
    let index = 0;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const cellAttrs = attrs(cellMatch[1]);
      const explicitIndex = Number(cellAttrs["ss:Index"] || cellAttrs.Index);
      if (Number.isFinite(explicitIndex) && explicitIndex > 0) index = explicitIndex - 1;
      const dataMatch = cellMatch[2].match(/<[^:>]*:?Data\b[^>]*>([\s\S]*?)<\/[^:>]*:?Data>/i);
      row[index] = stripCellText(dataMatch ? dataMatch[1] : cellMatch[2]);
      index += 1;
    }
    if (row.some(value => String(value || "").trim())) rows.push(row);
  }
  return rows;
}

function parseHtmlTableRows(text) {
  const rows = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(text))) {
    const row = [];
    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      row.push(stripCellText(cellMatch[1]));
    }
    if (row.some(value => String(value || "").trim())) rows.push(row);
  }
  return rows;
}

function parseLegacyExcelTextBase64(base64) {
  const buffer = Buffer.from(base64 || "", "base64");
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xe011cfd0) {
    throw new Error("Formato XLS binario non supportato dal prototipo: salva il file come XLSX o CSV e ricaricalo.");
  }
  const text = decodeTextBuffer(buffer);
  let rows = parseSpreadsheetMlRows(text);
  let detected = "xls_xml";
  if (!rows.length) {
    rows = parseHtmlTableRows(text);
    detected = "xls_html";
  }
  if (!rows.length) {
    throw new Error("File XLS non riconosciuto: salva il file come XLSX o CSV e ricaricalo.");
  }
  return {
    sheetPath: detected,
    ...normalizeXlsxRows(rows),
  };
}

function parseSpreadsheetBase64(base64, filename = "") {
  const buffer = Buffer.from(base64 || "", "base64");
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return parseXlsxBase64(base64);
  }
  return parseLegacyExcelTextBase64(base64);
}

function parsePunXlsxBase64(base64, zone) {
  const { sheetPath, rows } = readXlsxRowsBase64(base64);
  if (!rows.length) return { sheetPath, csv: "", rowCount: 0, average: 0, zones: [], detected: "empty" };

  const header = rows[0].map(value => String(value || "").trim());
  const zones = header.slice(2).filter(Boolean);
  const dateIndex = header.findIndex(value => normalizeZoneName(value) === "data");
  const hourIndex = header.findIndex(value => normalizeZoneName(value) === "ora");
  const requestedZone = normalizeZoneName(zone);
  const zoneIndex = header.findIndex(value => normalizeZoneName(value) === requestedZone);

  if (dateIndex < 0 || hourIndex < 0 || zoneIndex < 0) {
    throw new Error(`Zona PUN non trovata: ${zone || ""}. Zone disponibili: ${zones.join(", ")}`);
  }

  let total = 0;
  let count = 0;
  const lines = [];
  for (const row of rows.slice(1)) {
    const date = excelDate(row[dateIndex]);
    const hour = normalizePunHour(row[hourIndex]);
    const rawPrice = row[zoneIndex];
    const price = toNumber(row[zoneIndex]);
    if (!date || !Number.isFinite(hour) || rawPrice === undefined || rawPrice === "") continue;
    total += price;
    count += 1;
    lines.push(`${date};${hour};${price}`);
  }

  return {
    sheetPath,
    csv: lines.join("\n"),
    rowCount: lines.length,
    average: count ? total / count : 0,
    zones,
    detected: `pun_orario_${header[zoneIndex]}`,
  };
}

function loadPunDb() {
  if (!punDbCache) {
    punDbCache = JSON.parse(fs.readFileSync(punDbPath, "utf8"));
  }
  return punDbCache;
}

function punFromDefaultDb(zone) {
  const db = loadPunDb();
  const zones = db.zones || [];
  const requestedZone = normalizeZoneName(zone);
  const zoneIndex = zones.findIndex(value => normalizeZoneName(value) === requestedZone);
  if (zoneIndex < 0) {
    throw new Error(`Zona PUN non trovata: ${zone || ""}. Zone disponibili: ${zones.join(", ")}`);
  }

  let total = 0;
  let count = 0;
  const lines = [];
  for (const row of db.rows || []) {
    const date = row[0];
    const hour = row[1];
    const price = row[2] ? row[2][zoneIndex] : undefined;
    if (price === undefined || price === null || !Number.isFinite(Number(price))) continue;
    total += Number(price);
    count += 1;
    lines.push(`${date};${hour};${price}`);
  }

  return {
    csv: lines.join("\n"),
    rowCount: lines.length,
    average: count ? total / count : 0,
    zones,
    year: db.year || 2025,
    detected: `pun_database_${db.year || 2025}_${zones[zoneIndex]}`,
  };
}

function parseXlsxRequest(req, res) {
  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 20 * 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body || "{}");
      const result = parseSpreadsheetBase64(payload.base64 || "", payload.filename || "");
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(result));
    } catch (error) {
      send(res, 400, "application/json; charset=utf-8", JSON.stringify({
        error: "Impossibile leggere il file Excel",
        detail: error.message,
      }));
    }
  });
}

function parsePunXlsxRequest(req, res) {
  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 20 * 1024 * 1024) req.destroy();
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body || "{}");
      const result = parsePunXlsxBase64(payload.base64 || "", payload.zone || "Italia");
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(result));
    } catch (error) {
      send(res, 400, "application/json; charset=utf-8", JSON.stringify({
        error: "Impossibile leggere il file PUN XLSX",
        detail: error.message,
      }));
    }
  });
}

function punDefaultRequest(req, res) {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const result = punFromDefaultDb(url.searchParams.get("zone") || "Italia");
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(result));
  } catch (error) {
    send(res, 500, "application/json; charset=utf-8", JSON.stringify({
      error: "Impossibile leggere il database PUN locale",
      detail: error.message,
    }));
  }
}

function yyyymmdd(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
}

async function punGmeRequest(req, res) {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const now = new Date();
    const year = Number(url.searchParams.get("year")) || now.getFullYear();
    const defaultStart = `${year}0101`;
    const defaultEndDate = year === now.getFullYear()
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
      : new Date(year, 11, 31);
    const intervalStart = url.searchParams.get("start") || defaultStart;
    const intervalEnd = url.searchParams.get("end") || yyyymmdd(defaultEndDate);
    const zone = url.searchParams.get("zone") || "Italia";
    const result = await fetchGmeZonalPrices(zone, intervalStart, intervalEnd);
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(result));
  } catch (error) {
    send(res, 502, "application/json; charset=utf-8", JSON.stringify({
      error: "Impossibile aggiornare i prezzi da GME",
      detail: error.message,
    }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/__reload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    });
    res.write("retry: 1000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.url.startsWith("/api/pvgis-performance")) {
    proxyPvgis(req, res, "PVcalc");
    return;
  }

  if (req.url.startsWith("/api/pvgis")) {
    proxyPvgis(req, res);
    return;
  }

  if (req.url === "/api/parse-xlsx" && req.method === "POST") {
    parseXlsxRequest(req, res);
    return;
  }

  if (req.url === "/api/parse-pun-xlsx" && req.method === "POST") {
    parsePunXlsxRequest(req, res);
    return;
  }

  if (req.url.startsWith("/api/pun-default")) {
    punDefaultRequest(req, res);
    return;
  }

  if (req.url.startsWith("/api/pun-gme")) {
    punGmeRequest(req, res);
    return;
  }

  if (req.url === "/" || req.url === "/index.html" || req.url === "/prototipo_simulatore.html") {
    fs.readFile(htmlPath, "utf8", (err, html) => {
      if (err) {
        send(res, 500, "text/plain; charset=utf-8", String(err));
        return;
      }
      send(res, 200, "text/html; charset=utf-8", withLiveReload(html));
    });
    return;
  }

  if (req.url === "/report_kpi_grafici.html") {
    fs.readFile(reportPath, "utf8", (err, html) => {
      if (err) {
        send(res, 404, "text/plain; charset=utf-8", "Report non ancora generato");
        return;
      }
      send(res, 200, "text/html; charset=utf-8", html);
    });
    return;
  }

  const cleanPath = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  if (demoFiles.has(cleanPath)) {
    const filePath = path.join(root, cleanPath);
    fs.readFile(filePath, "utf8", (err, content) => {
      if (err) {
        send(res, 404, "text/plain; charset=utf-8", "File demo non trovato");
        return;
      }
      const type = cleanPath.endsWith(".json") ? "application/json; charset=utf-8" : "text/csv; charset=utf-8";
      send(res, 200, type, content);
    });
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "Not found");
});

fs.watch(htmlPath, { persistent: false }, () => {
  for (const client of clients) {
    client.write("data: reload\n\n");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Live preview: http://127.0.0.1:${port}/`);
});
