try { require('dotenv').config(); } catch {}
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SONOS_IP = process.env.SONOS_IP || null;

let sonosDevice = null;
let sonosHost = null;

// --- Sonos setup ---
try {
  const { Sonos, DeviceDiscovery } = require('sonos');

  if (SONOS_IP) {
    sonosDevice = new Sonos(SONOS_IP);
    sonosHost = SONOS_IP;
    console.log(`Sonos: connected to ${SONOS_IP}`);
  } else {
    console.log('Sonos: starting discovery…');
    DeviceDiscovery({ timeout: 15000 }, (device) => {
      if (!sonosDevice) {
        sonosDevice = new Sonos(device.host);
        sonosHost = device.host;
        console.log(`Sonos: discovered at ${device.host}`);
      }
    });
  }
} catch (e) {
  console.warn('node-sonos failed to load:', e.message);
}

// --- SEPTA arrivals ---
// API response shape:
//   { "Elkins Park Departures: <date>": [ {Northbound: [...]}, {Southbound: [...]} ] }
// path codes: R4 = Warminster, R3/R5 = West Trenton
app.get('/api/septa', async (req, res) => {
  try {
    const response = await axios.get(
      'http://www3.septa.org/api/Arrivals/index.php',
      { params: { station: 'Elkins Park', results: 10 }, timeout: 8000 }
    );

    const raw = response.data;
    const topKey = Object.keys(raw)[0];
    if (!topKey) return res.json({ warminster: [], westTrenton: [] });

    // Flatten Northbound + Southbound arrays
    const directionArray = raw[topKey];
    let allTrains = [];
    for (const item of directionArray) {
      if (item.Northbound) allTrains = allTrains.concat(item.Northbound);
      if (item.Southbound) allTrains = allTrains.concat(item.Southbound);
    }

    const warminster  = allTrains.filter(t => (t.path || '').includes('R4')).map(formatTrain).sort(byTs).slice(0, 2);
    const westTrenton = allTrains.filter(t => /R[35]/.test(t.path || '')).map(formatTrain).sort(byTs).slice(0, 2);

    res.json({ warminster, westTrenton });
  } catch (err) {
    console.error('SEPTA error:', err.message);
    res.status(500).json({ error: 'Unable to reach SEPTA' });
  }
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

function formatDateTime(dtStr) {
  // "2026-04-06 18:29:00.000" → "6:29 PM"
  if (!dtStr) return '—';
  const d = new Date(dtStr);
  if (isNaN(d)) return '—';
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${(h % 12) || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}

// --- Sonos current track ---
app.get('/api/sonos', async (req, res) => {
  if (!sonosDevice) return res.json({ state: 'disconnected' });

  try {
    const [track, state] = await Promise.all([
      sonosDevice.currentTrack(),
      sonosDevice.getCurrentState(),
    ]);

    let albumArtUrl = null;
    if (track.albumArtURI) {
      if (track.albumArtURI.startsWith('http')) {
        albumArtUrl = track.albumArtURI;
      } else {
        albumArtUrl = `/api/sonos/art?path=${encodeURIComponent(track.albumArtURI)}`;
      }
    }

    res.json({
      state,
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumArtUrl,
      duration: track.duration,
      position: track.position,
    });
  } catch (err) {
    console.error('Sonos error:', err.message);
    res.json({ state: 'error' });
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

// --- Drink specials ---
app.get('/api/specials', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'specials.json'), 'utf8'));
    res.json(data);
  } catch {
    res.json({ featured: null, items: [] });
  }
});

// --- Config (shop name etc.) ---
app.get('/api/config', (req, res) => {
  res.json({ shopName: process.env.SHOP_NAME || 'Morning Static @ The Goat House' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Signage running → http://localhost:${PORT}`);
});
