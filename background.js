'use strict';

/* ============================================================
 *  Mail.ru Нотификатор — background service worker (MV3)
 *  Оркестратор: проверка ящиков, значок, alarm, роутер сообщений.
 *  Модули: lib/util.js, lib/store.js, lib/mailapi.js, lib/notify.js
 * ============================================================ */

if (typeof importScripts === 'function') {
  importScripts('lib/util.js', 'lib/store.js', 'lib/mailapi.js', 'lib/notify.js');
} else if (typeof require === 'function') {
  require('./lib/util.js');
  require('./lib/store.js');
  require('./lib/mailapi.js');
  require('./lib/notify.js');
}

const ALARM_CHECK = 'mailru-check';
const HANDLED_MIN_TTL_MS = 10 * 60 * 1000; // сколько минимум помнить открытые/прочитанные письма

/* ---------------- значок (badge) ---------------- */

function updateBadge(state) {
  if (state.authStatus === false) {
    chrome.action.setBadgeText({ text: '?' });
    chrome.action.setBadgeBackgroundColor({ color: [160, 165, 172, 235] });
    chrome.action.setTitle({ title: 'Mail.ru: войдите в почту в браузере' });
  } else {
    const t = state.totalUnread || 0;
    chrome.action.setBadgeText({ text: t > 0 ? (t > 999 ? '999+' : String(t)) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF3B30' });
    chrome.action.setTitle({
      title: t > 0 ? `Mail.ru: непрочитанных — ${t}` : 'Mail.ru: нет непрочитанных писем'
    });
  }
  if (chrome.action.setBadgeTextColor) {
    try { chrome.action.setBadgeTextColor({ color: '#FFFFFF' }); } catch (e) { /* older Chrome */ }
  }
}

function sumAccounts(state) {
  let n = 0;
  for (const k of Object.keys(state.accounts || {})) n += state.accounts[k].count || 0;
  return n;
}

function broadcast(state, settings) {
  chrome.runtime.sendMessage({ type: 'state-updated', state, settings }, () => void chrome.runtime.lastError);
}

/* ---------------- проверка одного ящика ---------------- */

// check — общие данные одной проверки (например, нужен ли звук)
async function checkAccount(state, settings, email, check = {}) {
  const acc = state.accounts[email] ||
    (state.accounts[email] = { messages: [], count: 0, folders: [], initialized: false });
  acc.error = null;

  let token = await ensureToken(email);
  if (!token) {
    acc.error = 'Не удалось получить токен (нужен вход в mail.ru)';
    return;
  }

  const limit = settings.maxMessagesPerAccount || 100;

  // --- папки (число непрочитанных) ---
  let rf = await fetchFolders(email, token, limit);
  if (isAuthError(rf.json)) {
    await clearToken(email);
    token = await ensureToken(email);
    if (token) rf = await fetchFolders(email, token, limit);
  }
  const parsed = parseFolders(rf.json);
  let foldersArr = null;
  if (parsed) {
    foldersArr = parsed
      .filter(f => f && typeof f === 'object' && f.id !== undefined)
      .map(f => ({
        id: String(f.id),
        name: String(f.name || f.title || ''),
        unread: Math.max(0, parseInt(f.messages_unread, 10) || 0)
      }));
    acc.folders = foldersArr;
  }

  const excluded = excludedFolderIds(acc.folders, settings);
  let count = foldersArr
    ? foldersArr.reduce((s, f) => (excluded.has(f.id) ? s : s + f.unread), 0)
    : 0;

  // --- непрочитанные письма ---
  let rm = await fetchUnread(email, token, limit);
  if (isAuthError(rm.json)) {
    await clearToken(email);
    token = await ensureToken(email);
    if (token) rm = await fetchUnread(email, token, limit);
  }

  let msgsOk = false;
  let msgs = [];
  if (rm.json && rm.json.status === 200 && Array.isArray(rm.json.body)) {
    msgsOk = true;
    msgs = rm.json.body.map(normalizeMsg).filter(m => m && !excluded.has(String(m.folder)));
    msgs.sort((a, b) => b.date - a.date);
  } else {
    // не затираем кэш писем при сбое эндпоинта, иначе следующий успех
    // посчитает все письма «новыми» и устроит всплеск уведомлений
    acc.error = acc.error || 'Не удалось получить список писем';
  }

  if (!foldersArr && msgsOk) count = msgs.length; // запасной вариант

  // --- уведомления о новых (только если список успешно получен) ---
  if (msgsOk) {
    const prevIds = new Set((acc.messages || []).map(m => m.id));
    const handled = pruneHandled(acc, settings);
    const fresh = msgs.filter(m => !prevIds.has(m.id) && !handled[m.id]);
    if (acc.initialized && fresh.length > 0) {
      const accountSettings = resolveAccountNotificationSettings(settings, email);
      if (accountSettings.effectiveNotifyEnabled) {
        const delivery = await notifyNew(fresh, email, accountSettings, { deferSound: true });
        if (!delivery.ok) state.notificationError = delivery.error;
        if (delivery.soundWanted) check.soundSettings = accountSettings;
      }
    }
    acc.messages = msgs.slice(0, limit);
  }
  acc.count = count;
  acc.updatedAt = Date.now();
  acc.initialized = true;
}

/* ---------------- общая проверка ---------------- */

let busyPromise = null;

// Все изменения state (load → modify → save) идут строго по очереди:
// иначе параллельная проверка и «Прочитано»/«Удалить» затирают друг друга.
let stateQueue = Promise.resolve();
function withStateLock(task) {
  const run = stateQueue.then(task);
  stateQueue = run.catch(() => {});
  return run;
}

function checkAll(reason, opts = {}) {
  if (busyPromise) return busyPromise;
  busyPromise = withStateLock(() => doCheck(reason, opts))
    .catch(e => console.warn('[mailru-notifier] check failed:', e))
    .finally(() => { busyPromise = null; });
  return busyPromise;
}

async function doCheck(reason, opts = {}) {
  const settings = await loadSettings();
  const state = await loadState();
  state.notificationError = null;

  const r = await fetchNavi();
  const j = r.json;

  if (!j) {
    state.lastError = 'Нет связи с mail.ru (проверьте интернет или доступ к сети)';
  } else if (j.status === 'ok') {
    state.authStatus = true;
    state.lastError = null;
    const data = j.data || {};
    const emails = Array.isArray(data.list)
      ? data.list.filter(e => typeof e === 'string' && e.trim()).map(e => e.trim())
      : [];
    if (!emails.length && data.email) emails.push(String(data.email));
    if (data.email) state.currentEmail = String(data.email);

    // убираем ящики, которых больше нет в аккаунте
    // (пустой список считаем сбоем ответа, а не выходом из ящиков)
    if (emails.length > 0) {
      for (const k of Object.keys(state.accounts)) {
        if (!emails.includes(k)) delete state.accounts[k];
      }
    }

    const targets = opts.onlyEmail ? emails.filter(e => e === opts.onlyEmail) : emails;
    const check = { soundSettings: null };
    for (const email of targets) {
      try {
        await checkAccount(state, settings, email, check);
      } catch (e) {
        console.warn('[mailru-notifier] account check failed:', email, e);
        const acc = state.accounts[email] || (state.accounts[email] = {});
        acc.error = String((e && e.message) || e);
      }
    }
    state.totalUnread = sumAccounts(state);
    // один сигнал на всю проверку, даже если новые письма пришли в несколько ящиков
    if (check.soundSettings) await playNotifySound(check.soundSettings);
  } else if (j.status === 'noauth') {
    state.authStatus = false;
    state.accounts = {};
    state.totalUnread = 0;
    state.lastError = null;
  } else {
    state.lastError = 'Неожиданный ответ сервера: ' + (j.status || 'unknown');
  }

  state.lastCheck = Date.now();
  await saveState(state);
  updateBadge(state);
  broadcast(state, settings);
  return state;
}

/* ---------------- действия с письмами ---------------- */

// Сетевой запрос идёт вне очереди, а результат применяется к свежему state под блокировкой.
async function messageActionCore(email, msgId, doBroadcast, callApi) {
  const acc0 = (await loadState()).accounts[email];
  if (!acc0) return false;

  const token = await ensureToken(email);
  if (!token) return false;

  const msg = (acc0.messages || []).find(m => m.id === String(msgId));
  const r = await callApi(token, (msg && msg.folder) || '0', acc0);

  const ok = !!(r.json && r.json.status === 200);
  if (!ok && isAuthError(r.json)) await clearToken(email);

  return withStateLock(async () => {
    const settings = await loadSettings();
    const state = await loadState();
    const acc = state.accounts[email];
    if (ok && acc) {
      removeFromState(state, acc, msgId);
      await saveState(state);
    }
    if (ok || doBroadcast) {
      updateBadge(state);
      broadcast(state, settings);
    }
    return ok;
  });
}

function markReadCore(email, msgId, doBroadcast) {
  return messageActionCore(email, msgId, doBroadcast,
    (token, folderId) => apiMarkRead(email, token, msgId, folderId));
}

function trashCore(email, msgId, doBroadcast) {
  return messageActionCore(email, msgId, doBroadcast,
    (token, folderId, acc) => apiMoveToTrash(email, token, msgId, folderId, findTrashFolderId(acc.folders)));
}

// Убирает устаревшие записи «обработанных» писем и возвращает актуальные.
// Срок — не меньше двух интервалов проверки, чтобы запись пережила хотя бы одну проверку.
function pruneHandled(acc, settings) {
  const ttl = Math.max(HANDLED_MIN_TTL_MS, 2 * (parseInt(settings.intervalMinutes, 10) || 2) * 60 * 1000);
  const now = Date.now();
  const left = {};
  for (const [id, at] of Object.entries(acc.handled || {})) {
    if (now - at < ttl) left[id] = at;
  }
  acc.handled = left;
  return left;
}

// true, если письмо было в списке и счётчик уменьшен.
// Письмо запоминается как «обработанное»: если mail.ru ещё не успел снять флаг
// «не прочитано», следующая проверка вернёт его, но без повторного уведомления.
function removeFromState(state, acc, msgId) {
  acc.handled = Object.assign({}, acc.handled, { [String(msgId)]: Date.now() });
  const before = (acc.messages || []).length;
  acc.messages = (acc.messages || []).filter(m => m.id !== String(msgId));
  if (acc.messages.length === before) return false;
  acc.count = Math.max(0, (acc.count || 0) - 1);
  state.totalUnread = sumAccounts(state);
  return true;
}

async function markAllRead(email) {
  const state0 = await loadState();
  const acc = state0.accounts[email];
  if (!acc || !(acc.messages || []).length) return true;
  for (const id of acc.messages.map(m => m.id)) {
    await markReadCore(email, id, false);
  }
  await checkAll('mark-all-read', { onlyEmail: email }); // свериться с сервером
  return true;
}

/* ---------------- вкладки ---------------- */

function mailUrl(page, email) {
  const u = new URL('https://auth.mail.ru/cgi-bin/auth');
  u.searchParams.set('Page', page);
  if (email) u.searchParams.set('Login', email);
  return u.href;
}

function openTab(url) { chrome.tabs.create({ url }); }
function openMessage(email, msgId) {
  openTab(mailUrl(`https://e.mail.ru/cgi-bin/readmsg?from=personal&id=${encodeURIComponent(msgId)}`, email));
}

// Для одного ящика открываем веб-почту напрямую (быстрее и надёжнее),
// переключение конкретного ящика из нескольких — через auth-обёртку mail.ru.
async function inboxUrl(email, page) {
  const state = await loadState();
  const multi = Object.keys(state.accounts || {}).length > 1;
  return email && multi ? mailUrl(page, email) : page;
}
async function openInbox(email) { openTab(await inboxUrl(email, 'https://e.mail.ru/inbox/')); }
async function openCompose(email) { openTab(await inboxUrl(email, 'https://e.mail.ru/compose/')); }
function openLogin() { openTab('https://e.mail.ru/login?from=personal'); }

// Открыть письмо и сразу убрать его из списка (оптимистично),
// через несколько секунд — контрольная проверка.
function openAndForget(email, msgId) {
  openMessage(email, msgId);
  withStateLock(async () => {
    const settings = await loadSettings();
    const state = await loadState();
    const acc = state.accounts[email];
    if (!acc) return;
    const changed = removeFromState(state, acc, msgId);
    await saveState(state);
    if (changed) {
      updateBadge(state);
      broadcast(state, settings);
    }
  }).catch(e => console.warn('[mailru-notifier] open message failed:', e))
    .finally(() => setTimeout(() => checkAll('reconcile'), 5000));
}

/* ---------------- обработчики уведомлений ---------------- */

chrome.notifications.onClicked.addListener((notifId) => {
  chrome.notifications.clear(notifId, () => {});
  takePending(notifId).then((info) => {
    if (!info) return;
    if (info.kind === 'message') openAndForget(info.email, info.msgId);
    else openInbox(info.email);
  });
});

chrome.notifications.onButtonClicked.addListener((notifId, idx) => {
  chrome.notifications.clear(notifId, () => {});
  takePending(notifId).then((info) => {
    if (!info || info.kind !== 'message') return;
    if (idx === 0) markReadCore(info.email, info.msgId, true);
    else if (idx === 1) trashCore(info.email, info.msgId, true);
  });
});

chrome.notifications.onClosed.addListener((notifId) => { takePending(notifId); });

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((windowId) => {
    handleNoticeWindowRemoved(windowId).catch((e) =>
      console.warn('[mailru-notifier] notice window cleanup failed:', e)
    );
  });
}

/* ---------------- alarm-планировщик ---------------- */

async function syncAlarm() {
  const s = await loadSettings();
  const period = Math.min(60, Math.max(1, parseInt(s.intervalMinutes, 10) || 2));
  // пересоздание сдвигает следующую проверку на полный период — делаем его только при смене интервала
  const existing = await chrome.alarms.get(ALARM_CHECK);
  if (existing && existing.periodInMinutes === period) return;
  await chrome.alarms.clear(ALARM_CHECK);
  chrome.alarms.create(ALARM_CHECK, { periodInMinutes: period });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_CHECK) checkAll('alarm');
});

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings(); // применяет разовую миграцию; сохраняет остальные настройки пользователя
  await syncAlarm();
  checkAll('install');
});

chrome.runtime.onStartup.addListener(() => {
  syncAlarm();
  checkAll('startup');
});

/* ---------------- роутер сообщений от popup/options ---------------- */

function isTrustedSender(sender) {
  // принимаем сообщения только от собственных страниц расширения
  return !!sender && typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted sender' });
    return false;
  }
  (async () => {
    try {
      switch (msg.type) {
        case 'getState': {
          const [state, settings] = await Promise.all([loadState(), loadSettings()]);
          sendResponse({ ok: true, state, settings });
          break;
        }
        case 'refresh': {
          await checkAll('manual');
          const [state, settings] = await Promise.all([loadState(), loadSettings()]);
          sendResponse({ ok: true, state, settings });
          break;
        }
        case 'markRead':
          sendResponse({ ok: await markReadCore(msg.email, msg.msgId, true) });
          break;
        case 'markAllRead':
          sendResponse({ ok: await markAllRead(msg.email) });
          break;
        case 'trash':
          sendResponse({ ok: await trashCore(msg.email, msg.msgId, true) });
          break;
        case 'openMessage':
          openAndForget(msg.email, msg.msgId);
          sendResponse({ ok: true });
          break;
        case 'openInbox':
          await openInbox(msg.email || null);
          sendResponse({ ok: true });
          break;
        case 'openCompose':
          await openCompose(msg.email || null);
          sendResponse({ ok: true });
          break;
        case 'openLogin':
          openLogin();
          sendResponse({ ok: true });
          break;
        case 'saveSettings': {
          const settings = await saveSettings(msg.settings || {});
          await syncAlarm();
          sendResponse({ ok: true, settings });
          break;
        }
        case 'testNotification': {
          const settings = await loadSettings();
          const result = await notifyTest(settings);
          sendResponse({ ok: result.ok, error: result.error, result, notificationMode: settings.notificationMode });
          break;
        }
        case 'getNoticeQueue': {
          sendResponse({ ok: true, items: await loadWindowNotices() });
          break;
        }
        case 'ackNoticeQueue': {
          const ids = new Set(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
          await updateWindowNotices(async (items) => {
            const left = items.filter((item) => !ids.has(String(item.id)));
            const displayed = new Set((await loadDisplayedNoticeIds()).map(String));
            for (const id of ids) displayed.delete(id);
            await saveDisplayedNoticeIds([...displayed]);
            return left;
          });
          sendResponse({ ok: true });
          break;
        }
        case 'markNoticeDisplayed': {
          const ids = new Set((Array.isArray(msg.ids) ? msg.ids : []).map(String));
          const displayed = new Set((await loadDisplayedNoticeIds()).map(String));
          for (const id of ids) displayed.add(id);
          await saveDisplayedNoticeIds([...displayed]);
          sendResponse({ ok: true });
          break;
        }
        case 'ackDisplayedNoticeQueue': {
          await updateWindowNotices(async (items) => {
            const displayed = new Set((await loadDisplayedNoticeIds()).map(String));
            const left = items.filter((item) => !displayed.has(String(item.id)));
            await clearDisplayedNoticeIds();
            return left;
          });
          sendResponse({ ok: true });
          break;
        }
        case 'resetState': {
          await withStateLock(() => chrome.storage.local.remove(['state', 'pendingNotifs']));
          await clearAllTokens();
          await clearPending();
          // темы и начала писем из очереди окна уведомлений; id открытого окна не трогаем — иначе откроется второе
          await updateWindowNotices(async () => { await clearDisplayedNoticeIds(); return []; });
          await checkAll('reset');
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      console.warn('[mailru-notifier] handler error:', e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // асинхронный ответ
});

/* ---------------- инициализация ---------------- */

(async function init() {
  const state = await loadState();
  updateBadge(state);
  await syncAlarm();
  // если сервис-воркер «проснулся», а данные устарели — проверяем
  const s = await loadSettings();
  const stale = !state.lastCheck || Date.now() - state.lastCheck > (s.intervalMinutes + 1) * 60 * 1000;
  if (stale) checkAll('sw-wakeup');
})();
