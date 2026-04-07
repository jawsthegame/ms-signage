'use strict';

// ── Timing config ───────────────────────────────────────
const LEFT_DURATION = {
  septa:      10000,
  nowplaying: 10000,
  featured:   10000,
};
const SEPTA_REFRESH  = 60 * 1000;
const SONOS_REFRESH  = 6  * 1000;

// ── State ────────────────────────────────────────────────
const data = { septa: null, specials: null, sonos: null };
let specialsFlat = [];   // [{name, price, desc, category}, ...]
let leftCurrent  = 'septa';
let featuredIdx  = -1;   // incremented before first use → starts at 0
let slideTimer   = null;
let progressRaf  = null;
let progressStart, progressDuration;

const LEFT_ORDER = ['septa', 'nowplaying', 'featured'];

// ── DOM helpers ──────────────────────────────────────────
function el(id) { return document.getElementById(id); }

// ── Clock ────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const h   = now.getHours();
  const m   = String(now.getMinutes()).padStart(2, '0');
  el('clock').textContent = `${((h % 12) || 12)}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}
setInterval(updateClock, 1000);
updateClock();

// ── Status helpers ───────────────────────────────────────
function statusClass(s) {
  if (!s) return 'on-time';
  const l = s.toLowerCase();
  if (l.includes('cancel')) return 'cancelled';
  if (l === 'on time') return 'on-time';
  if (/^\d+\s*min$/.test(l)) return 'arriving'; // real-time countdown
  return 'delayed';
}
function formatStatus(s) {
  if (!s) return 'On Time';
  if (s.toLowerCase() === 'on time') return 'On Time';
  return s;
}
function formatDest(direction, destination) {
  return direction === 'S' ? '→ Center City' : `→ ${destination || ''}`;
}

// ── Render: SEPTA (left) ─────────────────────────────────
function renderSepta() {
  const d = data.septa;
  const gridEl = el('septa-grid');
  const errEl  = el('septa-error');

  if (!d || d.error) {
    gridEl.style.display = 'none';
    errEl.style.display  = '';
    return;
  }
  gridEl.style.display = '';
  errEl.style.display  = 'none';
  renderTrainList('war-trains', d.warminster  || []);
  renderTrainList('tre-trains', d.westTrenton || []);
}

function renderTrainList(id, trains) {
  const c = el(id);
  if (!trains.length) {
    c.innerHTML = '<div class="no-trains">No upcoming trains</div>';
    return;
  }
  const header = `<div class="train-header">
    <span>Departs</span><span>To</span><span>Status</span>
  </div>`;
  const rows = trains.map(t => `
    <div class="train-row">
      <span class="train-time">${t.departTime || '—'}</span>
      <span class="train-dest">${formatDest(t.direction, t.destination)}</span>
      <span class="train-status ${statusClass(t.status)}">${formatStatus(t.status)}</span>
    </div>`).join('');
  c.innerHTML = header + rows;
}

// ── Render: Now Playing (left) ───────────────────────────
function renderNowPlaying() {
  const s = data.sonos;
  if (!s) return;
  const imgEl = el('album-art');
  const phEl  = el('album-art-placeholder');
  if (s.albumArtUrl) {
    imgEl.src          = s.albumArtUrl;
    imgEl.style.display = 'block';
    phEl.style.display  = 'none';
  } else {
    imgEl.style.display = 'none';
    phEl.style.display  = 'block';
  }
  el('track-title').textContent  = s.title  || '';
  el('track-artist').textContent = s.artist || '';
  el('track-album').textContent  = s.album  || '';
}

// ── Render: Spotlight (left) ─────────────────────────────
function renderSpotlight() {
  if (!specialsFlat.length) return;
  const item = specialsFlat[featuredIdx];
  el('spotlight-category').textContent = item.category || '';
  el('spotlight-name').textContent     = item.name     || '';
  el('spotlight-desc').textContent     = item.desc     || '';
  el('spotlight-desc').style.display   = item.desc ? '' : 'none';
  el('spotlight-price').textContent    = item.price    || '';
  highlightRightItem(featuredIdx);
}

// ── Render: Right specials panel ─────────────────────────
function buildSpecialsFlat() {
  if (!data.specials) return;
  specialsFlat = [];
  for (const cat of (data.specials.items || [])) {
    for (const drink of (cat.drinks || [])) {
      specialsFlat.push({ name: drink.name, price: drink.price, desc: drink.ingredients || '', category: cat.category });
    }
  }
}

function renderRightSpecials() {
  const container = el('right-specials');
  if (!data.specials) { container.innerHTML = ''; return; }

  let html = '';
  let flatIdx = 0;

  for (const cat of (data.specials.items || [])) {
    html += `<div class="right-group">
      <div class="right-category">${cat.category}</div>`;
    for (const drink of (cat.drinks || [])) {
      html += `<div class="right-item" data-idx="${flatIdx}">
        <span class="right-item-name">
          ${drink.name}
          ${drink.ingredients ? `<span class="right-item-ingredients">${drink.ingredients}</span>` : ''}
        </span>
        <span class="right-item-price">${drink.price}</span>
      </div>`;
      flatIdx++;
    }
    html += `</div>`;
  }

  container.innerHTML = html;
}

function highlightRightItem(activeIdx) {
  document.querySelectorAll('.right-item').forEach(row => {
    const i = parseInt(row.dataset.idx, 10);
    row.classList.toggle('highlight', i === activeIdx);
    row.classList.toggle('dim',       i !== activeIdx);
  });
}

function clearRightHighlight() {
  document.querySelectorAll('.right-item').forEach(row => {
    row.classList.remove('highlight', 'dim');
  });
}

// ── Left slide rotation ──────────────────────────────────
function isPlaying() {
  return data.sonos && data.sonos.state === 'playing' && (data.sonos.title || data.sonos.artist);
}

function getNextLeft() {
  const cur = LEFT_ORDER.indexOf(leftCurrent);
  for (let i = 1; i <= LEFT_ORDER.length; i++) {
    const candidate = LEFT_ORDER[(cur + i) % LEFT_ORDER.length];
    if (candidate === 'nowplaying' && !isPlaying()) continue;
    if (candidate === 'featured'   && !specialsFlat.length) continue;
    return candidate;
  }
  return 'septa'; // fallback
}

function showLeft(name) {
  // Advance featured index when showing spotlight
  if (name === 'featured') {
    featuredIdx = (featuredIdx + 1) % specialsFlat.length;
  }

  // Swap slide visibility
  document.querySelectorAll('.left-slide').forEach(s => s.classList.remove('active'));
  el(`left-${name}`).classList.add('active');

  // Render content
  if (name === 'septa')      { renderSepta();      clearRightHighlight(); }
  if (name === 'nowplaying') { renderNowPlaying();  clearRightHighlight(); }
  if (name === 'featured')   { renderSpotlight(); }

  leftCurrent = name;

  const duration = LEFT_DURATION[name] || 15000;
  startProgress(duration);

  clearTimeout(slideTimer);
  slideTimer = setTimeout(() => showLeft(getNextLeft()), duration);
}

// ── Progress bar ─────────────────────────────────────────
function startProgress(duration) {
  cancelAnimationFrame(progressRaf);
  progressStart    = performance.now();
  progressDuration = duration;
  const bar = el('progress-bar');
  bar.style.width = '0%';

  function tick(now) {
    const pct = Math.min((now - progressStart) / progressDuration * 100, 100);
    bar.style.width = pct + '%';
    if (pct < 100) progressRaf = requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Data fetching ────────────────────────────────────────
async function fetchSepta() {
  try {
    const res  = await fetch('/api/septa');
    data.septa = await res.json();
  } catch {
    data.septa = { error: true };
  }
  if (leftCurrent === 'septa') renderSepta();
}

async function fetchSpecials() {
  try {
    const res      = await fetch('/api/specials');
    data.specials  = await res.json();
  } catch {
    data.specials  = null;
  }
  buildSpecialsFlat();
  renderRightSpecials();
}

async function fetchSonos() {
  try {
    const res  = await fetch('/api/sonos');
    data.sonos = await res.json();
  } catch {
    data.sonos = { state: 'error' };
  }
  if (leftCurrent === 'nowplaying') renderNowPlaying();
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    el('shop-name').textContent = cfg.shopName || '';
  } catch {}
}

// ── Boot ─────────────────────────────────────────────────
async function init() {
  await fetchConfig();
  await Promise.all([fetchSepta(), fetchSpecials(), fetchSonos()]);
  showLeft('septa');
  setInterval(fetchSepta, SEPTA_REFRESH);
  setInterval(fetchSonos, SONOS_REFRESH);
}

init();
