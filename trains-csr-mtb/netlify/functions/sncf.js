// netlify/functions/sncf.js
const SNCF_BASE = "https://api.sncf.com/v1/coverage/sncf";

const STATION_NAMES = {
  castelsarrasin: "Castelsarrasin",
  montauban:      "Montauban Ville Bourbon",
};

const ID_CACHE = {};

async function getStopAreaId(name, authHeader) {
  if (ID_CACHE[name]) return ID_CACHE[name];
  const url = `${SNCF_BASE}/places?q=${encodeURIComponent(name)}&type[]=stop_area&count=3`;
  const resp = await fetch(url, { headers: { Authorization: authHeader } });
  if (!resp.ok) throw new Error(`Places API error ${resp.status}`);
  const data = await resp.json();
  const places = data.places || [];
  const match = places.find(p => p.embedded_type === "stop_area");
  if (!match) throw new Error(`Gare introuvable : ${name}`);
  const id = match.stop_area?.id || match.id;
  ID_CACHE[name] = id;
  return id;
}

const fmt = (s) => s ? `${s.slice(9,11)}:${s.slice(11,13)}` : null;

const parseNavitia = (s) => new Date(
  `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}`
);

function extractTrack(sp) {
  if (!sp) return null;
  if (sp.platform_code && sp.platform_code.trim()) return sp.platform_code.trim();
  const name = sp.name || '';
  const m = name.match(/\b(?:voie|quai)\s+(\d+[A-Za-z]?)\b/i);
  if (m) return m[1];
  const m2 = name.match(/\((?:voie|quai)\s*(\d+[A-Za-z]?)\)/i);
  if (m2) return m2[1];
  return null;
}

exports.handler = async (event) => {
  const token = process.env.SNCF_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: "SNCF_TOKEN manquant" }) };

  const { from, to, datetime: datetimeParam } = event.queryStringParameters || {};
  if (!from || !to) return { statusCode: 400, body: JSON.stringify({ error: "Paramètres from/to requis" }) };

  const fromName = STATION_NAMES[from];
  const toName   = STATION_NAMES[to];
  if (!fromName || !toName) return { statusCode: 400, body: JSON.stringify({ error: "Gare inconnue" }) };

  const authHeader = "Basic " + Buffer.from(token + ":").toString("base64");

  // Utiliser le datetime fourni par le client, sinon maintenant
  let datetime = datetimeParam;
  if (!datetime) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    datetime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  try {
    const [fromId, toId] = await Promise.all([
      getStopAreaId(fromName, authHeader),
      getStopAreaId(toName, authHeader),
    ]);

    const deptUrl = `${SNCF_BASE}/stop_areas/${encodeURIComponent(fromId)}/departures?from_datetime=${datetime}&data_freshness=realtime&count=50&depth=3`;
    const arrvUrl = `${SNCF_BASE}/stop_areas/${encodeURIComponent(toId)}/arrivals?from_datetime=${datetime}&data_freshness=realtime&count=50&depth=3`;

    const [deptResp, arrvResp] = await Promise.all([
      fetch(deptUrl, { headers: { Authorization: authHeader } }),
      fetch(arrvUrl, { headers: { Authorization: authHeader } }),
    ]);

    if (!deptResp.ok) {
      const text = await deptResp.text();
      return { statusCode: deptResp.status, body: JSON.stringify({ error: text }) };
    }

    const [deptData, arrvData] = await Promise.all([
      deptResp.json(),
      arrvResp.ok ? arrvResp.json() : Promise.resolve({ arrivals: [] }),
    ]);

    const arrivalByTrain = {};
    for (const a of (arrvData.arrivals || [])) {
      const trainNum = a.display_informations?.headsign || "";
      if (!trainNum) continue;
      const arr_base  = a.stop_date_time?.base_arrival_date_time;
      const arr_real  = a.stop_date_time?.arrival_date_time;
      const arr_track = extractTrack(a.stop_point);
      arrivalByTrain[trainNum] = {
        arr_scheduled: fmt(arr_base),
        arr_realtime:  fmt(arr_real),
        arr_track,
        _sp_debug: { id: a.stop_point?.id, name: a.stop_point?.name, platform_code: a.stop_point?.platform_code },
      };
    }

    const departures = (deptData.departures || [])
      .filter(d => !!arrivalByTrain[d.display_informations?.headsign || ""])
      .map((d) => {
        const base_dt   = d.stop_date_time?.base_departure_date_time;
        const real_dt   = d.stop_date_time?.departure_date_time;
        const dep_track = extractTrack(d.stop_point);
        const train_num       = d.display_informations?.headsign || "";
        const direction       = d.display_informations?.direction || "";
        const network         = d.display_informations?.network || "";
        const commercial_mode = d.display_informations?.commercial_mode || "";
        const disruptions     = (d.disruptions || []).map(dis => dis.messages?.[0]?.text || "").filter(Boolean);

        let delay_min = 0;
        if (base_dt && real_dt && base_dt !== real_dt) {
          delay_min = Math.round((parseNavitia(real_dt) - parseNavitia(base_dt)) / 60000);
        }

        const arrInfo = arrivalByTrain[train_num] || {};

        return {
          train: train_num,
          direction,
          network,
          commercial_mode,
          scheduled:     fmt(base_dt),
          realtime:      fmt(real_dt),
          delay_min,
          dep_track,
          arr_scheduled: arrInfo.arr_scheduled || null,
          arr_realtime:  arrInfo.arr_realtime  || null,
          arr_track:     arrInfo.arr_track     || null,
          disruptions,
          _raw_mode: commercial_mode + '|' + network,
        };
      });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ departures }),
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
