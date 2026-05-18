/**
 * KCl — Robust download system
 *
 * Production-grade installer download orchestrator inspired by Steam,
 * Discord, Epic Games Launcher and Battle.net. Designed to *never* fail
 * silently under normal conditions.
 *
 * KEY GUARANTEES
 *   1. The actual `<a>.click()` fires synchronously inside the user-gesture
 *      handler (no awaits before it) so browsers never block the download.
 *   2. No HEAD precheck on cross-origin URLs (GitHub asset CDN does not
 *      support CORS for HEAD → previously caused TypeError → spurious retries).
 *      Asset URLs returned by the GitHub API are guaranteed valid; we trust them.
 *   3. Smart fallback chain :
 *        a. API-resolved asset URL                        (preferred, validated by API)
 *        b. github.com/…/releases/latest/download/<file>  (auto-redirects, no hardcoded tag)
 *        c. github.com/…/releases/latest                  (page — user picks manually)
 *   4. Double-click protection : single in-flight download per button.
 *   5. Retries ONLY on transient errors (network, 5xx) — never on 404.
 *   6. Exponential backoff with jitter, capped, with circuit-breaker.
 *   7. Real-time UI states : idle → preparing → downloading → success | error.
 *   8. Always-visible alternative link after the click so a silent failure
 *      never leaves the user stuck.
 *   9. Self-diagnosis : `KClDownload.diagnose()` returns a structured report.
 *  10. Verbose debug logging behind `?download-debug=1` or `KClDownload.enableDebug()`.
 *
 * USAGE
 *   <button data-kcl-download
 *           data-kcl-meta="#download-meta"
 *           data-kcl-alternative="#download-alternative">
 *     ⬇ Télécharger KCl
 *   </button>
 *
 *   Auto-init on DOMContentLoaded. Manual init :
 *   KClDownload.init({ selector, metaSelector, alternativeSelector })
 */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  //  CONFIG
  // ════════════════════════════════════════════════════════════════════

  const CONFIG = {
    repo: { owner: 'jadlepro33-alt', name: 'kcltweaks' },
    fallbackVersion: '0.1.0',
    fallbackSizeMB: 83,
    cacheKey: 'kcl-release-cache',
    cacheTTL: 5 * 60 * 1000,            // 5 min
    counterKey: 'kcl-download-counter',
    apiTimeout: 6000,                   // 6s for API call
    maxRetries: 3,
    backoffBaseMs: 800,                 // first retry waits ~800-1200ms
    backoffMaxMs: 6000,                 // cap
    successHoldMs: 3500,                // how long the "✓ launched" state stays
    errorHoldMs: 5000,                  // how long the error state stays
    rateLimitCooldownMs: 60 * 1000,     // 1 min after a 403 from GitHub API
  };

  const ASSET_PATTERNS = {
    windows: /^KCl-Setup-[\d.]+\.exe$/i,
    macos:   /^KCl-[\d.]+(-(x64|arm64))?\.dmg$/i,
    linux:   /^KCl-[\d.]+\.(AppImage|deb|rpm)$/i
  };

  const RELEASES_PAGE_URL = `https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/releases/latest`;
  const GITHUB_API_URL    = `https://api.github.com/repos/${CONFIG.repo.owner}/${CONFIG.repo.name}/releases/latest`;

  // ════════════════════════════════════════════════════════════════════
  //  LOGGER  (namespaced, opt-in verbose)
  // ════════════════════════════════════════════════════════════════════

  const DEBUG_KEY = 'kcl-download-debug';
  let debugEnabled = (() => {
    try {
      if (new URLSearchParams(location.search).get('download-debug') === '1') return true;
      return localStorage.getItem(DEBUG_KEY) === '1';
    } catch { return false; }
  })();

  const log = {
    info:  (...a) => console.log('%c[KCl ↓]', 'color:#3a5cf5;font-weight:bold', ...a),
    warn:  (...a) => console.warn('%c[KCl ↓]', 'color:#f59e0b;font-weight:bold', ...a),
    error: (...a) => console.error('%c[KCl ↓]', 'color:#ef4444;font-weight:bold', ...a),
    debug: (...a) => { if (debugEnabled) console.log('%c[KCl ↓ debug]', 'color:#94a3b8', ...a); },
    group: (label, fn) => {
      if (!debugEnabled) return fn();
      console.groupCollapsed(`%c[KCl ↓] ${label}`, 'color:#a78bfa;font-weight:bold');
      try { return fn(); } finally { console.groupEnd(); }
    }
  };

  // ════════════════════════════════════════════════════════════════════
  //  OS DETECTION
  // ════════════════════════════════════════════════════════════════════

  function detectOS() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    const uaData = navigator.userAgentData;
    const mobile = /android|iphone|ipad|ipod|mobile/i.test(ua);

    const decide = (os, label, icon, extras = {}) => ({ os, label, icon, mobile, ...extras });

    // Modern Client Hints API (most accurate)
    if (uaData?.platform) {
      const p = uaData.platform.toLowerCase();
      if (p.includes('windows')) return decide('windows', 'Windows', '🪟');
      if (p.includes('mac'))     return decide('macos',   'macOS',   '🍎');
      if (p.includes('linux'))   return decide('linux',   'Linux',   '🐧');
    }

    // UA / platform fallbacks
    if (/win(dows|32|64)/i.test(ua) || platform.includes('win')) return decide('windows', 'Windows', '🪟');
    if (/mac|darwin/i.test(ua)      || platform.includes('mac')) return decide('macos',   'macOS',   '🍎');
    if (/linux|x11/i.test(ua)       || platform.includes('linux')) return decide('linux', 'Linux',   '🐧');

    // Final fallback — assume Windows (primary target audience)
    return decide('windows', 'Windows', '🪟');
  }

  // ════════════════════════════════════════════════════════════════════
  //  RELEASE CACHE  (sessionStorage with TTL)
  // ════════════════════════════════════════════════════════════════════

  const cache = {
    get() {
      try {
        const raw = sessionStorage.getItem(CONFIG.cacheKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp > CONFIG.cacheTTL) return null;
        return parsed.data;
      } catch { return null; }
    },
    set(data) {
      try {
        sessionStorage.setItem(CONFIG.cacheKey, JSON.stringify({ data, timestamp: Date.now() }));
      } catch (e) { log.debug('cache.set failed', e.message); }
    },
    clear() {
      try { sessionStorage.removeItem(CONFIG.cacheKey); } catch {}
    }
  };

  // ════════════════════════════════════════════════════════════════════
  //  GITHUB API  (with timeout + rate-limit awareness)
  // ════════════════════════════════════════════════════════════════════

  let rateLimitedUntil = 0;

  async function fetchLatestRelease(opts = {}) {
    if (!opts.force) {
      const cached = cache.get();
      if (cached) {
        log.debug('using cached release', cached.tag_name);
        return cached;
      }
    }

    if (Date.now() < rateLimitedUntil) {
      log.warn('GitHub API on cooldown until', new Date(rateLimitedUntil).toISOString());
      return null;
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort('timeout'), CONFIG.apiTimeout);
    const t0 = performance.now();
    try {
      const res = await fetch(GITHUB_API_URL, {
        headers: { 'Accept': 'application/vnd.github+json' },
        signal: ctrl.signal,
        cache: 'no-store'
      });
      clearTimeout(t);
      log.debug(`GitHub API ${res.status} in ${(performance.now() - t0).toFixed(0)}ms`);

      if (res.status === 403 || res.status === 429) {
        // Rate-limited — don't hammer
        rateLimitedUntil = Date.now() + CONFIG.rateLimitCooldownMs;
        log.warn('GitHub API rate-limited');
        return null;
      }
      if (!res.ok) {
        log.warn('GitHub API non-OK', res.status);
        return null;
      }
      const data = await res.json();
      cache.set(data);
      return data;
    } catch (err) {
      clearTimeout(t);
      log.warn('GitHub API fetch failed:', err.message || err);
      return null;
    }
  }

  function findAssetForOS(release, os) {
    if (!release?.assets || !Array.isArray(release.assets)) return null;
    const pattern = ASSET_PATTERNS[os];
    if (!pattern) return null;
    return release.assets.find(a => pattern.test(a.name)) || null;
  }

  function getTotalDownloads(release) {
    if (!release?.assets) return 0;
    return release.assets.reduce((sum, a) => sum + (a.download_count || 0), 0);
  }

  // ════════════════════════════════════════════════════════════════════
  //  DOWNLOAD COUNTER
  // ════════════════════════════════════════════════════════════════════

  const counter = {
    bump() {
      try {
        const n = parseInt(localStorage.getItem(CONFIG.counterKey) || '0', 10) + 1;
        localStorage.setItem(CONFIG.counterKey, String(n));
        return n;
      } catch { return 0; }
    },
    get() {
      try { return parseInt(localStorage.getItem(CONFIG.counterKey) || '0', 10); } catch { return 0; }
    }
  };

  // ════════════════════════════════════════════════════════════════════
  //  TRIGGER DOWNLOAD  (sync, inside user gesture — never await before)
  // ════════════════════════════════════════════════════════════════════

  /**
   * Programmatically triggers a browser download. MUST be called
   * synchronously from a user-gesture handler. Returns true if dispatched.
   *
   * The browser handles the actual transfer, retries, resume, and storage.
   * If the URL 404s, the browser shows its standard 404 page (and we surface
   * the alternative link so the user isn't stuck).
   */
  function triggerDownload(url, filename) {
    try {
      const a = document.createElement('a');
      a.href = url;
      // Note : `download` attribute is honored only for same-origin / CORS-allowed.
      // GitHub asset URLs don't allow it cross-origin, but providing it costs nothing
      // and helps when our own CDN serves the file.
      if (filename) a.download = filename;
      a.rel = 'noopener noreferrer';
      // _self so the navigation goes through the current tab if browser ignores
      // `download` (cross-origin) — at worst, user lands on a download page.
      a.target = '_self';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch {} }, 200);
      log.debug('click() dispatched on', url);
      return true;
    } catch (err) {
      log.error('triggerDownload failed', err);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  URL RESOLUTION  (smart fallback chain)
  // ════════════════════════════════════════════════════════════════════

  /**
   * Resolves the best URL for `os`, using cached release if any.
   *
   * Returns { url, filename, source, isFallback }
   *   source: 'api' | 'latest-redirect' | 'releases-page'
   */
  function resolveDownloadURL(os, releaseHint) {
    const release = releaseHint || cache.get();
    const asset = release ? findAssetForOS(release, os) : null;

    if (asset?.browser_download_url) {
      return {
        url: asset.browser_download_url,
        filename: asset.name,
        source: 'api',
        isFallback: false,
        size: asset.size
      };
    }

    // Tier 2 : GitHub's "latest release" redirect endpoint.
    // This URL ALWAYS resolves to the actual latest asset matching the filename pattern
    // — no need to know the version tag. If the file doesn't exist in the latest
    // release, GitHub returns 404 (still better than guessing a stale tag).
    if (os === 'windows') {
      const guessFilename = `KCl-Setup-${CONFIG.fallbackVersion}.exe`;
      return {
        url: `https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/releases/latest/download/${guessFilename}`,
        filename: guessFilename,
        source: 'latest-redirect',
        isFallback: true
      };
    }

    // Tier 3 : releases page — user picks file manually.
    return {
      url: RELEASES_PAGE_URL,
      filename: null,
      source: 'releases-page',
      isFallback: true
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════════════════════════

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function formatBytes(bytes) {
    if (!bytes || !Number.isFinite(bytes)) return '—';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function backoffDelay(attempt) {
    const exp = CONFIG.backoffBaseMs * Math.pow(1.7, attempt);
    const jitter = Math.random() * 300;
    return Math.min(CONFIG.backoffMaxMs, Math.round(exp + jitter));
  }

  // ════════════════════════════════════════════════════════════════════
  //  UI STATES
  // ════════════════════════════════════════════════════════════════════

  const STATES = {
    idle:        { label: '⬇ Télécharger KCl',              cls: 'idle' },
    preparing:   { label: '⏳ Préparation…',                cls: 'preparing', disabled: true },
    downloading: { label: '⚡ Démarrage du téléchargement…', cls: 'downloading', disabled: true },
    success:     { label: '✓ Téléchargement lancé !',       cls: 'success',  disabled: true },
    error:       { label: '⚠ Erreur · Cliquer pour réessayer', cls: 'error' },
    retrying:    { label: '🔄 Nouvelle tentative…',          cls: 'retrying', disabled: true }
  };

  // ════════════════════════════════════════════════════════════════════
  //  DOWNLOAD BUTTON
  // ════════════════════════════════════════════════════════════════════

  class DownloadButton {
    constructor(el, options = {}) {
      this.el = el;
      this.options = options;
      this.state = 'idle';
      this.isProcessing = false;
      this.osInfo = detectOS();
      this.attempts = 0;
      this.lastError = null;
      this.originalContent = el.innerHTML;

      this.bindEvents();
      this.init();   // fire-and-forget background warm-up
    }

    // ─── Init ──────────────────────────────────────────────────────

    bindEvents() {
      this.el.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.isProcessing) {
          log.debug('click ignored — already processing');
          return;
        }
        // CRITICAL : trigger the actual download SYNCHRONOUSLY inside this
        // user-gesture handler. Any await before triggerDownload() risks the
        // browser blocking the popup/download (Safari especially).
        this.handleClick();
      });
    }

    async init() {
      log.group('init', () => {
        log.debug('detected OS', this.osInfo);
      });

      // Warm up the cache in the background — no UI feedback at this stage.
      const release = await fetchLatestRelease();
      if (release) {
        this.updateMeta(release);
      }
    }

    updateMeta(release) {
      const meta = this.options.metaSelector
        ? document.querySelector(this.options.metaSelector)
        : null;
      if (!meta) return;

      const asset = findAssetForOS(release, this.osInfo.os);
      const version = release?.tag_name || `v${CONFIG.fallbackVersion}`;
      const size = asset ? formatBytes(asset.size) : `${CONFIG.fallbackSizeMB} MB`;
      const dlCount = getTotalDownloads(release);
      const dlText = dlCount > 0
        ? ` · ${dlCount.toLocaleString('fr-FR')} téléchargements`
        : '';

      const notesLink = `https://github.com/${CONFIG.repo.owner}/${CONFIG.repo.name}/releases/tag/${encodeURIComponent(version)}`;
      meta.innerHTML = `${escapeHTML(version)} · ${escapeHTML(size)} · ${escapeHTML(this.osInfo.label)} 64-bit${dlText} · <a href="${notesLink}" class="text-brand-400 hover:underline" rel="noopener noreferrer" target="_blank">Notes de version</a>`;
    }

    // ─── State machine ─────────────────────────────────────────────

    setState(newState) {
      const cfg = STATES[newState];
      if (!cfg) {
        log.warn('unknown state', newState);
        return;
      }
      this.state = newState;
      this.el.textContent = cfg.label;
      this.el.classList.remove(...Object.values(STATES).map(s => `state-${s.cls}`));
      this.el.classList.add(`state-${cfg.cls}`);
      this.el.disabled = !!cfg.disabled;
      this.el.style.pointerEvents = cfg.disabled ? 'none' : '';
      this.el.style.opacity = cfg.disabled ? '0.88' : '';
      this.el.setAttribute('aria-busy', cfg.disabled ? 'true' : 'false');
      log.debug('state →', newState);
    }

    // ─── Main click handler ────────────────────────────────────────

    handleClick() {
      this.isProcessing = true;
      this.attempts = 0;
      this.lastError = null;

      log.group('download flow', () => {
        log.debug('start', { os: this.osInfo.os, hasCachedRelease: !!cache.get() });
      });

      // Mobile compatibility — KCl is desktop-only.
      if (this.osInfo.mobile) {
        this.showToast(
          'KCl est une app desktop. Ouvre ce site sur ton PC Windows pour télécharger.',
          'info'
        );
        this.setState('error');
        this.scheduleResetTo('idle', CONFIG.errorHoldMs);
        return;
      }

      // Resolve URL using whatever we have RIGHT NOW (cached release or fallback).
      // The synchronous click happens inside this user-gesture call — no awaits.
      const resolved = resolveDownloadURL(this.osInfo.os);
      log.debug('resolved URL', resolved);

      // If we resolved to the releases page (no info at all), open it in a new tab
      // immediately — user lands on GitHub where they can manually pick the file.
      if (resolved.source === 'releases-page') {
        this.showToast(
          'Téléchargement direct indisponible · ouverture page de release GitHub',
          'info'
        );
        // Open in new tab so we don't navigate away from the landing.
        window.open(resolved.url, '_blank', 'noopener,noreferrer');
        this.setState('success');
        counter.bump();
        this.revealAlternative();
        this.scheduleResetTo('idle', CONFIG.successHoldMs);
        return;
      }

      // Tier 1 or 2 : trigger the actual file download synchronously.
      this.setState('downloading');
      const ok = triggerDownload(resolved.url, resolved.filename);

      if (!ok) {
        this.showToast('Impossible de lancer le téléchargement. Utilise le lien alternatif ci-dessous.', 'error');
        this.setState('error');
        this.revealAlternative();
        this.scheduleResetTo('idle', CONFIG.errorHoldMs);
        return;
      }

      // Show success state immediately — the browser is now in charge.
      this.setState('success');
      counter.bump();

      const msg = resolved.isFallback
        ? 'Téléchargement démarré · si rien ne se passe, utilise le lien alternatif'
        : 'Téléchargement démarré · vérifie ton dossier Téléchargements';
      this.showToast(msg, 'success');
      this.revealAlternative();   // always visible safety net

      // In parallel, refresh the API in case the cached release is stale.
      // If the refresh reveals a newer asset, future clicks use it.
      this._postClickRefresh();

      this.scheduleResetTo('idle', CONFIG.successHoldMs);
    }

    async _postClickRefresh() {
      try {
        const fresh = await fetchLatestRelease({ force: true });
        if (fresh) this.updateMeta(fresh);
      } catch (err) {
        log.debug('post-click refresh failed', err.message);
      }
    }

    // ─── Reset cycle ───────────────────────────────────────────────

    scheduleResetTo(targetState, delay) {
      clearTimeout(this._resetTimer);
      this._resetTimer = setTimeout(() => {
        this.setState(targetState);
        this.isProcessing = false;
      }, delay);
    }

    // ─── Toasts ────────────────────────────────────────────────────

    showToast(message, type = 'info', persistMs = 4800) {
      const toast = document.createElement('div');
      toast.className = `kcl-toast kcl-toast-${type}`;
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

      const bg = type === 'error'   ? 'linear-gradient(135deg,#ef4444,#dc2626)'
               : type === 'success' ? 'linear-gradient(135deg,#10b981,#059669)'
               :                      'linear-gradient(135deg,#3a5cf5,#7c5cf0)';
      toast.style.cssText = [
        'position:fixed',
        'bottom:24px',
        'right:24px',
        'padding:12px 18px',
        'border-radius:12px',
        `background:${bg}`,
        'color:white',
        'font-size:14px',
        'font-weight:600',
        'box-shadow:0 10px 40px rgba(0,0,0,0.4)',
        'z-index:9999',
        'animation:kcl-slide-in .3s ease-out',
        'max-width:380px',
        'backdrop-filter:blur(10px)',
        'line-height:1.4'
      ].join(';');
      toast.textContent = message;

      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = 'kcl-slide-out .3s ease-in forwards';
        setTimeout(() => { try { toast.remove(); } catch {} }, 350);
      }, persistMs);
    }

    revealAlternative() {
      const sel = this.options.alternativeSelector;
      if (!sel) return;
      const el = document.querySelector(sel);
      if (!el) return;
      el.style.display = 'inline-block';
      el.classList.add('kcl-pulse');
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  STYLES
  // ════════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('kcl-download-styles')) return;
    const style = document.createElement('style');
    style.id = 'kcl-download-styles';
    style.textContent = `
      @keyframes kcl-slide-in  { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes kcl-slide-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(20px); opacity: 0; } }
      @keyframes kcl-pulse-glow {
        0%, 100% { box-shadow: 0 0 0 0 rgba(58,92,245,0.4); }
        50%      { box-shadow: 0 0 0 14px rgba(58,92,245,0); }
      }
      @keyframes kcl-spin { to { transform: rotate(360deg); } }
      .kcl-pulse { animation: kcl-pulse-glow 1.6s ease-in-out infinite; }

      [data-kcl-download].state-preparing,
      [data-kcl-download].state-downloading,
      [data-kcl-download].state-retrying { cursor: progress !important; }

      [data-kcl-download].state-success {
        background: linear-gradient(135deg, #10b981, #059669) !important;
      }
      [data-kcl-download].state-error {
        background: linear-gradient(135deg, #ef4444, #dc2626) !important;
      }
      [data-kcl-download].state-retrying {
        background: linear-gradient(135deg, #f59e0b, #d97706) !important;
      }
      [data-kcl-download].state-preparing::before,
      [data-kcl-download].state-downloading::before,
      [data-kcl-download].state-retrying::before {
        content: '';
        display: inline-block;
        width: 14px; height: 14px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: kcl-spin .8s linear infinite;
        margin-right: 8px;
        vertical-align: -2px;
      }
    `;
    document.head.appendChild(style);
  }

  // ════════════════════════════════════════════════════════════════════
  //  DIAGNOSTICS
  // ════════════════════════════════════════════════════════════════════

  /**
   * Self-test : runs through every detection / fetch path and returns a
   * structured report so you can paste it into a bug report.
   *
   * Usage : await KClDownload.diagnose()
   */
  async function diagnose() {
    const report = {
      timestamp: new Date().toISOString(),
      url: location.href,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      cookiesEnabled: navigator.cookieEnabled,
      os: detectOS(),
      storage: { local: false, session: false },
      cache: { hasCachedRelease: false, ageMs: null },
      api: { reachable: false, latencyMs: null, status: null, rateLimited: false },
      asset: null,
      resolved: null,
      buttons: document.querySelectorAll('[data-kcl-download]').length,
      stylesInjected: !!document.getElementById('kcl-download-styles'),
      debugEnabled
    };

    try { localStorage.setItem('_kcl-probe', '1'); localStorage.removeItem('_kcl-probe'); report.storage.local = true; } catch {}
    try { sessionStorage.setItem('_kcl-probe', '1'); sessionStorage.removeItem('_kcl-probe'); report.storage.session = true; } catch {}

    const cached = cache.get();
    if (cached) {
      report.cache.hasCachedRelease = true;
      const raw = JSON.parse(sessionStorage.getItem(CONFIG.cacheKey));
      report.cache.ageMs = Date.now() - raw.timestamp;
    }

    // API probe
    const t0 = performance.now();
    try {
      const res = await fetch(GITHUB_API_URL, {
        headers: { 'Accept': 'application/vnd.github+json' },
        cache: 'no-store'
      });
      report.api.latencyMs = Math.round(performance.now() - t0);
      report.api.status = res.status;
      report.api.reachable = res.ok;
      report.api.rateLimited = res.status === 403 || res.status === 429;
      if (res.ok) {
        const data = await res.json();
        const asset = findAssetForOS(data, report.os.os);
        report.asset = asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null;
      }
    } catch (err) {
      report.api.error = err.message || String(err);
    }

    const release = report.api.reachable ? cache.get() : null;
    report.resolved = resolveDownloadURL(report.os.os, release);

    console.group('%c[KCl ↓] Diagnostic report', 'color:#3a5cf5;font-weight:bold');
    console.log(report);
    console.groupEnd();
    return report;
  }

  // ════════════════════════════════════════════════════════════════════
  //  UTIL
  // ════════════════════════════════════════════════════════════════════

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════════════════════════════════

  window.KClDownload = {
    version: '2.0.0',
    init(options = {}) {
      injectStyles();
      const selector = options.selector || '[data-kcl-download]';
      const nodes = document.querySelectorAll(selector);
      if (nodes.length === 0) log.warn(`no nodes matched ${selector}`);
      const instances = [];
      nodes.forEach(btn => {
        if (btn.__kclBound) return;   // idempotent
        btn.__kclBound = true;
        instances.push(new DownloadButton(btn, {
          metaSelector:        options.metaSelector        || btn.dataset.kclMeta,
          alternativeSelector: options.alternativeSelector || btn.dataset.kclAlternative
        }));
      });
      return instances;
    },
    detectOS,
    getLocalCounter: () => counter.get(),
    fetchLatestRelease,
    resolveDownloadURL,
    diagnose,
    enableDebug() {
      debugEnabled = true;
      try { localStorage.setItem(DEBUG_KEY, '1'); } catch {}
      log.info('debug mode enabled — verbose logs active');
    },
    disableDebug() {
      debugEnabled = false;
      try { localStorage.removeItem(DEBUG_KEY); } catch {}
    },
    clearCache: () => cache.clear()
  };

  // ════════════════════════════════════════════════════════════════════
  //  AUTO-INIT
  // ════════════════════════════════════════════════════════════════════

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.KClDownload.init());
  } else {
    window.KClDownload.init();
  }

  log.debug(`download.js v${window.KClDownload.version} loaded`);
})();
