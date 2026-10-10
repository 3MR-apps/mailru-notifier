'use strict';

/* ======= Mail.ru Нотификатор — хранилище (lib/store.js) =======
 * - settings, state  → chrome.storage.local  (переживают перезапуск браузера)
 * - tokens, pending  → chrome.storage.session (только в памяти, не на диске;
 *   без запасного варианта: при его отсутствии токен не должен попасть в local)
 */

(function (g) {
  const DEFAULT_SETTINGS = {
    intervalMinutes: 2,            // период проверки (1..60)
    notifyEnabled: true,           // системные уведомления о новых письмах
    perMessageNotifications: true, // по уведомлению на письмо (иначе одно сводное)
    notificationButtons: true,     // кнопки «Прочитано» / «Удалить» в уведомлении
    soundEnabled: true,            // собственный звук нового письма (offscreen)
    notificationMode: 'native',    // native | window (legacy, explicit opt-in)
    accountNotificationModes: {},  // email -> inherit | sound | silent | counter
    excludeSpamTrash: true,        // не считать спам и корзину
    maxMessagesPerAccount: 100
  };

  function sessionArea() {
    if (!chrome.storage.session) throw new Error('chrome.storage.session недоступен (нужен Chrome 102+)');
    return chrome.storage.session;
  }

  async function areaGet(area, key, fallback) {
    const res = await area.get(key);
    return res && res[key] !== undefined ? res[key] : fallback;
  }

  async function areaSet(area, key, value) {
    await area.set({ [key]: value });
  }

  /* ---------- настройки ---------- */

  const SETTINGS_MIGRATION_VERSION = 1;

  async function loadSettings() {
    const stored = await areaGet(chrome.storage.local, 'settings', null);
    const s = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    const accountModes = s.accountNotificationModes;
    s.accountNotificationModes = accountModes && typeof accountModes === 'object' && !Array.isArray(accountModes)
      ? accountModes : {};
    if (stored && (parseInt(stored.settingsMigrationVersion, 10) || 0) < SETTINGS_MIGRATION_VERSION) {
      // Move users from the old popup default to native notifications exactly once.
      if (stored.notificationMode === 'window') s.notificationMode = 'native';
      s.settingsMigrationVersion = SETTINGS_MIGRATION_VERSION;
      await areaSet(chrome.storage.local, 'settings', s);
    }
    return s;
  }

  async function saveSettings(settings) {
    const current = await loadSettings();
    const merged = Object.assign({}, current, settings || {});
    merged.accountNotificationModes = current.accountNotificationModes;
    if (settings && settings.accountNotificationModes && typeof settings.accountNotificationModes === 'object') {
      // The UI sends the complete sparse map; absence of an email explicitly means inherit.
      merged.accountNotificationModes = Object.assign({}, settings.accountNotificationModes);
    }
    merged.settingsMigrationVersion = SETTINGS_MIGRATION_VERSION;
    for (const email of Object.keys(merged.accountNotificationModes)) {
      if (!['inherit', 'sound', 'silent', 'counter'].includes(merged.accountNotificationModes[email])) {
        delete merged.accountNotificationModes[email];
      }
    }
    merged.intervalMinutes = Math.min(
      60, Math.max(1, parseInt(merged.intervalMinutes, 10) || DEFAULT_SETTINGS.intervalMinutes)
    );
    merged.maxMessagesPerAccount = Math.min(
      200, Math.max(10, parseInt(merged.maxMessagesPerAccount, 10) || DEFAULT_SETTINGS.maxMessagesPerAccount)
    );
    await areaSet(chrome.storage.local, 'settings', merged);
    return merged;
  }

  function resolveAccountNotificationSettings(settings, email) {
    const mode = settings.accountNotificationModes && settings.accountNotificationModes[email] || 'inherit';
    const notifyEnabled = settings.notifyEnabled !== false && mode !== 'counter';
    const soundEnabled = notifyEnabled && settings.soundEnabled !== false && mode !== 'silent';
    return Object.assign({}, settings, {
      accountNotificationMode: mode,
      effectiveNotifyEnabled: notifyEnabled,
      effectiveSoundEnabled: soundEnabled
    });
  }

  /* ---------- состояние ---------- */

  function defaultState() {
    return {
      authStatus: null,   // true / false / null (ещё не проверяли)
      currentEmail: null,
      totalUnread: 0,
      lastCheck: 0,
      lastError: null,
      accounts: {}        // email -> { count, folders, messages, error, updatedAt, initialized }
    };
  }

  async function loadState() {
    const s = await areaGet(chrome.storage.local, 'state', null);
    if (!s || typeof s !== 'object') return defaultState();
    return Object.assign(defaultState(), s);
  }

  async function saveState(state) {
    await areaSet(chrome.storage.local, 'state', state);
  }

  /* ---------- API-токены (только в памяти сессии) ---------- */

  async function getToken(email) {
    const map = (await areaGet(sessionArea(), 'tokens', {})) || {};
    return map[email] || null;
  }

  async function setToken(email, token) {
    const map = (await areaGet(sessionArea(), 'tokens', {})) || {};
    map[email] = token;
    await areaSet(sessionArea(), 'tokens', map);
  }

  async function clearToken(email) {
    const map = (await areaGet(sessionArea(), 'tokens', {})) || {};
    delete map[email];
    await areaSet(sessionArea(), 'tokens', map);
  }

  async function clearAllTokens() {
    await sessionArea().remove('tokens');
  }

  /* ---------- очередь уведомлений (в памяти сессии) ---------- */

  async function loadPendingNotifs() {
    return (await areaGet(sessionArea(), 'pendingNotifs', {})) || {};
  }

  async function savePendingNotifs(map) {
    await areaSet(sessionArea(), 'pendingNotifs', map);
  }

  async function registerPending(notifId, info) {
    const map = await loadPendingNotifs();
    map[notifId] = info;
    await savePendingNotifs(map);
  }

  async function takePending(notifId) {
    const map = await loadPendingNotifs();
    const info = map[notifId];
    if (info) {
      delete map[notifId];
      await savePendingNotifs(map);
    }
    return info || null;
  }

  async function clearPending() {
    await sessionArea().remove('pendingNotifs');
  }

  async function loadWindowNotices() { return (await areaGet(sessionArea(), 'windowNotices', [])) || []; }
  async function saveWindowNotices(items) { await areaSet(sessionArea(), 'windowNotices', Array.isArray(items) ? items : []); }
  let windowNoticesPromise = Promise.resolve();
  function updateWindowNotices(mutator) {
    const run = windowNoticesPromise.then(async () => {
      const items = await loadWindowNotices();
      const next = await mutator(items);
      await saveWindowNotices(next);
      return next;
    });
    windowNoticesPromise = run.catch(() => {});
    return run;
  }
  async function loadDisplayedNoticeIds() { return (await areaGet(sessionArea(), 'displayedNoticeIds', [])) || []; }
  async function saveDisplayedNoticeIds(ids) { await areaSet(sessionArea(), 'displayedNoticeIds', Array.isArray(ids) ? ids : []); }
  async function clearDisplayedNoticeIds() { await sessionArea().remove('displayedNoticeIds'); }

  g.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  g.sessionArea = sessionArea;
  g.loadSettings = loadSettings;
  g.saveSettings = saveSettings;
  g.resolveAccountNotificationSettings = resolveAccountNotificationSettings;
  g.defaultState = defaultState;
  g.loadState = loadState;
  g.saveState = saveState;
  g.getToken = getToken;
  g.setToken = setToken;
  g.clearToken = clearToken;
  g.clearAllTokens = clearAllTokens;
  g.registerPending = registerPending;
  g.takePending = takePending;
  g.clearPending = clearPending;
  g.loadWindowNotices = loadWindowNotices;
  g.saveWindowNotices = saveWindowNotices;
  g.updateWindowNotices = updateWindowNotices;
  g.loadDisplayedNoticeIds = loadDisplayedNoticeIds;
  g.saveDisplayedNoticeIds = saveDisplayedNoticeIds;
  g.clearDisplayedNoticeIds = clearDisplayedNoticeIds;
})(typeof globalThis !== 'undefined' ? globalThis : this);
