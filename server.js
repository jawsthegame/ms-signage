try { require('dotenv').config(); } catch {}
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT      = process.env.PORT            || 3000;
const SONOS_IP  = process.env.SONOS_IP        || null;
const MENU_ONLY = process.env.MENU_ONLY       === 'true';
const SHEET_ID  = process.env.GOOGLE_SHEET_ID || null;
const SHEET_KEY = process.env.GOOGLE_API_KEY  || null;

let sonosDevice = null;
let sonosHost = null;

// --- Sonos setup ---
if (MENU_ONLY) {
  console.log('Menu-only mode — skipping Sonos and SEPTA setup');
}

if (!MENU_ONLY) try {
  const { Sonos, DeviceDiscovery } = require('sonos');
  console.log('Sonos: package loaded OK');

  if (SONOS_IP) {
    console.log(`Sonos: using static IP ${SONOS_IP}`);
    sonosDevice = new Sonos(SONOS_IP);
    sonosHost = SONOS_IP;
    // Immediately probe to confirm reachability
    sonosDevice.getCurrentState()
      .then(s => console.log(`Sonos: reachable at ${SONOS_IP}, state = ${s}`))
      .catch(e => console.warn(`Sonos: unreachable at ${SONOS_IP} —`, e.message));
  } else {
    console.log('Sonos: starting SSDP discovery (up to 15s)…');
    DeviceDiscovery({ timeout: 15000 }, (device) => {
      console.log(`Sonos: found device at ${device.host}`);
      if (!sonosDevice) {
        sonosDevice = new Sonos(device.host);
        sonosHost = device.host;
        console.log(`Sonos: using ${device.host} as primary device`);
        sonosDevice.getCurrentState()
          .then(s => console.log(`Sonos: confirmed reachable, state = ${s}`))
          .catch(e => console.warn(`Sonos: found but unreachable —`, e.message));
      }
    });
    setTimeout(() => {
      if (!sonosDevice) console.warn('Sonos: discovery timed out — no devices found. Set SONOS_IP in .env to skip discovery.');
    }, 16000);
  }
} catch (e) {
  console.warn('Sonos: package failed to load —', e.message);
}

// --- SEPTA arrivals ---
if (!MENU_ONLY)
// API response shape:
//   { "Elkins Park Departures: <date>": [ {Northbound: [...]}, {Southbound: [...]} ] }
// path codes: R4 = Warminster, R3/R5 = West Trenton
app.get('/api/septa', async (req, res) => {
  const result = { warminster: [], westTrenton: [], bus28: [] };

  // ── Regional rail ──────────────────────────────────────────
  try {
    const response = await axios.get(
      'http://www3.septa.org/api/Arrivals/index.php',
      { params: { station: 'Elkins Park', results: 10 }, timeout: 8000 }
    );
    const raw    = response.data;
    const topKey = Object.keys(raw)[0];
    if (topKey) {
      let allTrains = [];
      for (const item of raw[topKey]) {
        if (item.Northbound) allTrains = allTrains.concat(item.Northbound);
        if (item.Southbound) allTrains = allTrains.concat(item.Southbound);
      }
      result.warminster  = allTrains.filter(t => (t.path || '').includes('R4')).map(formatTrain).sort(byTs).slice(0, 2);
      result.westTrenton = allTrains.filter(t => /R[35]/.test(t.path || '')).map(formatTrain).sort(byTs).slice(0, 2);
    }
  } catch (err) {
    console.error('SEPTA rail error:', err.message);
    result.railError = true;
  }

  // ── Bus route 28 ──────────────────────────────────────────
  const sleep   = ms => new Promise(r => setTimeout(r, ms));
  const retries = 5;
  for (let count = 1; count <= retries; count++) {
    try {
      const busResponse = await axios.get(
        'https://api.septa.org/api/BusSchedules/index.php',
        { params: { route: '28', stop_id: '23439' }, timeout: 8000 }
      );
      result.bus28 = (busResponse.data['28'] || [])
        .map(b => ({
          direction:   b.Direction,
          destination: 'Outbound',
          departTime:  formatDateTime(b.DateCalender), 
        }))
        .sort((a, b) => new Date(a.departTime) - new Date(b.departTime))
        .slice(0, 2);

      console.log(`SEPTA bus attempt ${count} OK — ${result.bus28.length} arrivals`);

      try {
        const alertRes = await axios.get(
          'https://api.septa.org/api/Alerts/get_alert_data.php?route_id=bus_route_28'
        );
        const alerts = (alertRes.data && alertRes.data.alerts) || [];
        if (result.bus28.length && alerts.some(a => !!a.current_message)) {
          console.log('SEPTA bus: alert active on route 28');
          result.bus28[0].status = 'Alert';
        }
      } catch { /* alerts are best-effort */ }

      break; // success — stop retrying
    } catch (busErr) {
      console.warn(`SEPTA bus attempt ${count} failed —`, busErr.message);
      result.bus28 = [];
      result.busError = true;
      if (count < retries) await sleep(500);
    }
  }

  // ── TransitView real-time position enrichment ──────────────
  // Only bother if we have scheduled buses to enrich
  if (result.bus28.length) {
    try {
      const [tvRes, stopCoords] = await Promise.all([
        axios.get('https://api.septa.org/api/TransitView/index.php?route=28', { timeout: 5000 }),
        fetchStopCoords('23439'),
      ]);

      if (stopCoords) {
        const allBuses = (tvRes.data && tvRes.data.bus) || [];
        console.log(`TransitView: ${allBuses.length} active buses on route 28`);

        // Score every bus: distance to stop + heading check
        const candidates = allBuses
          .map(b => {
            const lat  = parseFloat(b.lat);
            const lng  = parseFloat(b.lng);
            const dist = haversineKm(lat, lng, stopCoords.lat, stopCoords.lng);
            const toStop   = bearingDeg(lat, lng, stopCoords.lat, stopCoords.lng);
            const heading  = parseFloat(b.heading || 0);
            const aligned  = angleDiff(heading, toStop) < 90; // facing toward stop
            return { ...b, dist, aligned };
          })
          .filter(b => b.dist < 15 && b.aligned)   // within 15 km, heading toward stop
          .sort((a, b) => a.dist - b.dist);

        console.log(`TransitView: ${candidates.length} buses approaching stop 23439`);

        // Greedily match each scheduled bus to the nearest unmatched real-time bus
        const used = new Set();
        result.bus28 = result.bus28.map(scheduled => {
          const match = candidates.find(b => !used.has(b.VehicleID));
          if (!match) return scheduled;
          used.add(match.VehicleID);

          // Convert great-circle distance → estimated minutes at avg urban speed
          const AVG_KMH  = 20;
          const estMins  = Math.round(match.dist / (AVG_KMH / 60));
          console.log(`  Vehicle ${match.VehicleID}: ${match.dist.toFixed(2)} km → ~${estMins} min`);

          if (match.dist < 0.15) return { ...scheduled, status: 'Arriving' };
          return { ...scheduled, status: `${estMins} min` };
        });
      }
    } catch (tvErr) {
      console.warn('TransitView enrichment failed:', tvErr.message);
      // bus28 keeps its scheduled data — no change needed
    }
  }

  res.json(result);
});

function formatTrain(t) {
  const dtStr = t.depart_time || t.sched_time;
  const ts    = dtStr ? new Date(dtStr).getTime() : Infinity;
  return {
    direction:   t.direction,
    destination: t.destination,
    departTime:  formatDateTime(dtStr),
    status:      t.status || 'On Time',
    track:       t.track,
    ts,
  };
}

function byTs(a, b) { return a.ts - b.ts; }

// ── Great-circle helpers ───────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R  = 6371;
  const d  = v => v * Math.PI / 180;
  const dL = d(lat2 - lat1), dG = d(lng2 - lng1);
  const a  = Math.sin(dL/2)**2 + Math.cos(d(lat1)) * Math.cos(d(lat2)) * Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const d = v => v * Math.PI / 180;
  const y = Math.sin(d(lng2 - lng1)) * Math.cos(d(lat2));
  const x = Math.cos(d(lat1)) * Math.sin(d(lat2)) - Math.sin(d(lat1)) * Math.cos(d(lat2)) * Math.cos(d(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Cached stop coordinates — fetched once from SEPTA stop API
let busStopCoords = null;
async function fetchStopCoords(stopId) {
  if (busStopCoords) return busStopCoords;
  try {
    const r = await axios.get(
      `https://api.septa.org/api/StopInformation/index.php?stop_id=${stopId}`,
      { timeout: 5000 }
    );
    const stop = (r.data || [])[0];
    if (stop && stop.lat && stop.lng) {
      busStopCoords = { lat: parseFloat(stop.lat), lng: parseFloat(stop.lng) };
      console.log(`Bus stop ${stopId} coords cached: ${JSON.stringify(busStopCoords)}`);
    }
  } catch (e) {
    console.warn(`Could not fetch stop ${stopId} coords:`, e.message);
  }
  return busStopCoords;
}

function formatDateTime(dtStr) {
  // "2026-04-06 18:29:00.000" → "6:29 PM"
  if (!dtStr) return '—';
  const d = new Date(dtStr);
  if (isNaN(d)) return '—';
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${(h % 12) || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

// // Direct SOAP helpers — bypass sonos package XML parsing issues
// async function sonosSoapRequest(host, action, body) {
//   const soap = `<?xml version="1.0" encoding="utf-8"?>
// <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
//   <s:Body>${body}</s:Body>
// </s:Envelope>`;
//   const res = await axios.post(
//     `http://${host}:1400/MediaRenderer/AVTransport/Control`,
//     soap,
//     { headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"` }, timeout: 5000 }
//   );
//   return res.data;
// }
// 
// function xmlTag(xml, tag) {
//   const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
//   return m ? m[1].trim() : null;
// }
// 
// function decodeXmlEntities(s) {
//   return (s || '').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
// }
// 
// async function getTransportState(host) {
//   const xml = await sonosSoapRequest(host, 'GetTransportInfo',
//     '<u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>');
//   const raw = xmlTag(xml, 'CurrentTransportState') || 'STOPPED';
//   console.log(`Sonos: transport state raw → "${raw}"`);
//   return raw === 'PLAYING' ? 'playing' : raw === 'PAUSED_PLAYBACK' ? 'paused' : 'stopped';
// }
// 
// async function getPositionInfo(host) {
//   const xml = await sonosSoapRequest(host, 'GetPositionInfo',
//     '<u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo>');
// 
//   console.log('Sonos: GetPositionInfo raw XML →\n', xml.slice(0, 800));
// 
//   const rawMeta = xmlTag(xml, 'TrackMetaData');
//   const didl    = decodeXmlEntities(rawMeta);
//   console.log('Sonos: decoded DIDL →\n', didl.slice(0, 600));
// 
//   const title    = xmlTag(didl, 'dc:title');
//   const artist   = xmlTag(didl, 'dc:creator')
//                 || xmlTag(didl, 'r:artistDisplayName');
//   const album    = xmlTag(didl, 'upnp:album');
//   const artRaw   = xmlTag(didl, 'upnp:albumArtURI');
//   const duration = xmlTag(xml,  'TrackDuration');
//   const position = xmlTag(xml,  'RelTime');
// 
//   console.log(`Sonos: parsed → title="${title}" artist="${artist}" album="${album}" art="${artRaw}"`);
// 
//   return { title, artist, album, albumArtURI: artRaw, duration, position };
// }

// --- Sonos current track ---
app.get('/api/sonos', async (req, res) => {
  if (!sonosHost) {
    console.log('Sonos: /api/sonos hit but no device available');
    return res.json({ state: 'disconnected' });
  }

  try {
    let state = await sonosDevice.getCurrentState();
    let track = await sonosDevice.currentTrack();
    let albumArtUrl = null;
    if (track.albumArtURI) {
      albumArtUrl = track.albumArtURI.startsWith('http')
        ? track.albumArtURI
        : `/api/sonos/art?path=${encodeURIComponent(track.albumArtURI)}`;
    }

    const payload = { state, title: track.title, artist: track.artist, album: track.album, albumArtUrl, duration: track.duration, position: track.position };
    res.json(payload);
  } catch (err) {
    console.error('Sonos: poll failed —', err.message);
    console.error('Sonos: stack —', err.stack);
    res.json({ state: 'error', error: err.message });
  }
});

// --- Album art proxy (Sonos local URLs need to be fetched server-side) ---
app.get('/api/sonos/art', async (req, res) => {
  if (!sonosHost || !req.query.path) return res.status(404).end();
  try {
    const url = `http://${sonosHost}:1400${req.query.path}`;
    const response = await axios.get(url, { responseType: 'stream', timeout: 5000 });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=60');
    response.data.pipe(res);
  } catch {
    res.status(404).end();
  }
});

// --- Google Sheets (shared cache) ---
// Sheet layout: A=category, B=name, C=description, D=available (optional, default TRUE)
// Categories: "house syrup", "monin syrup", "milk", etc.
let sheetRows    = null;   // parsed rows after header
let sheetCacheTs = 0;
const SHEET_TTL  = 60_000;

async function fetchSheetRows() {
  const now = Date.now();
  if (sheetRows && (now - sheetCacheTs) < SHEET_TTL) return sheetRows;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/Sheet1!A:D?key=${SHEET_KEY}`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const [, ...rows] = data.values || [];
  sheetRows    = rows
    .filter(r => r[1] && r[1].trim())
    .map(([cat = '', name = '', desc = '', avail = 'TRUE']) => ({
      category:  cat.trim().toLowerCase(),
      name:      name.trim(),
      description: desc.trim(),
      available: !['false', '0', 'no'].includes(avail.trim().toLowerCase()),
    }));
  sheetCacheTs = now;
  console.log(`Sheets: fetched ${sheetRows.length} rows`);
  return sheetRows;
}

app.get('/api/availability', async (req, res) => {
  if (!SHEET_ID || !SHEET_KEY) return res.json({ items: [], unconfigured: true });
  try {
    const rows  = await fetchSheetRows();
    const items = rows.map(r => ({
      id:        r.name.toLowerCase().replace(/\s+/g, '-'),
      name:      r.name,
      available: r.available,
      category:  r.category,
    }));
    const soldOut = items.filter(i => !i.available).map(i => i.name);
    console.log(`Availability: ${items.length} items, sold out: [${soldOut.join(', ') || 'none'}]`);
    res.json({ items });
  } catch (err) {
    console.error('Sheets availability error:', err.message);
    res.json(sheetRows
      ? { items: sheetRows.map(r => ({ id: r.name.toLowerCase().replace(/\s+/g, '-'), name: r.name, available: r.available })) }
      : { items: [], error: err.message });
  }
});

// --- Drink specials ---
app.get('/api/specials', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'specials.json'), 'utf8'));
    res.json(data);
  } catch {
    res.json({ featured: null, items: [] });
  }
});

// --- Generic list slides (teas, syrups, etc.) ---
// Item data always comes from <name>.json — Sheets is only used for availability.
app.get('/api/list/:name', (req, res) => {
  const name = (req.params.name || '').replace(/[^a-z0-9_-]/gi, '');
  if (!name) return res.status(400).json({ error: 'invalid name' });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, `${name}.json`), 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ title: '', items: [] });
  }
});

// --- Config ---
app.get('/api/config', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (process.env.SHOP_NAME) cfg.shopName = process.env.SHOP_NAME;
    res.json(cfg);
  } catch {
    res.json({ shopName: 'Morning Static @ The Goat House', loopOrder: ['nowplaying', 'septa'] });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Signage running → http://localhost:${PORT}`);
});
