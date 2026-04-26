// @generated BEGIN thymer-plugin-settings (source: plugins/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. Off by default; to enable:
 *   localStorage.setItem('thymerext_debug_collections', '1'); location.reload();
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Opt-in: `localStorage.setItem('thymerext_debug_collections','1')` then reload.
   * Opt-out: remove the key or set to `0` / `off` / `false`.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
      return o === '1' || o === 'true' || o === 'on';
    } catch (_) {}
    return false;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
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
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
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
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    for (const x of records) {
      if (isVaultRow(x, pluginId)) return x;
    }
    return null;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
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

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** Configured collection name only (avoids duplicating `collectionDisplayName` fallbacks). */
  function collectionBackendConfiguredTitle(c) {
    if (!c) return '';
    try {
      return String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * When plugin iframes are opaque (blob/sandbox), `navigator.locks` and `window.top` globals do not
   * dedupe across realms. First `localStorage` we can reach on the Thymer app origin is shared.
   */
  function getSharedThymerLocalStorage() {
    const seen = new Set();
    const tryWin = (w) => {
      if (!w || seen.has(w)) return null;
      seen.add(w);
      try {
        const ls = w.localStorage;
        void ls.length;
        return ls;
      } catch (_) {
        return null;
      }
    };
    try {
      const t = tryWin(window.top);
      if (t) return t;
    } catch (_) {}
    try {
      const t = tryWin(window);
      if (t) return t;
    } catch (_) {}
    try {
      let w = window;
      for (let i = 0; i < 10 && w; i++) {
        const t = tryWin(w);
        if (t) return t;
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch (_) {}
    return null;
  }

  const LS_CREATE_LEASE_KEY = 'thymerext_plugin_backend_create_lease_v1';
  const LS_RECENT_CREATE_KEY = 'thymerext_plugin_backend_recent_create_v1';
  const LS_RECENT_CREATE_ATTEMPT_KEY = 'thymerext_plugin_backend_recent_create_attempt_v1';

  /**
   * Cross-realm mutex for `createCollection` + first `saveConfiguration` only.
   * @returns {{ denied: boolean, release: () => void }}
   */
  async function acquirePluginBackendCreationLease(maxWaitMs) {
    const noop = { denied: false, release() {} };
    const ls = getSharedThymerLocalStorage();
    if (!ls) return noop;
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let sawContention = false;
    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(LS_CREATE_LEASE_KEY);
        let busy = false;
        if (raw) {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = null;
          }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          sawContention = true;
          await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 70)));
          continue;
        }
        const exp = Date.now() + 45000;
        const payload = JSON.stringify({ h: holder, exp });
        ls.setItem(LS_CREATE_LEASE_KEY, payload);
        await new Promise((r) => setTimeout(r, 0));
        if (ls.getItem(LS_CREATE_LEASE_KEY) === payload) {
          acquired = true;
          if (DEBUG_COLLECTIONS) dlogPathB('lease_acquired', { via: 'localStorage', sawContention });
          break;
        }
      } catch (_) {
        return noop;
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
    }
    if (!acquired) {
      if (DEBUG_COLLECTIONS) dlogPathB('lease_timeout_abort_create', { sawContention });
      return { denied: true, release() {} };
    }
    return {
      denied: false,
      release() {
        if (!acquired) return;
        acquired = false;
        try {
          const cur = ls.getItem(LS_CREATE_LEASE_KEY);
          if (!cur) return;
          let j = null;
          try {
            j = JSON.parse(cur);
          } catch (_) {
            return;
          }
          if (j && j.h === holder) ls.removeItem(LS_CREATE_LEASE_KEY);
        } catch (_) {}
      },
    };
  }

  function noteRecentPluginBackendCreate() {
    const ls = getSharedThymerLocalStorage();
    if (!ls) return;
    try {
      ls.setItem(LS_RECENT_CREATE_KEY, String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAgeMs() {
    const ls = getSharedThymerLocalStorage();
    if (!ls) return null;
    try {
      const raw = ls.getItem(LS_RECENT_CREATE_KEY);
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  function noteRecentPluginBackendCreateAttempt() {
    const ls = getSharedThymerLocalStorage();
    if (!ls) return;
    try {
      ls.setItem(LS_RECENT_CREATE_ATTEMPT_KEY, String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAttemptAgeMs() {
    const ls = getSharedThymerLocalStorage();
    if (!ls) return null;
    try {
      const raw = ls.getItem(LS_RECENT_CREATE_ATTEMPT_KEY);
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      const cfg = collectionBackendConfiguredTitle(c);
      return n === COL_NAME || n === COL_NAME_LEGACY || cfg === COL_NAME || cfg === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  async function findColl(data) {
    try {
      const pick = (all) => {
        const list = Array.isArray(all) ? all : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      const all = await data.getAllCollections();
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    let all;
    try {
      all = await data.getAllCollections();
    } catch (_) {
      return false;
    }
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
      const cfg = collectionBackendConfiguredTitle(c);
      if (cfg === COL_NAME || cfg === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await data.getAllCollections();
          const collNames = (Array.isArray(a) ? a : []).map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        existing = await findColl(data);
        if (existing) return;
        if (await hasPluginBackendOnWorkspace(data)) return;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      existing = await findColl(data);
      if (existing) return;
      if (await hasPluginBackendOnWorkspace(data)) return;
      await new Promise((r) => setTimeout(r, 120));
      if (await findColl(data)) return;
      if (await hasPluginBackendOnWorkspace(data)) return;
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await data.getAllCollections();
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await data.getAllCollections();
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          if (await findColl(data)) return;
          if (await hasPluginBackendOnWorkspace(data)) return;
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const lease = await acquirePluginBackendCreationLease(14000);
      if (lease.denied) return;
      try {
        if (await findColl(data)) return;
        if (await hasPluginBackendOnWorkspace(data)) return;
        const recentAttemptAge = getRecentPluginBackendCreateAttemptAgeMs();
        if (recentAttemptAge != null && recentAttemptAge >= 0 && recentAttemptAge < 120000) {
          // Another plugin iframe attempted creation very recently. Avoid burst duplicate creates.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 130 + i * 70));
            if (await findColl(data)) return;
            if (await hasPluginBackendOnWorkspace(data)) return;
          }
          return;
        }
        const recentAge = getRecentPluginBackendCreateAgeMs();
        if (recentAge != null && recentAge >= 0 && recentAge < 90000) {
          // Another plugin/runtime likely just created it; let collection list/indexing settle first.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 120 + i * 60));
            if (await findColl(data)) return;
            if (await hasPluginBackendOnWorkspace(data)) return;
          }
        }
        noteRecentPluginBackendCreateAttempt();
        const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        let ok = await coll.saveConfiguration(conf);
        if (ok === false) {
          // Transient host races can reject the first save; retry before giving up.
          await new Promise((r) => setTimeout(r, 180));
          ok = await coll.saveConfiguration(conf);
        }
        if (ok === false) return;
        noteRecentPluginBackendCreate();
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        try {
          lease.release();
        } catch (_) {}
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
    }
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
    const r = findVaultRecord(records, pluginId);
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
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
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
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
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
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,

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
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
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
      await upgradePluginSettingsSchema(data);
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
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
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
