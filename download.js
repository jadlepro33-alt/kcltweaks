/**
 * KCl - Système de téléchargement intelligent
 *
 * Features :
 * - Détection OS automatique (Windows/macOS/Linux)
 * - Récupération version + download count via GitHub API
 * - Bouton états : idle → preparing → starting → complete/error
 * - Retry automatique avec backoff exponentiel (3 tentatives max)
 * - Protection double-clic
 * - Animation progress moderne
 * - Fallback alternative (page release directe)
 * - Cache du manifest 5 min pour éviter rate limit GitHub API
 *
 * Inspire Discord/Steam/Notion download experience.
 */

(function () {
  'use strict';

  const REPO_OWNER = 'jadlepro33-alt';
  const REPO_NAME = 'kcltweaks';
  const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const FALLBACK_VERSION = '0.1.0';
  const ASSET_PATTERNS = {
    windows: /^KCl-Setup-[\d.]+\.exe$/i,
    macos: /^KCl-[\d.]+\.dmg$/i,
    linux: /^KCl-[\d.]+\.(AppImage|deb|rpm)$/i
  };
  const CACHE_KEY = 'kcl-release-cache';
  const CACHE_TTL = 5 * 60 * 1000; // 5 min
  const COUNTER_KEY = 'kcl-download-counter';
  const MAX_RETRIES = 3;
  const RETRY_DELAY_BASE = 2000;

  // ============================================================
  // DETECTION OS
  // ============================================================

  function detectOS() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const platform = (navigator.platform || '').toLowerCase();
    const userAgentData = navigator.userAgentData;

    // Modern API (Chromium 90+)
    if (userAgentData?.platform) {
      const p = userAgentData.platform.toLowerCase();
      if (p.includes('windows')) return { os: 'windows', label: 'Windows', icon: '🪟' };
      if (p.includes('mac')) return { os: 'macos', label: 'macOS', icon: '🍎' };
      if (p.includes('linux')) return { os: 'linux', label: 'Linux', icon: '🐧' };
    }

    // Fallback UA
    if (/win(dows|32|64)/i.test(ua) || platform.includes('win')) return { os: 'windows', label: 'Windows', icon: '🪟' };
    if (/mac|darwin/i.test(ua) || platform.includes('mac')) return { os: 'macos', label: 'macOS', icon: '🍎' };
    if (/linux|x11/i.test(ua) || platform.includes('linux')) return { os: 'linux', label: 'Linux', icon: '🐧' };

    // Mobile detection (offer Windows by default)
    if (/android|iphone|ipad|mobile/i.test(ua)) return { os: 'windows', label: 'Windows', icon: '🪟', mobile: true };

    return { os: 'windows', label: 'Windows', icon: '🪟' };
  }

  // ============================================================
  // GITHUB API + CACHE
  // ============================================================

  async function fetchLatestRelease() {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.timestamp < CACHE_TTL) {
          return parsed.data;
        }
      }
    } catch (e) { /* ignore cache errors */ }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(GITHUB_API, {
        headers: { 'Accept': 'application/vnd.github+json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('GitHub API ' + res.status);
      const data = await res.json();
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
      } catch (e) { /* quota exceeded, ignore */ }
      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('[KCl Download] GitHub API unavailable:', err.message);
      return null;
    }
  }

  function findAssetForOS(release, os) {
    if (!release?.assets) return null;
    const pattern = ASSET_PATTERNS[os];
    return release.assets.find(a => pattern.test(a.name)) || null;
  }

  function getTotalDownloads(release) {
    if (!release?.assets) return 0;
    return release.assets.reduce((sum, a) => sum + (a.download_count || 0), 0);
  }

  // ============================================================
  // LOCAL DOWNLOAD COUNTER (persist across sessions)
  // ============================================================

  function bumpLocalCounter() {
    try {
      const current = parseInt(localStorage.getItem(COUNTER_KEY) || '0', 10);
      localStorage.setItem(COUNTER_KEY, String(current + 1));
      return current + 1;
    } catch (e) { return 0; }
  }

  function getLocalCounter() {
    try { return parseInt(localStorage.getItem(COUNTER_KEY) || '0', 10); } catch { return 0; }
  }

  // ============================================================
  // DOWNLOAD TRIGGER avec retry
  // ============================================================

  function triggerDownload(url, filename) {
    // Méthode standard moderne : create invisible <a> with download attribute
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '';
    a.rel = 'noopener noreferrer';
    a.target = '_self';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);
  }

  async function downloadWithRetry(url, filename, onProgress) {
    let attempt = 0;
    let lastError = null;

    while (attempt < MAX_RETRIES) {
      try {
        // Pré-check : vérifier que l'URL répond (HEAD request)
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 8000);
        const head = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
        clearTimeout(tid);

        if (head.status === 404) {
          throw new Error('Fichier introuvable (404). La release n\'est peut-être pas encore publiée.');
        }
        if (!head.ok && head.status !== 0) { // status 0 = opaque redirect (OK for releases)
          throw new Error('Serveur indisponible (HTTP ' + head.status + ')');
        }

        // Trigger download
        triggerDownload(url, filename);
        return { success: true, attempt: attempt + 1 };
      } catch (err) {
        lastError = err;
        attempt++;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
          onProgress?.({ phase: 'retry', attempt, nextRetryMs: delay, error: err.message });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    return { success: false, error: lastError?.message || 'Échec inconnu', attempts: attempt };
  }

  // ============================================================
  // UI : DownloadButton component
  // ============================================================

  const STATES = {
    idle: { label: '⬇ Télécharger KCl', class: 'idle' },
    preparing: { label: '⏳ Préparation...', class: 'preparing', disabled: true },
    downloading: { label: '⚡ Démarrage du téléchargement...', class: 'downloading', disabled: true },
    success: { label: '✓ Téléchargement lancé !', class: 'success', disabled: true },
    error: { label: '⚠ Erreur · Réessayer', class: 'error' },
    retry: { label: '🔄 Nouvelle tentative...', class: 'retry', disabled: true }
  };

  class DownloadButton {
    constructor(element, options = {}) {
      this.el = element;
      this.options = options;
      this.state = 'idle';
      this.isProcessing = false;
      this.osInfo = detectOS();
      this.release = null;
      this.asset = null;

      this.originalContent = this.el.innerHTML;
      this.originalHref = this.el.getAttribute('href');

      this.bindEvents();
      this.init();
    }

    bindEvents() {
      this.el.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.isProcessing) return;
        this.handleClick();
      });
    }

    async init() {
      // Récupère version + asset en arrière-plan
      this.release = await fetchLatestRelease();
      if (this.release) {
        this.asset = findAssetForOS(this.release, this.osInfo.os);
        this.updateMeta();
      }
    }

    updateMeta() {
      // Met à jour le label sous le bouton (taille, version, downloads)
      const metaEl = this.options.metaSelector
        ? document.querySelector(this.options.metaSelector)
        : null;
      if (!metaEl || !this.release) return;

      const version = this.release.tag_name || `v${FALLBACK_VERSION}`;
      const size = this.asset ? formatBytes(this.asset.size) : '~83 MB';
      const dl = getTotalDownloads(this.release);
      const dlText = dl > 0 ? ` · ${dl.toLocaleString('fr-FR')} téléchargements` : '';

      metaEl.innerHTML = `${version} · ${size} · ${this.osInfo.label} 64-bit${dlText} · <a href="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${version}" class="text-brand-400 hover:underline">Notes de version</a>`;
    }

    setState(newState) {
      this.state = newState;
      const cfg = STATES[newState];
      if (!cfg) return;
      this.el.textContent = cfg.label;
      this.el.classList.remove(...Object.values(STATES).map(s => `state-${s.class}`));
      this.el.classList.add(`state-${cfg.class}`);
      this.el.disabled = !!cfg.disabled;
      if (cfg.disabled) {
        this.el.style.pointerEvents = 'none';
        this.el.style.opacity = '0.85';
      } else {
        this.el.style.pointerEvents = '';
        this.el.style.opacity = '';
      }
    }

    showProgressBar() {
      let bar = this.el.parentElement.querySelector('.kcl-progress');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'kcl-progress';
        bar.innerHTML = '<div class="kcl-progress-fill"></div>';
        bar.style.cssText = 'width:100%;max-width:320px;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;margin:8px auto 0;transition:opacity .3s';
        const fill = bar.querySelector('.kcl-progress-fill');
        fill.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#3a5cf5,#a78bfa);transition:width 2s ease-out;border-radius:2px;box-shadow:0 0 12px rgba(58,92,245,0.6)';
        this.el.parentElement.appendChild(bar);
      }
      const fill = bar.querySelector('.kcl-progress-fill');
      requestAnimationFrame(() => { fill.style.width = '100%'; });
      bar.style.opacity = '1';
      this._progressBar = bar;
    }

    hideProgressBar(delay = 800) {
      if (!this._progressBar) return;
      setTimeout(() => {
        if (this._progressBar) {
          this._progressBar.style.opacity = '0';
          setTimeout(() => this._progressBar?.remove(), 400);
          this._progressBar = null;
        }
      }, delay);
    }

    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = 'kcl-toast kcl-toast-' + type;
      toast.textContent = message;
      const bg = type === 'error' ? 'linear-gradient(135deg,#ef4444,#dc2626)'
               : type === 'success' ? 'linear-gradient(135deg,#10b981,#059669)'
               : 'linear-gradient(135deg,#3a5cf5,#7c5cf0)';
      toast.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:12px;background:${bg};color:white;font-size:14px;font-weight:600;box-shadow:0 10px 40px rgba(0,0,0,0.4);z-index:9999;animation:kcl-slide-in .3s ease-out;max-width:380px;backdrop-filter:blur(10px)`;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.animation = 'kcl-slide-out .3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
      }, 4500);
    }

    async handleClick() {
      if (this.isProcessing) return;
      this.isProcessing = true;

      try {
        // 1. Preparing
        this.setState('preparing');
        await sleep(300);

        // 2. Refresh release info (au cas où elle vient juste d'être publiée)
        if (!this.release || !this.asset) {
          sessionStorage.removeItem(CACHE_KEY);
          this.release = await fetchLatestRelease();
          if (this.release) {
            this.asset = findAssetForOS(this.release, this.osInfo.os);
            this.updateMeta();
          }
        }

        // 3. Compatibility check (mobile)
        if (this.osInfo.mobile) {
          this.showToast('KCl est une app Windows desktop. Télécharge depuis ton PC.', 'info');
          this.setState('error');
          await sleep(2500);
          this.setState('idle');
          this.isProcessing = false;
          return;
        }

        // 4. macOS / Linux pas encore supportés
        if (this.osInfo.os !== 'windows') {
          this.showToast(`Version ${this.osInfo.label} bientôt disponible. Téléchargement Windows à la place.`, 'info');
          await sleep(800);
        }

        // 5. Determine URL
        let downloadUrl, filename;
        if (this.asset) {
          downloadUrl = this.asset.browser_download_url;
          filename = this.asset.name;
        } else {
          // Fallback URL (release peut ne pas être encore publiée)
          downloadUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${FALLBACK_VERSION}/KCl-Setup-${FALLBACK_VERSION}.exe`;
          filename = `KCl-Setup-${FALLBACK_VERSION}.exe`;
        }

        // 6. Show progress + start download with retry
        this.setState('downloading');
        this.showProgressBar();

        const result = await downloadWithRetry(downloadUrl, filename, (progress) => {
          if (progress.phase === 'retry') {
            this.setState('retry');
            this.showToast(`Tentative ${progress.attempt}/${MAX_RETRIES}...`, 'info');
          }
        });

        if (result.success) {
          this.setState('success');
          this.hideProgressBar();
          bumpLocalCounter();
          this.showToast('Téléchargement démarré !', 'success');
          await sleep(2500);
          this.setState('idle');
        } else {
          this.setState('error');
          this.hideProgressBar(0);
          this.showToast(result.error || 'Erreur de téléchargement', 'error');
          // Offrir téléchargement alternatif via lien direct
          this.showAlternativeLink();
          await sleep(4000);
          this.setState('idle');
        }
      } finally {
        this.isProcessing = false;
      }
    }

    showAlternativeLink() {
      const altSelector = this.options.alternativeSelector;
      if (altSelector) {
        const el = document.querySelector(altSelector);
        if (el) {
          el.style.display = 'inline-block';
          el.classList.add('kcl-pulse');
        }
      }
    }
  }

  // ============================================================
  // HELPERS
  // ============================================================

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ============================================================
  // INJECT STYLES (animations + states)
  // ============================================================

  function injectStyles() {
    if (document.getElementById('kcl-download-styles')) return;
    const style = document.createElement('style');
    style.id = 'kcl-download-styles';
    style.textContent = `
      @keyframes kcl-slide-in { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes kcl-slide-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(20px); opacity: 0; } }
      @keyframes kcl-pulse-glow { 0%,100% { box-shadow: 0 0 0 0 rgba(58,92,245,0.4); } 50% { box-shadow: 0 0 0 14px rgba(58,92,245,0); } }
      @keyframes kcl-spin { to { transform: rotate(360deg); } }
      .kcl-pulse { animation: kcl-pulse-glow 1.6s ease-in-out infinite; }
      [data-kcl-download].state-preparing,
      [data-kcl-download].state-downloading,
      [data-kcl-download].state-retry {
        cursor: progress !important;
      }
      [data-kcl-download].state-success {
        background: linear-gradient(135deg, #10b981, #059669) !important;
      }
      [data-kcl-download].state-error {
        background: linear-gradient(135deg, #ef4444, #dc2626) !important;
      }
      [data-kcl-download].state-retry {
        background: linear-gradient(135deg, #f59e0b, #d97706) !important;
      }
      [data-kcl-download].state-downloading::before {
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

  // ============================================================
  // PUBLIC API
  // ============================================================

  window.KClDownload = {
    init: function (options = {}) {
      injectStyles();
      const selector = options.selector || '[data-kcl-download]';
      const buttons = document.querySelectorAll(selector);
      const instances = [];
      buttons.forEach(btn => {
        const inst = new DownloadButton(btn, {
          metaSelector: options.metaSelector || btn.dataset.kclMeta,
          alternativeSelector: options.alternativeSelector || btn.dataset.kclAlternative
        });
        instances.push(inst);
      });
      return instances;
    },
    detectOS,
    getLocalCounter,
    fetchLatestRelease
  };

  // Auto-init si DOM prêt
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.KClDownload.init());
  } else {
    window.KClDownload.init();
  }
})();
