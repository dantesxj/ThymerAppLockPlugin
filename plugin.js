// @generated BEGIN thymer-plugin-settings (source: plugins/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace “Plugin Settings” collection + optional localStorage mirror
 * for global plugins that do not own a collection.
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Settings';
  const q = [];
  let busy = false;

  /** Serialized ensures so concurrent plugin loads do not double-create the collection. */
  let _ensureChain = Promise.resolve();

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    item_name: 'Setting',
    description:
      'Workspace storage for plugin preferences (cross-device when you choose synced settings). One row per plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    views: [],
    fields: [
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
    ],
    page_field_ids: ['plugin_id', 'settings_json'],
    sidebar_record_sort_field_id: 'updated_at',
    sidebar_record_sort_dir: 'desc',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    home: false,
    color: null,
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  async function findColl(data) {
    try {
      const all = await data.getAllCollections();
      return all.find((c) => (c.getName?.() || '') === COL_NAME) || null;
    } catch (_) {
      return null;
    }
  }

  function ensurePluginSettingsCollection(data) {
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    const work = async () => {
      try {
        const existing = await findColl(data);
        if (existing) return;
        const coll = await data.createCollection();
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const again = await findColl(data);
        if (again) return;
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        const ok = await coll.saveConfiguration(conf);
        if (ok === false) return;
        await new Promise((r) => setTimeout(r, 350));
      } catch (e) {
        console.error('[ThymerPluginSettings] ensure collection', e);
      }
    };
    _ensureChain = _ensureChain.catch(() => {}).then(work);
    return _ensureChain;
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = records.find((x) => (x.text?.('plugin_id') || '').trim() === pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = records.find((x) => (x.text?.('plugin_id') || '').trim() === pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || again.find((x) => (x.text?.('plugin_id') || '').trim() === pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    try {
      const pId = r.prop?.('plugin_id');
      if (pId && typeof pId.set === 'function') pId.set(pluginId);
    } catch (_) {}
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerPluginSettings = {
    COL_NAME,
    enqueue,
    async init(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;

      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        for (const k of keys) {
          const v = remote.payload[k];
          if (typeof v === 'string') {
            try {
              localStorage.setItem(k, v);
            } catch (_) {}
          }
        }
      }

      if (plugin._pluginSettingsSyncMode === 'synced') {
        try {
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync across devices';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings


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
  _overlayFocusGuard = null;

  _STORAGE_KEY_HASH  = 'thymer_applock_pin_hash_v1';
  _STORAGE_KEY_STATE = 'thymer_applock_state_v1';
  /** Set on `pagehide` so the next process launch (desktop) or full reload asks for the PIN again. */
  _STORAGE_KEY_RESUME_GATE = 'thymer_applock_resume_gate_v1';

  _pluginSettingsMirrorKeys() {
    return [this._STORAGE_KEY_HASH, this._STORAGE_KEY_STATE, this._STORAGE_KEY_RESUME_GATE];
  }

  _pluginSettingsFlush() {
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => this._pluginSettingsMirrorKeys());
  }

  async onLoad() {
    await (globalThis.ThymerPluginSettings?.init?.({
      plugin: this,
      pluginId: 'app-lock',
      modeKey: 'thymerext_ps_mode_app_lock',
      mirrorKeys: () => this._pluginSettingsMirrorKeys(),
      label: 'App Lock',
      data: this.data,
      ui: this.ui,
    }) ?? (console.warn('[App Lock] ThymerPluginSettings runtime missing (redeploy full plugin .js from repo).'), Promise.resolve()));
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
        label: 'App Lock: Storage location…',
        icon: 'ti-database',
        onSelected: () => {
          globalThis.ThymerPluginSettings?.openStorageDialog?.({
            plugin: this,
            pluginId: 'app-lock',
            modeKey: 'thymerext_ps_mode_app_lock',
            mirrorKeys: () => this._pluginSettingsMirrorKeys(),
            label: 'App Lock',
            data: this.data,
            ui: this.ui,
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

    if (hasPin && (wasLocked || resumeGate)) {
      this._showLockOverlay();
    } else {
      try { localStorage.removeItem(this._STORAGE_KEY_RESUME_GATE); } catch (e) { /* ignore */ }
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
      this._pluginSettingsFlush();
      this._resetIdleTimer();
    }
  }

  onUnload() {
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
    try {
      if (!localStorage.getItem(this._STORAGE_KEY_HASH)) return;
      if (this._overlayEl) return;
      localStorage.setItem(this._STORAGE_KEY_RESUME_GATE, '1');
      this._pluginSettingsFlush();
    } catch (e) { /* ignore */ }
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
      const t = e.target;
      if (!t || overlay.contains(t)) return;
      const prefer =
        overlay.querySelector('#tal-pin-input') ||
        overlay.querySelector('#tal-pin-new') ||
        overlay.querySelector('input:not([disabled]), button:not([disabled])');
      if (prefer && typeof prefer.focus === 'function') {
        try { prefer.focus({ preventScroll: true }); } catch (_) { try { prefer.focus(); } catch (_) {} }
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
    const pluginSettingsModeKeys = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('thymerext_ps_mode_')) pluginSettingsModeKeys[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    try {
      localStorage.clear();
      if (pinHash) localStorage.setItem(this._STORAGE_KEY_HASH, pinHash);
      localStorage.setItem(this._STORAGE_KEY_STATE, 'unlocked');
      for (const k of Object.keys(pluginSettingsModeKeys)) {
        const v = pluginSettingsModeKeys[k];
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
