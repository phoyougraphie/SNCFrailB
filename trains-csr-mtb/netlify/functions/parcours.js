// netlify/functions/parcours.js
const SNCF_BASE = "https://api.sncf.com/v1/coverage/sncf";

const fmt = (s) => s ? `${s.slice(9,11)}:${s.slice(11,13)}` : null;
const fmtRaw = (t) => t ? `${String(t).slice(0,2)}:${String(t).slice(2,4)}` : null;

exports.handler = async (event) => {
  const token = process.env.SNCF_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: "SNCF_TOKEN manquant" }) };

  const { train_num, from_datetime } = event.queryStringParameters || {};
  if (!train_num) return { statusCode: 400, body: JSON.stringify({ error: "train_num requis" }) };

  const authHeader = "Basic " + Buffer.from(token + ":").toString("base64");

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const datetime = from_datetime ||
    `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}T000000`;

  try {
    const vjUrl = `${SNCF_BASE}/vehicle_journeys?headsign=${encodeURIComponent(train_num)}&since=${datetime}&depth=2&count=5`;
    const vjResp = await fetch(vjUrl, { headers: { Authorization: authHeader } });

    if (!vjResp.ok) {
      throw new Error(`vehicle_journeys error ${vjResp.status}`);
    }

    const vjData = await vjResp.json();
    const vjs = vjData.vehicle_journeys || [];

    if (vjs.length === 0) {
      throw new Error(`Aucun trajet trouvé pour le train ${train_num}`);
    }

    const journey = vjs[0];
    const stopTimes = journey.stop_times || [];

    const arrets = stopTimes.map((st) => {
      const depRaw = st.departure_time;
      const arrRaw = st.arrival_time;

      const toHHMM = (val) => {
        if (!val && val !== 0) return null;
        if (typeof val === 'number') {
          const totalMin = Math.floor(val / 60);
          const h = Math.floor(totalMin / 60) % 24;
          const m = totalMin % 60;
          return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
        }
        const s = String(val).replace(/:/g, '');
        return `${s.slice(0,2)}:${s.slice(2,4)}`;
      };

      return {
        name:    st.stop_point?.name || '?',
        arr:     toHHMM(arrRaw),
        dep:     toHHMM(depRaw),
        skipped: st.skipped_stop || false,
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ train: train_num, arrets }),
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
