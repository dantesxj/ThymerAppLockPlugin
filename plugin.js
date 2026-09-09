// ==Plugin==
// @id: dawn-app-lock
// @name: App Lock
// @description: PIN lock overlay + status chip — idle timer; no vault I/O on nav
// @icon: ti-lock
// ==/Plugin==

/**
 * Dawn App Lock — standalone (not Tier2 blob).
 *
 * Deploy: cat plugin.js applock-engine.js
 * Hydrates prod Path B `app-lock` + LS `thymer_applock_*`. Old App Lock stays Off.
 * plugin.json custom.lockTimeout = idle seconds (default 120).
 */

class Plugin extends AppPlugin {
  onLoad() {
    this._unreg = null;
    this._appLock = null;
    try {
      this._appLock = new DawnAppLock(this);
      this._appLock.attach();
    } catch (e) {
      console.error('[Dawn/AppLock] engine missing — deploy concatenated bundle', e);
      return;
    }
    this._waitForBoot((boot) => {
      this._unreg = boot.register({
        id: 'dawn-app-lock',
        tier: 'idle',
        idleDelayMs: (isMobile) => (isMobile ? 8000 : 600),
      });
    });
  }

  onUnload() {
    try { this._appLock?.detach?.(); } catch (_) {}
    try { this._unreg?.(); } catch (_) {}
  }

  _waitForBoot(cb) {
    let n = 0;
    const tick = () => {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      if (boot?.register) { cb(boot); return; }
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 25);
    };
    tick();
  }
}
/**
 * Dawn App Lock — prod lock overlay + status chip.
 * Instantiated by Tier2. No vault I/O. Path B via host.
 *
 * Behaviour:
 *  - Fresh login: NO lock screen. Idle timer starts silently.
 *  - After 2 min idle: lock screen appears, requiring PIN.
 *  - Lock screen: enter PIN to unlock, OR sign out (back to Thymer login).
 *  - Forgot PIN: sign out → log back in → use "Change Lock PIN" in Command Palette.
 *  - Command Palette → "Lock App": manual lock at any time.
 *  - Command Palette → "Change Lock PIN": set/change PIN freely — no current PIN required.
 *  - Status bar lock icon: click = lock now; hold ≈0.5s = suspend/resume idle protection.
 *  - Command Palette → suspend/resume protection (same as hold toggle).
 *
 * PIN is stored as a SHA-256 hash in localStorage — never the PIN itself.
 *
 * Configuration (plugin.json → custom):
 *   lockTimeout: seconds of idle before auto-lock (default: 120)
 */

function alCopyProdLsIfEmpty() {
  const pairs = [
    ['dawn:applock_pin_hash_v1', 'thymer_applock_pin_hash_v1'],
    ['dawn:applock_state_v1', 'thymer_applock_state_v1'],
    ['dawn:applock_resume_gate_v1', 'thymer_applock_resume_gate_v1'],
    ['dawn:applock_suspended_v1', 'thymer_applock_suspended_v1'],
  ];
  for (const [dawnKey, prodKey] of pairs) {
    try {
      if (String(localStorage.getItem(dawnKey) || '').trim()) continue;
      const v = localStorage.getItem(prodKey);
      if (v == null || v === '') continue;
      localStorage.setItem(dawnKey, v);
    } catch (_) {}
  }
}

class DawnAppLock {
  constructor(app) {
    this.ui = app.ui;
    this.data = app.data;
    this.events = app.events;
    this._host = app;
    this._commands = [];
    this._overlayEl = null;
    this._idleTimer = null;
    this._activityBound = null;
    this._overlayFocusGuard = null;
    this._overlayFocusRedirecting = false;
    this._statusItem = null;
    this._statusBarPointerCleanup = null;
    this._STORAGE_KEY_HASH = 'dawn:applock_pin_hash_v1';
    this._STORAGE_KEY_STATE = 'dawn:applock_state_v1';
    this._STORAGE_KEY_RESUME_GATE = 'dawn:applock_resume_gate_v1';
    this._STORAGE_KEY_SUSPENDED = 'dawn:applock_suspended_v1';
  }

  getConfiguration() {
    try {
      return this._host.getConfiguration?.() || {};
    } catch (_) {
      return {};
    }
  }

  _pluginSettingsMirrorKeys() {
    return [
      this._STORAGE_KEY_HASH, this._STORAGE_KEY_STATE, this._STORAGE_KEY_RESUME_GATE, this._STORAGE_KEY_SUSPENDED,
      'thymer_applock_pin_hash_v1', 'thymer_applock_state_v1', 'thymer_applock_resume_gate_v1', 'thymer_applock_suspended_v1',
    ];
  }

  _pluginSettingsFlush() {
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this._host || this, () => this._pluginSettingsMirrorKeys());
  }

  async _appLockDeferredPathB() {
    try {
      alCopyProdLsIfEmpty();
      const api = globalThis.ThymerPluginSettings;
      if (!api?.init || (api.__pathBStub && !api.__dawnPathBHost)) return;
      await api.init({
        plugin: this._host || this,
        pluginId: 'app-lock',
        label: 'App Lock',
        data: this.data,
        ui: this.ui,
        mirrorKeys: () => this._pluginSettingsMirrorKeys(),
        awaitHydrate: false,
        onHydrated: () => alCopyProdLsIfEmpty(),
      });
      this._pluginSettingsPluginId = 'app-lock';
      this._pluginSettingsSyncMode = 'synced';
      if (this._host) {
        this._host._pluginSettingsPluginId = 'app-lock';
        this._host._pluginSettingsSyncMode = 'synced';
      }
      alCopyProdLsIfEmpty();
    } catch (e) {
      console.warn('[App Lock] Path B init', e);
    }
  }

  attach() {
    alCopyProdLsIfEmpty();
    void this._appLockDeferredPathB();
    const cfg = this.getConfiguration?.()?.custom || {};
    this._timeoutMs = Math.max(10, Number(cfg.lockTimeout) || 120) * 1000;
    this._signingOut = false;
    this._pageHideBound = null;

    this._injectStyles();

    // Command: Lock App (always visible)
    this._commands.push(
      this.ui.addCommandPaletteCommand({
        label: 'Lock App',
        icon: 'lock',
        onSelected: () => {
          if (!localStorage.getItem(this._STORAGE_KEY_HASH)) {
            this._showNoPinToast();
            return;
          }
          this.lock();
        },
      })
    );

    // Command: Change Lock PIN (silently ignored if currently locked)
    this._commands.push(
      this.ui.addCommandPaletteCommand({
        label: 'Change Lock PIN',
        icon: 'lock-cog',
        onSelected: () => {
          if (this._overlayEl) return; // locked — ignore silently
          this._showChangePinOverlay();
        },
      })
    );
    this._commands.push(
      this.ui.addCommandPaletteCommand({
        label: 'App Lock: Suspend protection',
        icon: 'lock-open',
        onSelected: () => {
          if (this._isSuspended()) {
            this.ui.addToaster({
              title: 'Already suspended',
              message: 'Idle lock and the status bar quick lock are off. Use “App Lock: Resume protection” or hold the lock icon.',
              dismissible: true,
              autoDestroyTime: 4000,
            });
            return;
          }
          this._setSuspended(true);
          this.ui.addToaster({
            title: 'App Lock suspended',
            message: 'Hold the status bar lock icon or use the command palette to resume.',
            dismissible: true,
            autoDestroyTime: 4000,
          });
        },
      })
    );

    this._commands.push(
      this.ui.addCommandPaletteCommand({
        label: 'App Lock: Resume protection',
        icon: 'lock',
        onSelected: () => {
          if (!this._isSuspended()) {
            this.ui.addToaster({
              title: 'Already active',
              message: 'Protection is on. Use “App Lock: Suspend protection” or hold the lock icon to pause.',
              dismissible: true,
              autoDestroyTime: 3500,
            });
            return;
          }
          this._setSuspended(false);
          this.ui.addToaster({
            title: 'App Lock resumed',
            message: 'Idle timer and status bar lock are active again.',
            dismissible: true,
            autoDestroyTime: 3000,
          });
        },
      })
    );

    // Activity events to reset idle timer
    this._activityBound = () => this._onActivity();
    const evts = ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'];
    for (const ev of evts) {
      document.addEventListener(ev, this._activityBound, { passive: true, capture: true });
    }

    // Next cold open / reload with PIN: require unlock (desktop restore, etc.)
    this._pageHideBound = () => this._onPageHideResumeGate();
    window.addEventListener('pagehide', this._pageHideBound);

    // Determine initial state
    const hasPin     = !!localStorage.getItem(this._STORAGE_KEY_HASH);
    const wasLocked  = localStorage.getItem(this._STORAGE_KEY_STATE) === 'locked';
    const resumeGate = localStorage.getItem(this._STORAGE_KEY_RESUME_GATE) === '1';

    if (resumeGate && hasPin) {
      try { localStorage.removeItem(this._STORAGE_KEY_RESUME_GATE); } catch (e) { /* ignore */ }
    }

    if (hasPin && (wasLocked || resumeGate) && !this._isSuspended()) {
      this._showLockOverlay();
    } else {
      try { localStorage.removeItem(this._STORAGE_KEY_RESUME_GATE); } catch (e) { /* ignore */ }
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
      this._pluginSettingsFlush();
      this._resetIdleTimer();
    }

    setTimeout(() => this._mountStatusBar(), 0);
  }

  detach() {
    try { this._statusBarPointerCleanup?.(); } catch (_) {}
    this._statusBarPointerCleanup = null;
    try { this._statusItem?.remove?.(); } catch (_) {}
    this._statusItem = null;
    this._clearIdleTimer();
    this._removeOverlay();
    if (this._pageHideBound) {
      try { window.removeEventListener('pagehide', this._pageHideBound); } catch (e) { /* ignore */ }
      this._pageHideBound = null;
    }
    for (const cmd of this._commands) {
      try { cmd?.remove?.(); } catch (e) { /* ignore */ }
    }
    this._commands = [];
    if (this._activityBound) {
      const evts = ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'];
      for (const ev of evts) {
        document.removeEventListener(ev, this._activityBound, { capture: true });
      }
      this._activityBound = null;
    }
  }

  _onPageHideResumeGate() {
    if (this._signingOut) return;
    if (this._isSuspended()) return;
    try {
      if (!localStorage.getItem(this._STORAGE_KEY_HASH)) return;
      if (this._overlayEl) return;
      localStorage.setItem(this._STORAGE_KEY_RESUME_GATE, '1');
      this._pluginSettingsFlush();
    } catch (e) { /* ignore */ }
  }

  _isSuspended() {
    try {
      return localStorage.getItem(this._STORAGE_KEY_SUSPENDED) === '1';
    } catch (_) {
      return false;
    }
  }

  _setSuspended(on) {
    try {
      if (on) localStorage.setItem(this._STORAGE_KEY_SUSPENDED, '1');
      else localStorage.removeItem(this._STORAGE_KEY_SUSPENDED);
    } catch (_) {}
    if (on) this._clearIdleTimer();
    else this._resetIdleTimer();
    this._pluginSettingsFlush();
    this._syncStatusBarAppearance();
  }

  _toggleSuspended() {
    const next = !this._isSuspended();
    this._setSuspended(next);
    this.ui.addToaster({
      title: next ? 'App Lock suspended' : 'App Lock resumed',
      message: next
        ? 'Hold the icon again to resume. Idle lock is off.'
        : 'Idle timer and quick lock are on.',
      dismissible: true,
      autoDestroyTime: 3200,
    });
  }

  /**
   * Compact inline SVG inside a fixed 18×18 box — matches Tabler status icons better than a raw 18px SVG
   * (avoids looking oversized). Prefer `htmlLabel` over `ti-lock`/`ti-lock-off`: Thymer’s Tabler subset may omit
   * `ti-lock-off`, which made the suspended state look “empty.”
   */
  _statusBarActiveHtml() {
    const inner =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
      '<rect x="3" y="11" width="18" height="11" rx="2.5"/>' +
      '</svg>';
    return (
      '<span class="tal-sb-lock tal-sb-lock--active" style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;line-height:0;vertical-align:middle" aria-hidden="true">' +
      inner +
      '</span>'
    );
  }

  _statusBarSuspendedHtml() {
    const inner =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
      '<rect x="3" y="11" width="18" height="11" rx="2.5"/>' +
      '<path d="M4 4l16 16" stroke-width="2"/>' +
      '</svg>';
    return (
      '<span class="tal-sb-lock tal-sb-lock--suspended" style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;line-height:0;vertical-align:middle" aria-hidden="true">' +
      inner +
      '</span>'
    );
  }

  _syncStatusBarAppearance() {
    if (!this._statusItem) return;
    try {
      if (this._isSuspended()) {
        this._statusItem.setHtmlLabel?.(this._statusBarSuspendedHtml());
        this._statusItem.setTooltip?.('App Lock suspended — hold to resume; click does not lock');
      } else {
        this._statusItem.setHtmlLabel?.(this._statusBarActiveHtml());
        this._statusItem.setTooltip?.('App Lock — click to lock; hold to suspend idle lock');
      }
    } catch (_) {}
  }

  /** Move item toward the end of the status strip (best-effort; some hosts use nested wrappers). */
  _moveStatusBarItemToEnd() {
    try {
      const el = this._statusItem?.getElement?.();
      const p = el?.parentNode;
      if (el && p && p.lastElementChild !== el) p.appendChild(el);
    } catch (_) {}
  }

  /**
   * SDK: `this.ui.addStatusBarItem` (see thymer-plugin-sdk types.d.ts).
   * Long-press uses pointer events on `getElement()` because `onClick` is click-only.
   */
  _mountStatusBar() {
    if (typeof this.ui.addStatusBarItem !== 'function') return;
    try {
      this._statusItem = this.ui.addStatusBarItem({
        htmlLabel: this._isSuspended() ? this._statusBarSuspendedHtml() : this._statusBarActiveHtml(),
        tooltip: 'App Lock — click to lock; hold to suspend idle lock',
      });
    } catch (_) {
      return;
    }
    this._syncStatusBarAppearance();
    this._moveStatusBarItemToEnd();
    const el = this._statusItem?.getElement?.();
    if (!el || typeof el.addEventListener !== 'function') return;

    const HOLD_MS = 780;
    let holdTimer = null;
    let longPressHandled = false;

    const onPointerDown = () => {
      longPressHandled = false;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        longPressHandled = true;
        this._toggleSuspended();
      }, HOLD_MS);
    };

    const clearHoldTimer = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    const onPointerUp = () => {
      clearHoldTimer();
      if (longPressHandled) {
        longPressHandled = false;
        return;
      }
      if (this._isSuspended()) {
        this.ui.addToaster({
          title: 'App Lock suspended',
          message: 'Hold the lock icon to resume protection.',
          dismissible: true,
          autoDestroyTime: 3500,
        });
        return;
      }
      if (!localStorage.getItem(this._STORAGE_KEY_HASH)) {
        this._showNoPinToast();
        return;
      }
      this.lock();
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', clearHoldTimer);

    // One delayed nudge so late-loading plugins don’t permanently sit to our right; avoid repeated moves on sync.
    setTimeout(() => this._moveStatusBarItemToEnd(), 600);

    this._statusBarPointerCleanup = () => {
      clearHoldTimer();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', clearHoldTimer);
    };
  }

  // ─── Public ───────────────────────────────────────────────────────────────

  lock() {
    this._clearIdleTimer();
    localStorage.setItem(this._STORAGE_KEY_STATE, 'locked');
    this._pluginSettingsFlush();
    this._showLockOverlay();
  }

  // ─── Idle timer ───────────────────────────────────────────────────────────

  _onActivity() {
    if (this._overlayEl) return;
    if (this._isSuspended()) return;
    this._resetIdleTimer();
  }

  _resetIdleTimer() {
    this._clearIdleTimer();
    if (this._isSuspended()) return;
    if (!localStorage.getItem(this._STORAGE_KEY_HASH)) return;
    this._idleTimer = setTimeout(() => this.lock(), this._timeoutMs);
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  // ─── Overlay helpers ──────────────────────────────────────────────────────

  _removeOverlay() {
    this._detachOverlayFocusGuard();
    this._overlayEl?.remove();
    this._overlayEl = null;
  }

  _detachOverlayFocusGuard() {
    if (this._overlayFocusGuard) {
      try { document.removeEventListener('focusin', this._overlayFocusGuard, true); } catch (_) {}
      this._overlayFocusGuard = null;
    }
  }

  /** Keep focus inside the lock / change-PIN overlay so host panels do not steal keystrokes. */
  _attachOverlayFocusGuard(overlay) {
    this._detachOverlayFocusGuard();
    this._overlayFocusGuard = (e) => {
      if (!this._overlayEl || this._overlayEl !== overlay) return;
      if (this._overlayFocusRedirecting) return;
      const t = e.target;
      if (!t || overlay.contains(t)) return;
      const prefer =
        overlay.querySelector('#tal-pin-input') ||
        overlay.querySelector('#tal-pin-new') ||
        overlay.querySelector('input:not([disabled]), button:not([disabled])');
      if (prefer && typeof prefer.focus === 'function') {
        if (prefer === document.activeElement) return;
        this._overlayFocusRedirecting = true;
        try { prefer.focus({ preventScroll: true }); } catch (_) { try { prefer.focus(); } catch (_) {} }
        setTimeout(() => { this._overlayFocusRedirecting = false; }, 0);
      }
    };
    document.addEventListener('focusin', this._overlayFocusGuard, true);
  }

  _buildBaseOverlay() {
    const el = document.createElement('div');
    el.className = 'tal-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'App Lock');
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    return el;
  }

  _trapFocusIn(container) {
    const sel = 'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const els = Array.from(container.querySelectorAll(sel))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
  }

  _showMsg(el, text, type) {
    el.textContent = text;
    el.className = `tal-msg tal-msg--${type}`;
  }

  _showNoPinToast() {
    this.ui.addToaster({
      title: 'No PIN set',
      message: 'Use Command Palette → "Change Lock PIN" to set a PIN first.',
      dismissible: true,
      autoDestroyTime: 4000,
    });
  }

  /** Delete every IndexedDB the browser reports (Thymer session lives here; fixed names are not enough). */
  async _deleteAllIndexedDatabases() {
    const names = new Set(['thymer', 'db', 'app', 'cache', 'auth', 'session']);
    try {
      if (typeof indexedDB.databases === 'function') {
        const list = await indexedDB.databases();
        for (const d of list || []) {
          if (d && d.name) names.add(d.name);
        }
      }
    } catch (e) {
      console.warn('[AppLock] indexedDB.databases:', e);
    }
    await Promise.all(
      [...names].map(
        (name) =>
          new Promise((resolve) => {
            try {
              const r = indexedDB.deleteDatabase(name);
              r.onsuccess = r.onblocked = r.onerror = () => resolve();
            } catch (_) {
              resolve();
            }
          })
      )
    );
  }

  // ─── Sign out ─────────────────────────────────────────────────────────────
  //
  // How Thymer's auth works (confirmed from console):
  //  - A Service Worker is registered at scope https://darienx.thymer.com/
  //  - The SW caches the app shell and intercepts all navigation
  //  - There is no /logout URL (404s)
  //  - The root URL / shows the Login screen when there is no valid session
  //
  // Strategy:
  //  1. Unregister all Service Workers — breaks the cache intercept
  //  2. Clear all SW caches — forces a true network fetch on reload
  //  3. Clear all IndexedDB databases — removes any cached auth/session data
  //  4. Clear all localStorage EXCEPT our PIN hash (so PIN survives)
  //  5. Clear sessionStorage
  //  6. Expire all cookies
  //  7. Navigate to the root URL with cache-busting — Thymer finds no
  //     session and renders the Login screen

  async _signOut() {
    this._signingOut = true;
    // Keep PIN hash but mark as unlocked (fresh login won't trigger lock)
    const pinHash = localStorage.getItem(this._STORAGE_KEY_HASH);
    localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
    try { localStorage.removeItem(this._STORAGE_KEY_RESUME_GATE); } catch (e) { /* ignore */ }

    // 1. Unregister all Service Workers
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {
      console.warn('[AppLock] SW unregister:', e);
    }

    // 2. Wipe all SW caches
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
    } catch (e) {
      console.warn('[AppLock] Cache clear:', e);
    }

    // 3. Clear IndexedDB — enumerate real DB names (Thymer dev pattern); fallback to common names
    try {
      await this._deleteAllIndexedDatabases();
    } catch (e) {
      console.warn('[AppLock] IndexedDB clear:', e);
    }

    // 4. Clear ALL localStorage, then restore PIN hash + Path B mode keys (other plugins)
    const pathBModes = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('thymerext_ps_mode_')) pathBModes[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    try {
      localStorage.clear();
      if (pinHash) localStorage.setItem(this._STORAGE_KEY_HASH, pinHash);
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
      for (const k of Object.keys(pathBModes)) {
        const v = pathBModes[k];
        if (v != null) try { localStorage.setItem(k, v); } catch (_) {}
      }
    } catch (e) { /* ignore */ }

    // 5. Clear sessionStorage
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }

    // 6. Expire all cookies
    try {
      document.cookie.split(';').forEach((c) => {
        const name = c.split('=')[0].trim();
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${location.hostname}`;
      });
    } catch (e) { /* ignore */ }

    // 7. Navigate to root with a cache-busting query string.
    //    With the SW gone and caches empty, Thymer fetches fresh from the
    //    network, finds no session, and shows the Login screen.
    //    The ?_signout param is ignored by Thymer but prevents any
    //    browser cache from serving a stale response.
    window.location.replace(`${location.origin}/?_signout=${Date.now()}`);
  }

  // ─── Lock overlay ─────────────────────────────────────────────────────────

  _showLockOverlay() {
    this._removeOverlay();
    const overlay = this._buildBaseOverlay();

    overlay.innerHTML = `
      <div class="tal-card">
        <div class="tal-brand">
          <div class="tal-lock-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2.5"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              <circle cx="12" cy="16.5" r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </div>
          <h1 class="tal-title">Thymer is locked</h1>
          <p class="tal-subtitle">Enter your PIN to continue.</p>
        </div>

        <div class="tal-field-group">
          <input
            id="tal-pin-input"
            class="tal-input tal-input--pin"
            type="password"
            inputmode="numeric"
            maxlength="8"
            placeholder="• • • •"
            autocomplete="current-password"
          />
        </div>

        <div id="tal-msg" class="tal-msg" role="alert" aria-live="assertive"></div>

        <button id="tal-btn-unlock" class="tal-btn tal-btn--primary">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
            <rect x="3" y="11" width="18" height="11" rx="2"/>
          </svg>
          <span>Unlock</span>
        </button>

        <div class="tal-divider"><span>or</span></div>

        <button id="tal-btn-signout" class="tal-btn tal-btn--ghost-outline">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span>Sign out</span>
        </button>

        <p class="tal-hint">
          Forgot your PIN? Sign out and log back in —<br>
          no PIN is required on a fresh login.<br>
          Then use <strong>Command Palette → Change Lock PIN</strong>.
        </p>
      </div>
    `;

    document.body.appendChild(overlay);
    this._overlayEl = overlay;

    const input      = overlay.querySelector('#tal-pin-input');
    const msg        = overlay.querySelector('#tal-msg');
    const btnUnlock  = overlay.querySelector('#tal-btn-unlock');
    const btnSignOut = overlay.querySelector('#tal-btn-signout');
    let shakeTimer   = null;
    let attempts     = 0;

    input.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '');
      msg.textContent = '';
      msg.className = 'tal-msg';
    });

    const tryUnlock = async () => {
      const pin = input.value.trim();
      if (!pin) { input.focus(); return; }

      const storedHash = localStorage.getItem(this._STORAGE_KEY_HASH);
      if (!storedHash) {
        this._removeOverlay();
        this._resetIdleTimer();
        return;
      }

      const hash = await this._hashPin(pin);
      if (hash === storedHash) {
        overlay.classList.add('tal-overlay--unlocking');
        localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
        this._pluginSettingsFlush();
        setTimeout(() => {
          this._removeOverlay();
          this._resetIdleTimer();
        }, 350);
      } else {
        attempts++;
        input.value = '';
        this._showMsg(
          msg,
          attempts >= 3 ? `Incorrect PIN (${attempts} attempts).` : 'Incorrect PIN. Try again.',
          'error'
        );
        const card = overlay.querySelector('.tal-card');
        if (shakeTimer) clearTimeout(shakeTimer);
        card.classList.remove('tal-shake');
        void card.offsetWidth;
        card.classList.add('tal-shake');
        shakeTimer = setTimeout(() => card.classList.remove('tal-shake'), 600);
        input.focus();
      }
    };

    btnUnlock.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

    btnSignOut.addEventListener('click', async () => {
      btnSignOut.disabled = true;
      btnSignOut.querySelector('span').textContent = 'Signing out…';
      await this._signOut();
    });

    this._trapFocusIn(overlay);
    this._attachOverlayFocusGuard(overlay);
    setTimeout(() => input.focus(), 80);
  }

  // ─── Change PIN overlay ───────────────────────────────────────────────────

  _showChangePinOverlay() {
    this._removeOverlay();
    const overlay = this._buildBaseOverlay();
    const isUpdate = !!localStorage.getItem(this._STORAGE_KEY_HASH);

    overlay.innerHTML = `
      <div class="tal-card tal-card--setup">
        <div class="tal-brand">
          <div class="tal-lock-icon tal-lock-icon--neutral">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
              <rect x="3" y="11" width="18" height="11" rx="2.5"/>
              <circle cx="12" cy="16.5" r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </div>
          <h1 class="tal-title">${isUpdate ? 'Change PIN' : 'Set Lock PIN'}</h1>
          <p class="tal-subtitle">
            ${isUpdate
              ? 'Choose a new PIN. No current PIN required.'
              : 'Choose a 4–8 digit PIN. The app will lock after inactivity.'}
          </p>
        </div>

        <div class="tal-field-group">
          <label class="tal-label">New PIN</label>
          <input id="tal-pin-new" class="tal-input" type="password"
            inputmode="numeric" maxlength="8" placeholder="• • • •"
            autocomplete="new-password" />
        </div>

        <div class="tal-field-group">
          <label class="tal-label">Confirm New PIN</label>
          <input id="tal-pin-confirm" class="tal-input" type="password"
            inputmode="numeric" maxlength="8" placeholder="• • • •"
            autocomplete="new-password" />
        </div>

        <div id="tal-msg" class="tal-msg" role="alert"></div>

        <div class="tal-btn-row">
          <button id="tal-btn-cancel" class="tal-btn tal-btn--secondary">Cancel</button>
          <button id="tal-btn-save" class="tal-btn tal-btn--primary">
            <span>${isUpdate ? 'Update PIN' : 'Set PIN'}</span>
          </button>
        </div>

        <p class="tal-hint">
          Forgot your PIN? Sign out and log back in —<br>no PIN is required on a fresh login.
        </p>
      </div>
    `;

    document.body.appendChild(overlay);
    this._overlayEl = overlay;

    const pinNew     = overlay.querySelector('#tal-pin-new');
    const pinConfirm = overlay.querySelector('#tal-pin-confirm');
    const msg        = overlay.querySelector('#tal-msg');
    const btnSave    = overlay.querySelector('#tal-btn-save');
    const btnCancel  = overlay.querySelector('#tal-btn-cancel');

    const numOnly = (e) => { e.target.value = e.target.value.replace(/\D/g, ''); };
    [pinNew, pinConfirm].forEach((el) => el.addEventListener('input', numOnly));

    const submit = async () => {
      msg.textContent = '';
      msg.className = 'tal-msg';

      const p1 = pinNew.value.trim();
      const p2 = pinConfirm.value.trim();

      if (p1.length < 4) {
        this._showMsg(msg, 'PIN must be at least 4 digits.', 'error');
        pinNew.focus();
        return;
      }
      if (p1 !== p2) {
        this._showMsg(msg, 'PINs do not match.', 'error');
        pinConfirm.value = '';
        pinConfirm.focus();
        return;
      }

      btnSave.disabled = true;
      const hash = await this._hashPin(p1);
      localStorage.setItem(this._STORAGE_KEY_HASH, hash);
      try { localStorage.setItem('thymer_applock_pin_hash_v1', hash); } catch (_) {}
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
      this._pluginSettingsFlush();

      this._showMsg(msg, 'PIN saved!', 'ok');
      setTimeout(() => {
        this._removeOverlay();
        this._resetIdleTimer();
      }, 700);
    };

    btnSave.addEventListener('click', submit);
    btnCancel.addEventListener('click', () => {
      this._removeOverlay();
      this._resetIdleTimer();
    });
    [pinNew, pinConfirm].forEach((inp) =>
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); })
    );

    this._trapFocusIn(overlay);
    this._attachOverlayFocusGuard(overlay);
    setTimeout(() => pinNew.focus(), 80);
  }

  // ─── PIN hashing ──────────────────────────────────────────────────────────

  async _hashPin(pin) {
    const data    = new TextEncoder().encode('thymer-applock-v1:' + pin);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ─── Styles ───────────────────────────────────────────────────────────────

  _injectStyles() {
    this.ui.injectCSS(`
      .tal-overlay {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: clamp(12px, 3vw, 24px);
        box-sizing: border-box;
        /* Theme-tinted scrim + light blur (pre Theme-Thyme / cmdpal experiments). */
        background-color: color-mix(in srgb, var(--color-bg-950, #0d1117) 28%, transparent);
        backdrop-filter: blur(18px) saturate(1.15);
        -webkit-backdrop-filter: blur(18px) saturate(1.15);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text-100, #fff) 6%, transparent);
        background-image:
          radial-gradient(
            ellipse 90% 60% at 50% 0%,
            color-mix(in srgb, var(--color-primary-500, var(--color-primary-400, #cba6f7)) 14%, transparent) 0%,
            transparent 62%
          ),
          url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
        animation: tal-fadein 0.25s ease both;
        user-select: none;
        -webkit-app-region: no-drag;
      }

      @supports not (background-color: color-mix(in srgb, black 50%, white)) {
        .tal-overlay {
          background-color: rgba(13, 17, 23, 0.26);
        }
      }

      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .tal-overlay {
          background-color: var(--color-bg-950, #0d1117);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          box-shadow: none;
        }
      }

      @keyframes tal-fadein {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      .tal-overlay--unlocking {
        animation: tal-fadeout 0.35s ease forwards;
      }

      @keyframes tal-fadeout {
        from { opacity: 1; transform: scale(1); }
        to   { opacity: 0; transform: scale(1.015); }
      }

      .tal-card {
        width: 100%;
        max-width: min(380px, calc(100vw - 24px));
        padding: clamp(24px, 5vh, 40px) clamp(20px, 4vw, 36px) clamp(20px, 4vw, 32px);
        border-radius: 14px;
        box-sizing: border-box;
        font-family: var(--font-sans, system-ui);
        color: var(--color-text-100, #ffffff);
        background: var(--color-bg-800, #181825);
        border: 1px solid color-mix(in srgb, var(--color-text-100, #fff) 10%, transparent);
        box-shadow:
          0 0 0 1px color-mix(in srgb, var(--color-text-100, #fff) 4%, transparent) inset,
          0 32px 80px color-mix(in srgb, var(--color-bg-950, #000) 55%, transparent),
          0 8px 24px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: clamp(12px, 2vh, 16px);
        animation: tal-slidein 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
      }

      .tal-card--setup { max-width: min(400px, calc(100vw - 24px)); }

      @keyframes tal-slidein {
        from { opacity: 0; transform: translateY(24px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }

      .tal-shake {
        animation: tal-shake 0.5s cubic-bezier(0.36, 0.07, 0.19, 0.97) both !important;
      }

      @keyframes tal-shake {
        0%, 100% { transform: translateX(0); }
        15%  { transform: translateX(-8px) rotate(-0.5deg); }
        30%  { transform: translateX(7px) rotate(0.5deg); }
        45%  { transform: translateX(-5px); }
        60%  { transform: translateX(5px); }
        75%  { transform: translateX(-3px); }
        90%  { transform: translateX(3px); }
      }

      .tal-brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        margin-bottom: 4px;
        text-align: center;
      }

      .tal-lock-icon {
        width: 52px;
        height: 52px;
        border-radius: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        margin-bottom: 4px;
        background: linear-gradient(
          135deg,
          var(--color-primary-600, #9d71e8) 0%,
          var(--color-primary-400, #cba6f7) 100%
        );
        box-shadow: 0 8px 24px color-mix(in srgb, var(--color-primary-400, #cba6f7) 35%, transparent);
      }

      .tal-lock-icon svg { width: 26px; height: 26px; }

      .tal-lock-icon--neutral {
        background: linear-gradient(
          135deg,
          var(--color-bg-500, #45475a) 0%,
          var(--color-bg-300, #6c7086) 100%
        );
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        color: var(--color-text-100, #fff);
      }

      .tal-title {
        font-family: var(--font-serif, var(--font-sans, system-ui));
        font-size: clamp(18px, 2.8vw, 20px);
        font-weight: 700;
        color: var(--color-text-100, #ffffff);
        margin: 0;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }

      .tal-subtitle {
        font-size: 13px;
        color: var(--color-text-500, #a6adc8);
        margin: 0;
        line-height: 1.5;
      }

      .tal-field-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .tal-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-text-500, #a6adc8);
      }

      .tal-input {
        width: 100%;
        box-sizing: border-box;
        height: 48px;
        padding: 0 16px;
        border-radius: 8px;
        border: 1.5px solid var(--color-bg-400, #585b70);
        background: var(--color-bg-900, #11111b);
        color: var(--color-text-100, #ffffff);
        font-size: 18px;
        font-family: 'Courier New', monospace;
        letter-spacing: 0.2em;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
        caret-color: var(--color-primary-400, #cba6f7);
      }

      .tal-input::placeholder {
        color: var(--color-bg-300, rgba(255, 255, 255, 0.2));
        letter-spacing: 0.15em;
      }

      .tal-input:focus {
        border-color: var(--color-primary-400, #cba6f7);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary-400, #cba6f7) 22%, transparent);
      }

      .tal-input--pin {
        text-align: center;
        font-size: 22px;
        letter-spacing: 0.3em;
        padding: 0 20px;
      }

      .tal-msg {
        min-height: 18px;
        font-size: 12px;
        text-align: center;
        color: transparent;
        transition: color 0.15s;
        line-height: 1.4;
        margin-top: -2px;
      }

      .tal-msg--error { color: var(--text-error, #f38ba8); }
      .tal-msg--ok    { color: var(--text-ok, #a6e3a1); }

      .tal-btn {
        width: 100%;
        height: 48px;
        border-radius: 10px;
        border: none;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.01em;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
        outline: none;
        box-sizing: border-box;
      }

      .tal-btn:focus-visible {
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary-400, #cba6f7) 45%, transparent);
      }
      .tal-btn:disabled { opacity: 0.5; cursor: default; }

      .tal-btn--primary {
        background: linear-gradient(
          135deg,
          var(--color-primary-600, #9d71e8) 0%,
          var(--color-primary-400, #cba6f7) 100%
        );
        color: var(--color-bg-900, #11111b);
        box-shadow: 0 4px 16px color-mix(in srgb, var(--color-primary-400, #cba6f7) 30%, transparent);
      }

      .tal-btn--primary:hover:not(:disabled) {
        opacity: 0.92;
        transform: translateY(-1px);
        box-shadow: 0 6px 20px color-mix(in srgb, var(--color-primary-400, #cba6f7) 40%, transparent);
      }

      .tal-btn--primary:active:not(:disabled) { transform: translateY(0); }

      .tal-btn--ghost-outline {
        background: transparent;
        color: var(--color-text-500, #a6adc8);
        border: 1.5px solid var(--color-bg-400, #585b70);
      }

      .tal-btn--ghost-outline:hover:not(:disabled) {
        background: var(--color-bg-600, #313244);
        border-color: var(--color-bg-300, #6c7086);
        color: var(--color-text-100, #ffffff);
      }

      .tal-btn--secondary {
        background: var(--color-bg-600, #313244);
        color: var(--color-text-500, #a6adc8);
        border: 1.5px solid var(--color-bg-400, #585b70);
      }

      .tal-btn--secondary:hover:not(:disabled) {
        background: var(--color-bg-500, #45475a);
        color: var(--color-text-100, #ffffff);
      }

      .tal-btn-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }

      .tal-divider {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--color-bg-300, #6c7086);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin: 2px 0;
      }

      .tal-divider::before,
      .tal-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--color-bg-400, #585b70);
      }

      .tal-hint {
        font-size: 11.5px;
        color: var(--color-bg-300, #6c7086);
        text-align: center;
        line-height: 1.6;
        margin: 0;
      }

      .tal-hint strong {
        color: var(--color-text-500, #a6adc8);
        font-weight: 600;
      }

      @media (max-height: 600px) {
        .tal-card { padding: clamp(18px, 4vh, 28px) clamp(18px, 3vw, 28px); gap: 12px; }
        .tal-lock-icon { width: 44px; height: 44px; border-radius: 12px; }
        .tal-lock-icon svg { width: 22px; height: 22px; }
        .tal-title { font-size: clamp(16px, 2.5vw, 18px); }
      }

      @media (max-width: 440px) {
        .tal-card {
          padding: clamp(20px, 5vw, 28px) clamp(18px, 4vw, 24px);
          border-radius: 12px;
        }
      }
    `);
  }
}
