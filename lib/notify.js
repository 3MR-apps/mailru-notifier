'use strict';

(function (g) {
  let windowPromise = null;
  let windowLifecyclePromise = Promise.resolve();
  let queuePromise = Promise.resolve();
  function withWindowLifecycle(task) {
    const run = windowLifecyclePromise.then(task);
    windowLifecyclePromise = run.catch(() => {});
    return run;
  }
  async function discardDisplayedNoticeBatches() {
    return await updateWindowNotices(async (items) => {
      const displayed = new Set((await loadDisplayedNoticeIds()).map(String));
      const left = displayed.size ? items.filter((item) => !displayed.has(String(item.id))) : items;
      await clearDisplayedNoticeIds();
      return left;
    });
  }
  let offscreenPromise = null;
  async function hasOffscreen() {
    if (!chrome.runtime.getContexts) return false; // Chrome < 116: узнаем по ошибке createDocument
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  }
  // Одновременные сигналы ждут одно и то же создание документа, а не шлют звук в недогруженный.
  function ensureOffscreen() {
    if (!chrome.offscreen || !chrome.offscreen.createDocument) return Promise.resolve(false);
    if (offscreenPromise) return offscreenPromise;
    offscreenPromise = (async () => {
      if (await hasOffscreen()) return true;
      try {
        await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Звук уведомлений о новых письмах (3MR)' });
      } catch (e) {
        if (!/single offscreen/i.test(String(e && e.message || e))) {
          console.warn('[mailru-notifier] offscreen document failed:', e);
          return false;
        }
      }
      return true;
    })().finally(() => { offscreenPromise = null; });
    return offscreenPromise;
  }
  // Что играть: выбранный встроенный сигнал или свой файл (data:audio) с запасным стандартным.
  async function soundMessage(soundId) {
    const message = { type: 'playSound', file: presetSoundFile(soundId), volume: 0.8 };
    if (soundId === CUSTOM_SOUND_ID) {
      const { customSound } = await chrome.storage.local.get('customSound');
      if (customSound && typeof customSound.dataUrl === 'string') message.dataUrl = customSound.dataUrl;
    }
    return message;
  }
  async function playNotifySound(settings) {
    try {
      const s = settings || await loadSettings();
      const enabled = s.effectiveSoundEnabled !== undefined ? s.effectiveSoundEnabled : s.soundEnabled !== false;
      if (!enabled || !(await ensureOffscreen())) return { ok: true, skipped: true };
      const message = await soundMessage(s.soundId);
      await new Promise((resolve) => chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; resolve(); }));
      return { ok: true };
    }
    catch (e) { console.warn('[mailru-notifier] sound failed:', e); return { ok: false, error: String(e && e.message || e) }; }
  }
  function getPermissionLevel() {
    return new Promise((resolve) => {
      if (!chrome.notifications || !chrome.notifications.getPermissionLevel) return resolve('unknown');
      chrome.notifications.getPermissionLevel((level) => {
        const err = chrome.runtime.lastError;
        resolve(err ? 'unknown' : (level || 'unknown'));
      });
    });
  }
  async function getWindowId() { const r = await sessionArea().get('noticeWindowId'); return r.noticeWindowId || null; }
  async function setWindowId(id) { await sessionArea().set({ noticeWindowId: id }); }
  function createWindow(url) { return new Promise((resolve, reject) => chrome.windows.create({ url, type: 'popup', focused: false, width: 420, height: 520 }, (w) => { const err = chrome.runtime.lastError; if (err) return reject(new Error(err.message)); if (!w || !w.id) return reject(new Error('Chrome не вернул идентификатор окна')); resolve(w); })); }
  async function openNoticeWindow() {
    if (windowPromise) return windowPromise;
    windowPromise = withWindowLifecycle(async () => { const oldId = await getWindowId(); if (oldId) { try { await chrome.windows.get(oldId); return oldId; } catch (e) { await sessionArea().remove('noticeWindowId'); await discardDisplayedNoticeBatches(); } } const w = await createWindow(chrome.runtime.getURL('notice.html')); await setWindowId(w.id); return w.id; }).finally(() => { windowPromise = null; });
    return windowPromise;
  }
  function handleNoticeWindowRemoved(windowId) {
    return withWindowLifecycle(async () => {
      const settings = await loadSettings();
      if (settings.notificationMode === 'native') {
        await discardQueuedWindowNotices();
        return;
      }
      const r = await sessionArea().get('noticeWindowId');
      if (r.noticeWindowId !== windowId) return;
      await sessionArea().remove('noticeWindowId');
      const left = await discardDisplayedNoticeBatches();
      if (left.length) {
        const w = await createWindow(chrome.runtime.getURL('notice.html'));
        await setWindowId(w.id);
      }
    });
  }
  async function enqueueWindowNotice(fresh, email) {
    const batch = { id: 'batch-' + Date.now() + '-' + Math.random().toString(36).slice(2), email: String(email || ''), messages: fresh.map((m) => ({ id: String(m.id), fromName: String(m.fromName || m.fromEmail || 'Новое письмо'), fromEmail: String(m.fromEmail || ''), subject: String(m.subject || '(без темы)'), snippet: String(m.snippet || '') })) };
    const append = queuePromise.then(async () => {
      await updateWindowNotices((items) => {
        items.push(batch);
        return items.slice(-100);
      });
    });
    queuePromise = append.catch(() => {});
    try {
      await append;
      const id = await openNoticeWindow();
      chrome.runtime.sendMessage({ type: 'notice-refresh' }, () => { void chrome.runtime.lastError; });
      return { ok: true, windowId: id };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }
  function createNativeNotification(m, email, settings, kind) {
    return new Promise((resolve) => { const id = 'msg-' + email + '-' + m.id; const info = kind === 'summary' ? { kind: 'summary', email } : { kind: 'message', email, msgId: m.id }; const title = String(m.fromName || m.fromEmail || 'Новое письмо'); const account = String(email || ''); const opt = { type: 'basic', title: title + ' · ' + account, message: String(m.subject || '(без темы)'), iconUrl: chrome.runtime.getURL('img/icon48.png'), priority: 1, silent: true }; const snippet = m.snippet ? String(m.snippet).slice(0, 160) : ''; opt.contextMessage = snippet ? account + ' · ' + snippet : 'Ящик: ' + account; if (settings.notificationButtons) opt.buttons = [{ title: 'Прочитано' }, { title: 'Удалить' }]; chrome.notifications.create(id, opt, async (createdId) => { const err = chrome.runtime.lastError; if (!err && createdId) { await registerPending(createdId, info); resolve({ ok: true, id: createdId }); return; } resolve({ ok: false, error: err ? err.message : 'Chrome не создал уведомление' }); }); });
  }
  async function notifyNative(fresh, email, settings) {
    const permissionLevel = await getPermissionLevel();
    if (permissionLevel === 'denied') return { ok: false, permissionLevel, error: 'Уведомления Chrome запрещены для приложения/расширения.' };
    const list = settings.perMessageNotifications && fresh.length <= 5 ? fresh : [{ fromName: 'Mail.ru', subject: fresh.length + ' ' + plural(fresh.length, 'новое письмо', 'новых письма', 'новых писем'), snippet: '', id: 'summary-' + Date.now() }];
    const results = [];
    for (const m of list) results.push(await createNativeNotification(m, email, settings, m.id && String(m.id).startsWith('summary-') ? 'summary' : 'message'));
    const bad = results.find((r) => !r.ok);
    return bad ? Object.assign({ permissionLevel }, bad) : { ok: true, count: results.length, permissionLevel };
  }
  async function discardQueuedWindowNotices() {
    await updateWindowNotices(() => []);
    await clearDisplayedNoticeIds();
    await sessionArea().remove('noticeWindowId');
  }
  // deferSound: звук не играется сразу — вызывающий играет его один раз за всю проверку
  async function notifyNew(fresh, email, settings, { deferSound = false } = {}) {
    if (settings.effectiveNotifyEnabled === false) return { ok: true, skipped: true };
    let result;
    try { result = settings.notificationMode === 'native' ? await notifyNative(fresh, email, settings) : await enqueueWindowNotice(fresh, email); }
    catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
    if (deferSound) result = Object.assign({}, result, { soundWanted: settings.effectiveSoundEnabled !== false });
    else await playNotifySound(settings);
    if (!result.ok) console.warn('[mailru-notifier] notification failed:', result.error);
    return result;
  }
  async function notifyTest(settings) {
    const testSettings = Object.assign({}, settings, {
      effectiveSoundEnabled: settings.soundEnabled !== false,
      effectiveNotifyEnabled: settings.notifyEnabled !== false
    });
    const sample = [{ id: 'test-' + Date.now(), fromName: 'Mail.ru', subject: 'Тестовое уведомление', snippet: 'Проверка выбранного способа доставки' }];
    let result;
    try { result = testSettings.notificationMode === 'native' ? await notifyNative(sample, 'test', testSettings) : await enqueueWindowNotice(sample, 'test'); }
    catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
    await playNotifySound(testSettings);
    return result;
  }
  g.notifyNew = notifyNew; g.notifyTest = notifyTest; g.playNotifySound = playNotifySound;
  g.handleNoticeWindowRemoved = handleNoticeWindowRemoved;
})(typeof globalThis !== 'undefined' ? globalThis : this);
