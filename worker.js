function sendJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

function normalizeZoneName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    outputformat: "json"
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

async function proxyPvgis(request, tool = "seriescalc") {
  const url = new URL(request.url);
  const target = pvgisUrl(url.searchParams, tool);
  const upstream = await fetch(target, {
    headers: {
      "accept": "application/json",
      "user-agent": "calcolobess-worker/1.0"
    }
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

async function punDefault(request, env) {
  const url = new URL(request.url);
  const zone = url.searchParams.get("zone") || "Italia";
  const assetUrl = new URL("/pun_prices_2025.json", request.url);
  const assetResponse = await env.ASSETS.fetch(assetUrl);
  if (!assetResponse.ok) {
    return sendJson({
      error: "Database PUN non trovato",
      detail: "Carica pun_prices_2025.json tra gli asset pubblicati."
    }, 404);
  }

  const db = await assetResponse.json();
  const zones = Array.isArray(db.zones) ? db.zones : [];
  const requestedZone = normalizeZoneName(zone);
  const zoneIndex = zones.findIndex(value => normalizeZoneName(value) === requestedZone);
  if (zoneIndex < 0) {
    return sendJson({
      error: "Zona PUN non trovata",
      detail: `Zona richiesta: ${zone}. Zone disponibili: ${zones.join(", ")}`
    }, 400);
  }

  let total = 0;
  let count = 0;
  const lines = [];
  for (const row of db.rows || []) {
    const date = row[0];
    const hour = row[1];
    const price = row[2] ? Number(row[2][zoneIndex]) : NaN;
    if (!date || !Number.isFinite(Number(hour)) || !Number.isFinite(price)) continue;
    total += price;
    count += 1;
    lines.push(`${date};${hour};${price}`);
  }

  return sendJson({
    csv: lines.join("\n"),
    rowCount: lines.length,
    average: count ? total / count : 0,
    zones,
    year: db.year || 2025,
    detected: `pun_worker_${db.year || 2025}_${zones[zoneIndex]}`
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type"
        }
      });
    }

    if (url.pathname.startsWith("/api/pvgis-performance")) {
      return proxyPvgis(request, "PVcalc");
    }

    if (url.pathname.startsWith("/api/pvgis")) {
      return proxyPvgis(request, "seriescalc");
    }

    if (url.pathname.startsWith("/api/pun-default")) {
      return punDefault(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
