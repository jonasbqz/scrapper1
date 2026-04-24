import {
  Controller,
  Get,
  Header,
  Query,
  Redirect,
  BadRequestException,
} from "@nestjs/common";
import * as JavaScriptObfuscator from "javascript-obfuscator";

@Controller("o")
export class EngagementController {
  @Get("go")
  @Redirect()
  redirectTarget(@Query("target") target: string) {
    if (!target) {
      throw new BadRequestException("Bad Request");
    }

    try {
      // const decodedUrl = Buffer.from(target, "base64").toString("utf-8");
      new URL("https://quge5.com/88/tag.min.js"); // Validation

      // Perform a super fast 302 redirect without HTML
      return { url: "https://quge5.com/88/tag.min.js", statusCode: 302 };
    } catch (error) {
      console.error("Redirector invalid target:", error);
      throw new BadRequestException("Invalid target");
    }
  }

  @Get("pl")
  @Header("Content-Type", "application/javascript; charset=utf-8")
  @Header("Cache-Control", "public, max-age=3600")
  getEngagementScript() {
    // ---- Link pool with type categorization ----
    const links = [
      { url: "https://omg10.com/4/10611187", type: "omg" },
      { url: "https://omg10.com/4/10637648", type: "omg" },
      // { url: 'https://incompatible-permission.com/quBl8O', type: 'egate' },
      { url: "https://omg10.com/4/10637660", type: "omg" },
      { url: "https://omg10.com/4/10637676", type: "omg" },
      // { url: 'https://incompatible-permission.com/2tCV38',  type: 'egate' },
    ];

    // Encode all links so they never appear as plain strings in client JS
    const encodedLinks = links.map((l) => ({
      u: Buffer.from(l.url).toString("base64"),
      t: l.type,
    }));

    const linksJSON = JSON.stringify(encodedLinks);

    const script = `
(function(){
  if (window._okl_loaded) return;
  window._okl_loaded = true;

  var _links = ${linksJSON};
  var _d = function(s){ return atob(s); };

  // Excluded paths
  var _xp = ['/login', '/playlist', '/terms', '/privacy', '/disclaimer', '/profile', '/premium', '/register'];

  // ---- Configuration ----
  var COOLDOWN       = 12000;    // 13s minimum between any link show
  var FIRST_WAIT     = 3000;     // 3s before first link allowed after page load
  var MAX_PER_LINK_H = 3;        // max 3 shows per link per hour
  var LINK_HOUR      = 10800000;  // 30 min in ms
  var VIEW_COOLDOWN  = 14400000; // 4h cooldown if user actually VIEWED the link
  var VIEW_THRESHOLD = 12000;    // 12s = user actually viewed (didn't close instantly)
  var TYPE_COOLDOWN  = 1800000;  // 30min reduced frequency for same-type after a view
  var INACTIVE_MS    = 12000;    // 12s without REAL interaction = inactive
  // var REST_AFTER_MAX = 300000;   // 5min rest after hitting hourly limit
  var STORAGE_KEY    = '_okl';   // localStorage key

  // ---- Touch/scroll discrimination ----
  var touchStartX = 0;
  var touchStartY = 0;
  var touchStartTime = 0;
  var isScrolling = false;
  var SCROLL_THRESHOLD = 10; // px movement to consider it a scroll, not a tap

  // ---- State ----
  var ready = false;
  var active = false;
  var activityTimer = null;
  var pageLoadTime = Date.now();

  // ---- localStorage persistence ----
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

  // State structure:
  // {
  //   lastShow: timestamp,
  //   totalHour: { count, start },
  //   resting: { active, start },
  //   links: {
  //     [base64url]: {
  //       shows: [ { ts, viewed } ],  // show history
  //       viewedUntil: timestamp       // 24h cooldown timestamp
  //     }
  //   },
  //   typeCooldowns: {
  //     [type]: timestamp              // when type cooldown expires
  //   }
  // }

  var state = loadState();
  var now0 = Date.now();

  // Initialize defaults
  if (!state.lastShow) state.lastShow = 0;
  if (!state.links) state.links = {};
  if (!state.typeCooldowns) state.typeCooldowns = {};

  // Clean old link show history (older than 1 hour)
  for (var k in state.links) {
    if (state.links[k].shows) {
      state.links[k].shows = state.links[k].shows.filter(function(s) {
        return now0 - s.ts < LINK_HOUR;
      });
    }
    // Clear expired 24h cooldowns
    if (state.links[k].viewedUntil && now0 >= state.links[k].viewedUntil) {
      state.links[k].viewedUntil = 0;
    }
  }

  saveState(state);

  // ---- Helpers ----
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

  // Only real user interactions mark as active (mouse click area, keyboard)
  // NOT scroll — scroll should not count as "active for ad purposes"
  document.addEventListener('mousemove', markActive, { passive: true, capture: true });
  document.addEventListener('keydown', markActive, { passive: true, capture: true });

  // Arm readiness after FIRST_WAIT
  setTimeout(function() { ready = true; }, FIRST_WAIT);

  // ---- Visibility: pause when tab is hidden ----
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      active = false;
      if (activityTimer) clearTimeout(activityTimer);
    }
  });

  // ---- Pick the best available link ----
  function pickLink() {
    var now = Date.now();
    var available = [];

    for (var i = 0; i < _links.length; i++) {
      var link = _links[i];
      var ls = state.links[link.u] || { shows: [], viewedUntil: 0 };

      // Skip if under 24h view cooldown
      if (ls.viewedUntil && now < ls.viewedUntil) continue;

      // Skip if shown >= MAX_PER_LINK_H times this hour
      var recentShows = (ls.shows || []).filter(function(s) {
        return now - s.ts < LINK_HOUR;
      });
      if (recentShows.length >= MAX_PER_LINK_H) continue;

      // Skip if this link's TYPE is in cooldown
      var typeCd = state.typeCooldowns[link.t];
      if (typeCd && now < typeCd) continue;

      // Score: fewer recent shows = higher priority
      available.push({
        index: i,
        link: link,
        showCount: recentShows.length
      });
    }

    if (available.length === 0) return null;

    // Sort by least shown, then pick randomly among the least shown
    available.sort(function(a, b) { return a.showCount - b.showCount; });
    var minShows = available[0].showCount;
    var candidates = available.filter(function(a) { return a.showCount === minShows; });

    // Random pick from best candidates
    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    return pick.link;
  }

  // ---- Record that we opened a link, and track if user viewed it ----
  function recordShow(link, openAdInCurrentWindow) {
    var now = Date.now();

    // Update link state
    if (!state.links[link.u]) state.links[link.u] = { shows: [], viewedUntil: 0 };
    state.links[link.u].shows.push({ ts: now, viewed: false });

    // Update totals
    state.lastShow = now;

    saveState(state);

    // ---- Open the link via first-party redirector ----
    // var targetUrl = 'https://api.mangasx.online/api/o/go?target=' + encodeURIComponent(link.u);
    var targetUrl = atob(decodeURIComponent(link.u));
    var openedWindow = null;

    try {
      if (openAdInCurrentWindow) {
        window.location.href = targetUrl;
        return;
      } else {
        openedWindow = window.open(targetUrl, '_blank');
      }
    } catch(e) {}

    // Track view duration by checking if the opened window is still open
    if (openedWindow) {
      var checkInterval = setInterval(function() {
        try {
          // If window was closed
          if (openedWindow.closed) {
            clearInterval(checkInterval);
            var viewDuration = Date.now() - now;
            var lastShowIdx = state.links[link.u].shows.length - 1;

            if (viewDuration >= VIEW_THRESHOLD) {
              // User actually viewed it — 4h cooldown for this link
              state.links[link.u].shows[lastShowIdx].viewed = true;
              state.links[link.u].viewedUntil = Date.now() + VIEW_COOLDOWN;

              // Also apply type cooldown — reduce same-type frequency
              state.typeCooldowns[link.t] = Date.now() + TYPE_COOLDOWN;
            }
            saveState(state);
          }
        } catch(e) {
          // Cross-origin — can't access .closed, assume viewed after threshold
          clearInterval(checkInterval);
        }
      }, 1000);

      // Stop checking after 60s regardless
      setTimeout(function() { clearInterval(checkInterval); }, 60000);
    }
  }

  // ---- Click handler (ONLY real clicks, not scroll) ----
  function handleClick(e) {
    if (e.target.id === 'close-vip-ads') return;
    if (isExcluded()) return;
    if (!ready) return;
    if (!active) return;

    var now = Date.now();

    // Comprobar si es el activador de la sesión (primera vez en esta pestaña/sección)
    var isSessionActivator = false;
    try {
      if (!sessionStorage.getItem(STORAGE_KEY + '_act')) {
        isSessionActivator = true;
      }
    } catch(e) {}

    // Enforce cooldown (omitir cooldown si es el activador de la sesión)
    if (!isSessionActivator) {
      if (now - state.lastShow < COOLDOWN) return;
    }

    // Pick a link
    var link = pickLink();
    if (!link) return;

    var clickedAnchor = null;
    var clickedHref = null;
    if (e.target && e.target.closest) {
      clickedAnchor = e.target.closest('a[href]');
      if (clickedAnchor) {
        try { clickedHref = clickedAnchor.href; } catch(e) { clickedHref = null; }
      }
    }

    // Primer click de sesión: guardar lo que el usuario quería ver en una pestaña nueva.
    // Si no pulsó un enlace, duplicamos la página actual. Esto se hace ANTES de preventDefault
    // para mejorar compatibilidad con Brave/iOS y otros bloqueadores de popups.
    var openAdInCurrentWindow = isSessionActivator;
    var userDestination = clickedHref || location.href;
    if (openAdInCurrentWindow) {
      try {
        var userWindow = window.open(userDestination, '_blank');
        if (!userWindow) {
          var a = document.createElement('a');
          a.href = userDestination;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.style.display = 'none';
          document.documentElement.appendChild(a);
          a.click();
          setTimeout(function(){ try { a.remove(); } catch(e) {} }, 0);
        }
      } catch(e) {}
    }

    // Bloqueamos la acción original para controlar el flujo:
    // - primer click de sesión: esta ventana va al anuncio y el destino del usuario queda en nueva pestaña
    // - clicks posteriores: se abre anuncio normal y el siguiente click funciona por cooldown
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

    // Marcar la sesión como activada
    try {
      sessionStorage.setItem(STORAGE_KEY + '_act', '1');
    } catch(e) {}

    // Show it
    recordShow(link, openAdInCurrentWindow);
  }

  // ---- CLICK only — capture phase ----
  document.addEventListener('click', handleClick, true);

  // ---- MOBILE: Only trigger on TAP, not scroll/swipe ----
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
    // Only consider it a real tap if:
    // 1. The finger didn't move much (not a scroll/swipe)
    // 2. The touch was short (not a long press)
    var touchDuration = Date.now() - touchStartTime;

    if (!isScrolling && touchDuration < 500) {
      // This was a real tap — mark active and handle
      markActive();
      // Small delay to let click event fire first and avoid double-trigger
      // The click handler will handle it
    }
    // If it was a scroll, do NOTHING — no ad trigger
  }, { passive: true, capture: true });

})();
`;

    const obfuscatedResult = JavaScriptObfuscator.obfuscate(script, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 1,
      numbersToExpressions: true,
      simplify: true,
      stringArrayShuffle: true,
      splitStrings: true,
      stringArrayThreshold: 1,
    });

    return obfuscatedResult.getObfuscatedCode();
  }
}
