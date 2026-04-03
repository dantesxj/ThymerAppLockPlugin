/**
 * App Lock Plugin for Thymer
 *
 * Behaviour:
 *  - Fresh login: NO lock screen. Idle timer starts silently.
 *  - After 2 min idle: lock screen appears, requiring PIN.
 *  - Lock screen: enter PIN to unlock, OR sign out (back to Thymer login).
 *  - Forgot PIN: sign out → log back in → use "Change Lock PIN" in Command Palette.
 *  - Command Palette → "Lock App": manual lock at any time.
 *  - Command Palette → "Change Lock PIN": set/change PIN freely — no current PIN required.
 *
 * PIN is stored as a SHA-256 hash in localStorage — never the PIN itself.
 *
 * Configuration (plugin.json → custom):
 *   lockTimeout: seconds of idle before auto-lock (default: 120)
 */

class Plugin extends AppPlugin {
  // Class-level properties so onUnload is always safe, even before onLoad runs
  _commands      = [];
  _overlayEl     = null;
  _idleTimer     = null;
  _activityBound = null;

  _STORAGE_KEY_HASH  = 'thymer_applock_pin_hash_v1';
  _STORAGE_KEY_STATE = 'thymer_applock_state_v1';

  onLoad() {
    const cfg = this.getConfiguration?.()?.custom || {};
    this._timeoutMs = Math.max(10, Number(cfg.lockTimeout) || 120) * 1000;

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

    // Activity events to reset idle timer
    this._activityBound = () => this._onActivity();
    const evts = ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'];
    for (const ev of evts) {
      document.addEventListener(ev, this._activityBound, { passive: true, capture: true });
    }

    // Determine initial state
    const hasPin    = !!localStorage.getItem(this._STORAGE_KEY_HASH);
    const wasLocked = localStorage.getItem(this._STORAGE_KEY_STATE) === 'locked';

    if (wasLocked && hasPin) {
      this._showLockOverlay();
    } else {
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
      this._resetIdleTimer();
    }
  }

  onUnload() {
    this._clearIdleTimer();
    this._removeOverlay();
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

  // ─── Public ───────────────────────────────────────────────────────────────

  lock() {
    this._clearIdleTimer();
    localStorage.setItem(this._STORAGE_KEY_STATE, 'locked');
    this._showLockOverlay();
  }

  // ─── Idle timer ───────────────────────────────────────────────────────────

  _onActivity() {
    if (this._overlayEl) return;
    this._resetIdleTimer();
  }

  _resetIdleTimer() {
    this._clearIdleTimer();
    if (!localStorage.getItem(this._STORAGE_KEY_HASH)) return;
    this._idleTimer = setTimeout(() => this.lock(), this._timeoutMs);
  }

  _clearIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  // ─── Overlay helpers ──────────────────────────────────────────────────────

  _removeOverlay() {
    this._overlayEl?.remove();
    this._overlayEl = null;
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
  //  3. Clear all localStorage EXCEPT our PIN hash (so PIN survives)
  //  4. Clear sessionStorage
  //  5. Expire all cookies
  //  6. Navigate to the root URL with cache-busting — Thymer finds no
  //     session and renders the Login screen

  async _signOut() {
    // Keep PIN hash but mark as unlocked (fresh login won't trigger lock)
    const pinHash = localStorage.getItem(this._STORAGE_KEY_HASH);
    localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');

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

    // 3. Clear ALL localStorage, then restore just our PIN hash
    try {
      localStorage.clear();
      if (pinHash) localStorage.setItem(this._STORAGE_KEY_HASH, pinHash);
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
    } catch (e) { /* ignore */ }

    // 4. Clear sessionStorage
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }

    // 5. Expire all cookies
    try {
      document.cookie.split(';').forEach((c) => {
        const name = c.split('=')[0].trim();
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${location.hostname}`;
      });
    } catch (e) { /* ignore */ }

    // 6. Navigate to root with a cache-busting query string.
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
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');

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
        padding: 20px;
        box-sizing: border-box;
        background: var(--color-bg-950, #0d1117);
        background-image:
          radial-gradient(ellipse 80% 60% at 50% 0%, rgba(255,255,255,0.03) 0%, transparent 70%),
          url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
        animation: tal-fadein 0.25s ease both;
        user-select: none;
        -webkit-app-region: no-drag;
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
        max-width: 380px;
        padding: 40px 36px 32px;
        border-radius: 14px;
        box-sizing: border-box;
        background: var(--color-bg-800, #181825);
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow:
          0 0 0 1px rgba(255,255,255,0.04) inset,
          0 32px 80px rgba(0,0,0,0.6),
          0 8px 24px rgba(0,0,0,0.4);
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 16px;
        animation: tal-slidein 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
      }

      .tal-card--setup { max-width: 400px; }

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
        background: linear-gradient(135deg, var(--color-primary-600, #9d71e8) 0%, var(--color-primary-400, #cba6f7) 100%);
        box-shadow: 0 8px 24px rgba(203,166,247,0.35);
      }

      .tal-lock-icon svg { width: 26px; height: 26px; }

      .tal-lock-icon--neutral {
        background: linear-gradient(135deg, var(--color-bg-500, #45475a) 0%, var(--color-bg-300, #6c7086) 100%);
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      }

      .tal-title {
        font-family: var(--font-serif, var(--font-sans, system-ui));
        font-size: 20px;
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
        color: var(--color-bg-300, rgba(255,255,255,0.2));
        letter-spacing: 0.15em;
      }

      .tal-input:focus {
        border-color: var(--color-primary-400, #cba6f7);
        box-shadow: 0 0 0 3px rgba(203,166,247,0.2);
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

      .tal-btn:focus-visible { box-shadow: 0 0 0 3px rgba(203,166,247,0.4); }
      .tal-btn:disabled { opacity: 0.5; cursor: default; }

      .tal-btn--primary {
        background: linear-gradient(135deg, var(--color-primary-600, #9d71e8) 0%, var(--color-primary-400, #cba6f7) 100%);
        color: var(--color-bg-900, #11111b);
        box-shadow: 0 4px 16px rgba(203,166,247,0.3);
      }

      .tal-btn--primary:hover:not(:disabled) {
        opacity: 0.9;
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(203,166,247,0.4);
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
        .tal-card { padding: 26px 28px 22px; gap: 12px; }
        .tal-lock-icon { width: 42px; height: 42px; }
        .tal-title { font-size: 17px; }
      }

      @media (max-width: 440px) {
        .tal-card { padding: 32px 24px 24px; border-radius: 12px; }
      }
    `);
  }
}
