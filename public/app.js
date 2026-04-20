'use strict';

// ── Timing config (overridden by config.json via /api/config) ───
let LEFT_DURATION = {
  septa:      10000,
  nowplaying: 10000,
  featured:   10000,
};
const SEPTA_REFRESH  = 60 * 1000;
const SONOS_REFRESH  = 6  * 1000;

// ── State ────────────────────────────────────────────────
const data = { septa: null, specials: null, sonos: null, lists: {} };
let specialsFlat = [];   // [{name, price, desc, category}, ...]
let leftCurrent  = 'septa';
let slideTimer   = null;
let progressRaf  = null;
let progressStart, progressDuration;

let LEFT_ORDER = ['nowplaying', 'septa', 'list:teas', 'list:syrups'];
let CASCADE_CFG = { delayPerChar: 28, minSteps: 2, maxSteps: 4 };
let SOCIAL_ACCOUNTS = [];
let SOCIAL_PLATFORM = 'Instagram';
let SOCIAL_INTERVAL  = 2;
let rotationCount    = 0;

// ── DOM helpers ──────────────────────────────────────────
function el(id) { return document.getElementById(id); }

// ── Clock ────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const h   = now.getHours();
  const m   = String(now.getMinutes()).padStart(2, '0');
  el('clock').textContent = `${((h % 12) || 12)}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
}
// setInterval(updateClock, 1000);
// updateClock();

// ── Split-flap ───────────────────────────────────────────
const FLAP_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const prevTimes  = {}; // keyed by "war-t-0", "war-d-0", etc.

function normFlapTime(t) {
  // Pad to consistent "HH:MM AM" (8 chars) so char positions are stable
  if (!t || t === '—') return '  :   ';
  return t.replace(/^(\d):/, ' $1:'); // "6:29 PM" → " 6:29 PM"
}

// Build a single split-flap digit/letter tile (top half + bottom half + falling flap)
function buildFlapChar(ch) {
  const t = ch || ' ';
  return `<span class="flap-char">` +
    `<span class="fc-half fc-top"><span class="fc-txt">${t}</span></span>` +
    `<span class="fc-half fc-bot"><span class="fc-txt">${t}</span></span>` +
    `<span class="fc-half fc-flap"><span class="fc-txt">${t}</span></span>` +
  `</span>`;
}

function buildFlapHTML(timeStr) {
  const norm = normFlapTime(timeStr);
  return `<span class="flap-display">${
    norm.split('').map((ch, i) => {
      // Leading space (single-digit hour) → blank solid tile, not a separator
      if (ch === ' ' && i === 0) return buildFlapChar(' ');
      if (ch === ':' || ch === ' ') return `<span class="flap-char flap-sep">${ch}</span>`;
      return buildFlapChar(ch);
    }).join('')
  }</span>`;
}

// "3 min" → individual digit flaps + solid "min" word
// "On Time" / "Cancelled" / etc. → single solid word flap
function buildFlapStatus(str) {
  const minMatch = (str || '').match(/^(\d+)\s*(min)$/i);
  if (minMatch) {
    const digits = minMatch[1].split('').map(ch => buildFlapChar(ch)).join('');
    return `<span class="flap-display">${digits}<span class="flap-char flap-sep"> </span><span class="flap-char flap-word">${minMatch[2]}</span></span>`;
  }
  return buildFlapWord(str || 'On Time');
}

function buildFlapWord(str) {
  return `<span class="flap-char flap-word">${str || ''}</span>`;
}

function animateFlapWord(el, target, isFirst) {
  if (isFirst) {
    triggerFlapAnim(el);
  } else {
    el.classList.remove('flap-anim');
    void el.offsetWidth;
    el.textContent = target;
    el.classList.add('flap-anim');
  }
}

function triggerFlapAnim(span) {
  span.classList.remove('flap-anim');
  void span.offsetWidth; // force reflow to restart animation
  span.classList.add('flap-anim');
}

// Flip a split-flap digit tile to a new character.
// animate=false → instant set (first render, no motion)
function flipCharTo(charEl, newChar, animate = true) {
  const flapEl = charEl.querySelector('.fc-flap');
  const topTxt = charEl.querySelector('.fc-top .fc-txt');
  const botTxt = charEl.querySelector('.fc-bot .fc-txt');
  const flapTxt = charEl.querySelector('.fc-flap .fc-txt');

  if (!flapEl || !topTxt) {
    // Fallback for simple/word tiles
    if (animate) triggerFlapAnim(charEl);
    else charEl.textContent = newChar;
    return;
  }

  if (!animate) {
    topTxt.textContent  = newChar;
    botTxt.textContent  = newChar;
    flapTxt.textContent = newChar;
    flapEl.classList.remove('fc-falling');
    return;
  }

  // Freeze the flap on the OLD char, update the static halves to new char,
  // then drop the flap — revealing the new char underneath.
  flapTxt.textContent = topTxt.textContent;
  flapEl.classList.remove('fc-falling');
  void flapEl.offsetWidth;           // reflow to restart animation cleanly
  topTxt.textContent = newChar;
  botTxt.textContent = newChar;
  flapEl.classList.add('fc-falling');
}

function scrambleChar(span, target, delay = 0, steps = 5) {
  setTimeout(() => {
    if (steps === 0) { flipCharTo(span, target, false); return; }
    let step = 0;
    const tick = () => {
      const ch = step < steps
        ? FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)]
        : target;
      flipCharTo(span, ch, true);
      if (step < steps) { step++; setTimeout(tick, 55 + Math.random() * 30); }
    };
    tick();
  }, delay);
}

// ── Startup cascade animation ────────────────────────────
// Runs when the SEPTA slide appears — every char scrambles briefly before
// landing on its real value, simulating a real split-flap board waking up.
function cascadeFlaps(containerEl) {
  const { delayPerChar, minSteps, maxSteps } = CASCADE_CFG;
  containerEl.querySelectorAll('.flap-char:not(.flap-sep)').forEach((charEl, i) => {
    const isWord = charEl.classList.contains('flap-word');

    if (isWord) {
      setTimeout(() => triggerFlapAnim(charEl), i * delayPerChar);
    } else {
      const realChar = charEl.querySelector('.fc-top .fc-txt')?.textContent?.trim() || ' ';
      if (realChar === ' ') return;

      flipCharTo(charEl, FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)], false);

      let step = 0;
      const steps = minSteps + Math.floor(Math.random() * (maxSteps - minSteps + 1));
      setTimeout(() => {
        const tick = () => {
          const ch = step < steps
            ? FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)]
            : realChar;
          flipCharTo(charEl, ch, true);
          if (step < steps) { step++; setTimeout(tick, 48 + Math.random() * 28); }
        };
        tick();
      }, i * delayPerChar);
    }
  });
}

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
  const l = s.toLowerCase().trim();
  if (l === 'on time') return 'On Time';
  if (l === 'l') return 'Late';
  if (l === 'h') return 'Held';
  // 999 min = SEPTA sentinel for "no real-time data"
  if (/^999\s*min$/i.test(s)) return 'On Time';
  return s;
}
function formatDest(direction, destination) {
  return direction === 'S' ? '→ Center City' : `→ ${destination || ''}`;
}

// ── Render: SEPTA (left) ─────────────────────────────────
function renderSepta() {
  const d = data.septa;
  // Always show the grid — individual columns handle their own empty/error states
  el('septa-grid').style.display = '';
  el('septa-error').style.display = 'none';

  if (!d) {
    // Nothing fetched yet — show placeholder in each column
    renderTrainList('war-trains', [], 'war');
    renderTrainList('tre-trains', [], 'tre');
    renderTrainList('bus-28',     [], 'bus28');
    return;
  }

  renderTrainList('war-trains', d.warminster  || [], 'war',   undefined, d.railError);
  renderTrainList('tre-trains', d.westTrenton || [], 'tre',   undefined, d.railError);
  renderTrainList('bus-28',     d.bus28       || [], 'bus28', undefined, d.busError);
}

function renderTrainList(containerId, trains, lineKey, headerText, hasError) {
  const c = el(containerId);
  if (!trains.length) {
    c.innerHTML = `<div class="no-trains">${hasError ? 'Data unavailable' : 'No upcoming departures'}</div>`;
    return;
  }

  headerText = headerText || (lineKey === 'bus28' ? 'Scheduled' : 'Departs');

  // Snapshot state before rebuilding DOM
  const meta = trains.map((t, idx) => {
    const tKey      = `${lineKey}-t-${idx}`;
    const dKey      = `${lineKey}-d-${idx}`;
    const sKey      = `${lineKey}-s-${idx}`;
    const destName  = formatDest(t.direction, t.destination).replace('→ ', '');
    const statusStr = formatStatus(t.status);
    const prevTime  = prevTimes[tKey] || null;
    const prevDest  = prevTimes[dKey] || null;
    const prevStat  = prevTimes[sKey] || null;
    const newTime   = normFlapTime(t.departTime);
    prevTimes[tKey] = newTime;
    prevTimes[dKey] = destName;
    prevTimes[sKey] = statusStr;
    return { prevTime, newTime, timeChanged: prevTime !== newTime,
             prevDest, destName, destChanged: prevDest !== destName,
             prevStat, statusStr, statChanged: prevStat !== statusStr };
  });

  const header = `<div class="train-header">
    <span>${headerText}</span><span>To</span><span>Status</span>
  </div>`;

  const rows = trains.map((t, idx) => {
    const { destName } = meta[idx];
    return `<div class="train-row" data-idx="${idx}">
      <span class="train-time">${buildFlapHTML(t.departTime)}</span>
      <span class="train-dest">
        <span class="dest-arrow">→</span>${buildFlapWord(destName)}
      </span>
      <span class="train-status ${statusClass(t.status)}">${buildFlapStatus(formatStatus(t.status))}</span>
    </div>`;
  }).join('');

  c.innerHTML = header + rows;

  c.querySelectorAll('.train-row').forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);
    const { prevTime, newTime, timeChanged, prevDest, destName, destChanged, prevStat, statusStr, statChanged } = meta[idx];

    // Animate time flaps
    if (timeChanged) {
      const spans  = [...row.querySelectorAll('.train-time .flap-char:not(.flap-sep)')];
      const target = newTime.replace(/[: ]/g, '');
      const first  = prevTime === null;
      spans.forEach((span, i) => {
        scrambleChar(span, target[i] ?? ' ', i * 70, first ? 0 : 5);
      });
    }

    // Animate destination word flap
    if (destChanged) {
      const wordEl = row.querySelector('.train-dest .flap-word');
      if (wordEl) animateFlapWord(wordEl, destName, prevDest === null);
    }

    // Animate status flaps
    if (statChanged) {
      const isFirst   = prevStat === null;
      const minMatch  = statusStr.match(/^(\d+)\s*(min)$/i);
      if (minMatch) {
        // Individual digit chars + solid "min" word
        const digits = [...row.querySelectorAll('.train-status .flap-char:not(.flap-sep):not(.flap-word)')];
        const target = minMatch[1];
        digits.forEach((span, i) => {
          scrambleChar(span, target[i] ?? ' ', i * 70, isFirst ? 0 : 4);
        });
        const wordEl = row.querySelector('.train-status .flap-word');
        if (wordEl && !isFirst) triggerFlapAnim(wordEl);
      } else {
        // Solid word flip
        const wordEl = row.querySelector('.train-status .flap-word');
        if (wordEl) animateFlapWord(wordEl, statusStr, isFirst);
      }
    }
  });
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

// ── Render: Socials (left) ───────────────────────────────────
function renderSocials() {
  el('socials-platform').textContent = SOCIAL_PLATFORM;
  el('socials-accounts').innerHTML = SOCIAL_ACCOUNTS
    .map(a => `<div class="socials-account">${a.replace(/^@/, '')}</div>`)
    .join('');
}

// ── Render: Generic list slide (left) ───────────────────────
// Used for any "list:*" entry in loopOrder (teas, syrups, …)
function renderFeatured(listName) {
  const list = data.lists[listName];
  if (!list || !list.items || !list.items.length) return;

  // Header
  el('featured-title').textContent = list.title || '';

  // Poster-strip rows
  let html = '';
  list.items.forEach(item => {
    html += `<div class="featured-item theme-${item.theme || 'bn-blue'}">
      <div class="featured-item-name">${item.name}</div>
      <div class="featured-item-rule"></div>
      <div class="featured-item-bottom">
        <div class="featured-item-desc">${item.description || ''}</div>
        ${item.price ? `<div class="featured-item-price">${parseFloat(item.price)}</div>` : ''}
      </div>
    </div>`;
  });
  el('featured-list').innerHTML = html;
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
    html += `<div class="right-category-header">${cat.category}</div>`;
    for (const drink of (cat.drinks || [])) {
      const badge = drink.temp === 'iced' ? '❄ Iced' : '● Hot';

      html += `<div class="right-item theme-${drink.theme || 'magenta'}" data-idx="${flatIdx}">
        <div class="right-item-badge">${badge}</div>
        <div class="right-item-name">${drink.name}</div>
        <div class="right-item-rule"></div>
        <div class="right-item-bottom">
          <div class="right-item-ingredients">${drink.ingredients || ''}</div>
          <div class="right-item-price">${parseFloat(drink.price)}</div>
        </div>
      </div>`;
      flatIdx++;
    }
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

// "list:teas" → "teas", anything else → null
function listName(slideName) {
  return slideName.startsWith('list:') ? slideName.slice(5) : null;
}

function getNextLeft() {
  const cur = LEFT_ORDER.indexOf(leftCurrent);
  const len = LEFT_ORDER.length;
  let wrappedThisCall = false;

  for (let i = 1; i <= len; i++) {
    const idx       = (cur + i) % len;
    const candidate = LEFT_ORDER[idx];

    // Detect wrap-around (completing one full rotation)
    if (!wrappedThisCall && cur >= 0 && idx <= cur) {
      wrappedThisCall = true;
      rotationCount++;
      if (SOCIAL_ACCOUNTS.length && rotationCount % SOCIAL_INTERVAL === 0) {
        return 'socials';
      }
    }

    if (candidate === 'nowplaying' && !isPlaying()) continue;
    const ln = listName(candidate);
    if (ln && !data.lists[ln]?.items?.length) continue;
    return candidate;
  }
  return 'septa'; // fallback
}

function showLeft(name) {
  // Skip nowplaying if Sonos isn't active — advance position so rotation stays coherent
  if (name === 'nowplaying' && !isPlaying()) {
    leftCurrent = 'nowplaying';
    showLeft(getNextLeft());
    return;
  }

  const ln      = listName(name);
  const slideId = ln ? 'featured' : name; // all list slides reuse #left-featured

  document.querySelectorAll('.left-slide').forEach(s => s.classList.remove('active'));
  el(`left-${slideId}`).classList.add('active');

  // Render content — right panel always stays on specials
  if (name === 'septa') {
    renderSepta();
    clearRightHighlight();
    setTimeout(() => cascadeFlaps(el('left-septa')), 80);
  }
  if (name === 'nowplaying') { renderNowPlaying(); clearRightHighlight(); }
  if (name === 'socials')    { renderSocials();    clearRightHighlight(); }
  if (ln)                    { renderFeatured(ln); clearRightHighlight(); }

  leftCurrent = name;

  // Duration: exact match first, then fall back to "featured" default for list slides
  const duration = LEFT_DURATION[name] ?? LEFT_DURATION['featured'] ?? 15000;
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

async function fetchList(name) {
  try {
    const res        = await fetch(`/api/list/${name}`);
    data.lists[name] = await res.json();
  } catch {
    data.lists[name] = null;
  }
  if (leftCurrent === `list:${name}`) renderFeatured(name);
}

async function fetchSonos() {
  try {
    const res  = await fetch('/api/sonos');
    data.sonos = await res.json();
  } catch {
    data.sonos = { state: 'error' };
  }
  if (leftCurrent === 'nowplaying') {
    if (!isPlaying()) {
      // Sonos stopped/disconnected mid-slide — skip immediately
      showLeft(getNextLeft());
    } else {
      renderNowPlaying();
    }
  }
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    console.log("Fetched config:", cfg);
    // el('shop-name').textContent = cfg.shopName || '';
    if (Array.isArray(cfg.loopOrder) && cfg.loopOrder.length) {
      LEFT_ORDER = cfg.loopOrder;
    }
    if (cfg.slideDuration && typeof cfg.slideDuration === 'object') {
      LEFT_DURATION = { ...LEFT_DURATION, ...cfg.slideDuration };
    }
    if (cfg.cascade && typeof cfg.cascade === 'object') {
      CASCADE_CFG = { ...CASCADE_CFG, ...cfg.cascade };
    }
    if (cfg.socials) {
      SOCIAL_PLATFORM = cfg.socials.platform || 'Instagram';
      SOCIAL_INTERVAL  = cfg.socials.interval || 2;
      SOCIAL_ACCOUNTS  = Array.isArray(cfg.socials.accounts) ? cfg.socials.accounts : [];
    }
  } catch {}
}

// ── Boot ─────────────────────────────────────────────────
async function init() {
  await fetchConfig();
  // Discover which lists are needed from the loop order, then fetch everything in parallel
  const listNames = [...new Set(LEFT_ORDER.map(listName).filter(Boolean))];
  await Promise.all([
    fetchSepta(), fetchSpecials(), fetchSonos(),
    ...listNames.map(fetchList),
  ]);
  showLeft(LEFT_ORDER[0] ?? 'septa');
  setInterval(fetchSepta, SEPTA_REFRESH);
  setInterval(fetchSonos, SONOS_REFRESH);
}

init();
