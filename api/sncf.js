// api/sncf.js — Vercel Serverless Function
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

// "20260330T143500" → minutes depuis minuit
function toMinutes(navitiaDatetime) {
  if (!navitiaDatetime || navitiaDatetime.length < 15) return null;
  const h = parseInt(navitiaDatetime.slice(9, 11), 10);
  const m = parseInt(navitiaDatetime.slice(11, 13), 10);
  return h * 60 + m;
}

// "20260330T143500" → "14:35"
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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SNCF_TOKEN;
  if (!token) return res.status(500).json({ error: "SNCF_TOKEN manquant" });

  const { from, to, datetime: datetimeParam } = req.query;
  if (!from || !to) return res.status(400).json({ error: "Paramètres from/to requis" });

  const fromName = STATION_NAMES[from];
  const toName   = STATION_NAMES[to];
  if (!fromName || !toName) return res.status(400).json({ error: "Gare inconnue" });

  const authHeader = "Basic " + Buffer.from(token + ":").toString("base64");

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
      return res.status(deptResp.status).json({ error: text });
    }

    const [deptData, arrvData] = await Promise.all([
      deptResp.json(),
      arrvResp.ok ? arrvResp.json() : Promise.resolve({ arrivals: [] }),
    ]);

    // Index arrivées par numéro de train
    // On garde TOUTES les arrivées d'un même numéro (peut arriver plusieurs fois sur la journée)
    const arrivalsByTrain = {};
    for (const a of (arrvData.arrivals || [])) {
      const trainNum = a.display_informations?.headsign || "";
      if (!trainNum) continue;
      if (!arrivalsByTrain[trainNum]) arrivalsByTrain[trainNum] = [];
      arrivalsByTrain[trainNum].push({
        arr_scheduled:    fmt(a.stop_date_time?.base_arrival_date_time),
        arr_realtime:     fmt(a.stop_date_time?.arrival_date_time),
        arr_raw:          a.stop_date_time?.base_arrival_date_time,   // pour comparaison temporelle
        arr_track:        extractTrack(a.stop_point),
      });
    }

    const departures = [];

    for (const d of (deptData.departures || [])) {
      const train_num = d.display_informations?.headsign || "";
      if (!train_num) continue;

      // Ce train doit arriver à la gare destination
      const arrivals = arrivalsByTrain[train_num];
      if (!arrivals || arrivals.length === 0) continue;

      const base_dt = d.stop_date_time?.base_departure_date_time;
      const real_dt = d.stop_date_time?.departure_date_time;
      const dep_min = toMinutes(base_dt);

      // Trouver l'arrivée à destination dont l'heure est APRÈS le départ
      // (le train CSR→MTB arrive après être parti, jamais avant)
      let matchedArrival = null;
      for (const arr of arrivals) {
        const arr_min = toMinutes(arr.arr_raw);
        if (dep_min !== null && arr_min !== null) {
          // Tolérance : l'arrivée doit être entre 1 min et 180 min après le départ
          let diff = arr_min - dep_min;
          if (diff < 0) diff += 1440; // passage minuit
          if (diff >= 1 && diff <= 180) {
            matchedArrival = arr;
            break;
          }
        } else {
          // Pas d'heure dispo : on accepte quand même (fallback)
          matchedArrival = arr;
          break;
        }
      }

      if (!matchedArrival) continue; // ce train va dans le mauvais sens ou ne passe pas par la destination

      let delay_min = 0;
      if (base_dt && real_dt && base_dt !== real_dt) {
        delay_min = Math.round((parseNavitia(real_dt) - parseNavitia(base_dt)) / 60000);
      }

      departures.push({
        train:         train_num,
        direction:     d.display_informations?.direction || "",
        network:       d.display_informations?.network || "",
        commercial_mode: d.display_informations?.commercial_mode || "",
        scheduled:     fmt(base_dt),
        realtime:      fmt(real_dt),
        delay_min,
        dep_track:     extractTrack(d.stop_point),
        arr_scheduled: matchedArrival.arr_scheduled,
        arr_realtime:  matchedArrival.arr_realtime,
        arr_track:     matchedArrival.arr_track,
        disruptions:   (d.disruptions || []).map(dis => dis.messages?.[0]?.text || "").filter(Boolean),
        _raw_mode:     (d.display_informations?.commercial_mode || "") + '|' + (d.display_informations?.network || ""),
      });
    }

    return res.status(200).json({ departures });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
