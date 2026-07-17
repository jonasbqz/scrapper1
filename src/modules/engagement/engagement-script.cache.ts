import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as JavaScriptObfuscator from 'javascript-obfuscator';

const ENGAGEMENT_SCRIPT_SOURCE = `
(function(){
  if (window._okl_loaded) return;
  window._okl_loaded = true;

  var _links = __LINKS_JSON__;
  var _d = function(s){ return atob(s); };

  var _xp = ['/login', '/playlist', '/terms', '/privacy', '/disclaimer', '/profile', '/premium', '/register'];

  var MAX_PER_LINK_H = 3;
  var LINK_HOUR      = 10800000;
  var VIEW_COOLDOWN  = 14400000;
  var VIEW_THRESHOLD = 7000; // Subido a 7 segundos para contar visualización real
  var TYPE_COOLDOWN  = 1800000;
  var INACTIVE_MS    = 60000;
  var STORAGE_KEY    = '_okl';
  var MAX_POPUNDERS  = 4; // Límite de sesión de 4 popunders máximo

  var sessionCount = 0;
  try {
    sessionCount = parseInt(sessionStorage.getItem(STORAGE_KEY + '_session_count') || '0', 10);
  } catch(e) {}

  var touchStartX = 0;
  var touchStartY = 0;
  var touchStartTime = 0;
  var isScrolling = false;
  var SCROLL_THRESHOLD = 10;

  var ready = false;
  var active = false;
  var activityTimer = null;
  var pageLoadTime = Date.now();

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch(e) {}
    return {};
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch(e) {}
  }

  var state = loadState();
  var now0 = Date.now();

  if (!state.lastShow) state.lastShow = 0;
  if (!state.links) state.links = {};
  if (!state.typeCooldowns) state.typeCooldowns = {};

  for (var k in state.links) {
    if (state.links[k].shows) {
      state.links[k].shows = state.links[k].shows.filter(function(s) {
        return now0 - s.ts < LINK_HOUR;
      });
    }
    if (state.links[k].viewedUntil && now0 >= state.links[k].viewedUntil) {
      state.links[k].viewedUntil = 0;
    }
  }

  saveState(state);

  var isNewUser      = !state.hasHadFirstClick;
  var FIRST_WAIT     = isNewUser ? 1000 : 3000;  // 1s para nuevos, 3s para recurrentes
  var COOLDOWN       = isNewUser ? 5000 : 10000; // Cooldown de 5s para nuevos, 10s para recurrentes

  function isExcluded() {
    var p = location.pathname;
    for (var i = 0; i < _xp.length; i++) {
      if (p === _xp[i]) return true;
    }
    return false;
  }

  function markActive() {
    active = true;
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(function() { active = false; }, INACTIVE_MS);
  }

  document.addEventListener('mousemove', markActive, { passive: true, capture: true });
  document.addEventListener('keydown', markActive, { passive: true, capture: true });

  setTimeout(function() { ready = true; }, FIRST_WAIT);

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      active = false;
      if (activityTimer) clearTimeout(activityTimer);
    }
  });

  function pickLink() {
    var now = Date.now();
    var available = [];

    for (var i = 0; i < _links.length; i++) {
      var link = _links[i];
      var ls = state.links[link.u] || { shows: [], viewedUntil: 0 };

      if (ls.viewedUntil && now < ls.viewedUntil) continue;

      var recentShows = (ls.shows || []).filter(function(s) {
        return now - s.ts < LINK_HOUR;
      });
      if (recentShows.length >= MAX_PER_LINK_H) continue;

      var typeCd = state.typeCooldowns[link.t];
      if (typeCd && now < typeCd) continue;

      available.push({
        index: i,
        link: link,
        showCount: recentShows.length
      });
    }

    if (available.length === 0) return null;

    available.sort(function(a, b) { return a.showCount - b.showCount; });
    var minShows = available[0].showCount;
    var candidates = available.filter(function(a) { return a.showCount === minShows; });

    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    return pick.link;
  }

  function recordShow(link, usePopupWindow) {
    var now = Date.now();

    if (!state.links[link.u]) state.links[link.u] = { shows: [], viewedUntil: 0 };
    state.links[link.u].shows.push({ ts: now, viewed: false });

    state.lastShow = now;
    state.hasHadFirstClick = true; // Marcar que ya interactuó alguna vez

    saveState(state);

    // Incrementar contador de sesión
    sessionCount++;
    try {
      sessionStorage.setItem(STORAGE_KEY + '_session_count', String(sessionCount));
    } catch(e) {}

    var targetUrl = atob(decodeURIComponent(link.u));
    var openedWindow = null;

    try {
      if (usePopupWindow) {
        openedWindow = window.open(
          targetUrl,
          '_blank',
          'popup=yes,width=420,height=720,left=80,top=80,noopener,noreferrer'
        );
      } else {
        openedWindow = window.open(targetUrl, '_blank');
      }
    } catch(e) {}

    if (openedWindow) {
      var checkInterval = setInterval(function() {
        try {
          if (openedWindow.closed) {
            clearInterval(checkInterval);
            var viewDuration = Date.now() - now;
            var lastShowIdx = state.links[link.u].shows.length - 1;

            if (viewDuration >= VIEW_THRESHOLD) {
              state.links[link.u].shows[lastShowIdx].viewed = true;
              state.links[link.u].viewedUntil = Date.now() + VIEW_COOLDOWN;
              state.typeCooldowns[link.t] = Date.now() + TYPE_COOLDOWN;
            }
            saveState(state);
          }
        } catch(e) {
          clearInterval(checkInterval);
        }
      }, 1000);

      setTimeout(function() { clearInterval(checkInterval); }, 60000);
    }
  }

  function handleClick(e) {
    if (e.target.id === 'close-vip-ads') return;
    if (isExcluded()) return;
    if (sessionCount >= MAX_POPUNDERS) return; // Limitar a 4 popunders por sesión
    if (!ready) return;
    if (!active) return;

    var now = Date.now();

    var isSessionActivator = false;
    try {
      if (!sessionStorage.getItem(STORAGE_KEY + '_act')) {
        isSessionActivator = true;
      }
    } catch(e) {}

    if (!isSessionActivator) {
      if (now - state.lastShow < COOLDOWN) return;
    }

    var link = pickLink();
    if (!link) return;

    if (e.target && e.target.closest) {
      if (e.target.closest('a, button, input, select')) {
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (e.target) {
      var tag = e.target.tagName ? e.target.tagName.toUpperCase() : '';
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT') {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    try {
      sessionStorage.setItem(STORAGE_KEY + '_act', '1');
    } catch(e) {}

    recordShow(link, isSessionActivator);
  }

  document.addEventListener('click', handleClick, true);

  document.addEventListener('touchstart', function(e) {
    if (e.touches && e.touches.length > 0) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      isScrolling = false;
    }
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', function(e) {
    if (e.touches && e.touches.length > 0) {
      var dx = Math.abs(e.touches[0].clientX - touchStartX);
      var dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > SCROLL_THRESHOLD || dy > SCROLL_THRESHOLD) {
        isScrolling = true;
      }
    }
  }, { passive: true, capture: true });

  document.addEventListener('touchend', function(e) {
    var touchDuration = Date.now() - touchStartTime;

    if (!isScrolling && touchDuration < 500) {
      markActive();
    }
  }, { passive: true, capture: true });

})();
`;

const ENGAGEMENT_LINKS = [
  { url: 'https://omg10.com/4/10611187', type: 'omg' },
  { url: 'https://omg10.com/4/10637648', type: 'omg' },
  { url: 'https://omg10.com/4/10637660', type: 'omg' },
  { url: 'https://omg10.com/4/10637676', type: 'omg' },
];

const PREBUILT_SCRIPT_CANDIDATES = [
  join(__dirname, '../../../engagement/pl.obfuscated.js'),
  join(process.cwd(), 'dist/engagement/pl.obfuscated.js'),
];

let cachedObfuscatedScript: string | null = null;
let warmInFlight: Promise<string> | null = null;

function loadPrebuiltScript(): string | null {
  for (const candidate of PREBUILT_SCRIPT_CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        return readFileSync(candidate, 'utf8');
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return null;
}

function buildEngagementScriptSource(): string {
  const encodedLinks = ENGAGEMENT_LINKS.map((link) => ({
    u: Buffer.from(link.url).toString('base64'),
    t: link.type,
  }));

  return ENGAGEMENT_SCRIPT_SOURCE.replace(
    '__LINKS_JSON__',
    JSON.stringify(encodedLinks),
  );
}

function obfuscateEngagementScript(source: string): string {
  return JavaScriptObfuscator.obfuscate(source, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    splitStrings: true,
    simplify: true,
  }).getObfuscatedCode();
}

export function buildObfuscatedEngagementScript(): string {
  return obfuscateEngagementScript(buildEngagementScriptSource());
}

export function getCachedEngagementScript(): string {
  if (cachedObfuscatedScript) {
    return cachedObfuscatedScript;
  }

  const prebuilt = loadPrebuiltScript();
  if (prebuilt) {
    cachedObfuscatedScript = prebuilt;
    return prebuilt;
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn(
      'Prebuilt engagement script missing; obfuscating at runtime (high memory use). Run `bun run build` before deploy.',
    );
  }

  cachedObfuscatedScript = buildObfuscatedEngagementScript();
  return cachedObfuscatedScript;
}

export async function warmEngagementScriptCache(): Promise<string> {
  if (cachedObfuscatedScript) {
    return cachedObfuscatedScript;
  }

  if (!warmInFlight) {
    warmInFlight = Promise.resolve().then(() => getCachedEngagementScript());
  }

  return warmInFlight;
}
