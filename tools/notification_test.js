'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const utilCode = fs.readFileSync(path.join(root, 'lib', 'util.js'), 'utf8');
const storeCode = fs.readFileSync(path.join(root, 'lib', 'store.js'), 'utf8');
const notifyCode = fs.readFileSync(path.join(root, 'lib', 'notify.js'), 'utf8');

function area(obj) {
  return {
    async get(key) { return key === null ? { ...obj } : (obj[key] === undefined ? {} : { [key]: obj[key] }); },
    async set(values) { Object.assign(obj, values); },
    async remove(keys) { for (const key of [].concat(keys)) delete obj[key]; }
  };
}

function setup({ createFailure = null, nativeFailure = null, permissionLevel = 'granted', noSession = false, offscreenExists = false } = {}) {
  const local = {};
  const session = {};
  let createdWindows = 0;
  let createdNative = 0;
  let soundCount = 0;
  let offscreenCreated = 0;
  let nextWindowId = 42;
  let closedWindowId = null;
  const nativeOptions = [];
  const runtime = {
    lastError: null,
    getURL: (file) => `chrome-extension://test/${file}`,
    async getContexts() { return offscreenExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; },
    sendMessage(message, callback) {
      if (message.type === 'playSound') soundCount++;
      if (callback) callback();
    }
  };
  global.chrome = {
    storage: noSession ? { local: area(local) } : { local: area(local), session: area(session) },
    runtime,
    offscreen: {
      async createDocument() {
        offscreenCreated++;
        if (offscreenExists) throw new Error('Only a single offscreen document may be created.');
        await new Promise((resolve) => setTimeout(resolve, 20)); // документ грузится не мгновенно
        offscreenExists = true;
      }
    },
    windows: {
      create(options, callback) {
        createdWindows++;
        if (createFailure) runtime.lastError = { message: createFailure };
        const id = nextWindowId++;
        callback(createFailure ? undefined : { id });
        runtime.lastError = null;
      },
      async get(id) { if (id === closedWindowId) throw new Error('window closed'); return { id }; }
    },
    notifications: {
      getPermissionLevel(callback) { callback(permissionLevel); },
      create(id, options, callback) {
        createdNative++;
        nativeOptions.push(options);
        if (nativeFailure) runtime.lastError = { message: nativeFailure };
        callback(nativeFailure ? undefined : id);
        runtime.lastError = null;
      }
    }
  };
  vm.runInThisContext(utilCode, { filename: 'lib/util.js' });
  vm.runInThisContext(storeCode, { filename: 'lib/store.js' });
  vm.runInThisContext(notifyCode, { filename: 'lib/notify.js' });
  return {
    local, session,
    stats: () => ({ createdWindows, createdNative, soundCount, nativeOptions, offscreenCreated }),
    setMode(value) { local.settings = Object.assign({}, local.settings || {}, { notificationMode: value, settingsMigrationVersion: 1 }); },
    closeWindow(id) { closedWindowId = id; }
  };
}

const msg = (id) => [{ id, fromName: 'Sender', fromEmail: 'sender@example.test', subject: `Subject ${id}`, snippet: 'literal <b>text</b>' }];

(async () => {
  let h = setup();
  let settings = await loadSettings();
  assert.strictEqual(settings.notificationMode, 'native', 'fresh installs use system notifications');

  // Existing installations migrate once, while unrelated settings survive; future explicit window choice sticks.
  h.local.settings = { notificationMode: 'window', intervalMinutes: 7, soundEnabled: false };
  settings = await loadSettings();
  assert.strictEqual(settings.notificationMode, 'native');
  assert.strictEqual(settings.intervalMinutes, 7);
  assert.strictEqual(settings.soundEnabled, false);
  assert.strictEqual((await loadSettings()).notificationMode, 'native');
  await saveSettings(Object.assign({}, settings, { notificationMode: 'window' }));
  assert.strictEqual((await loadSettings()).notificationMode, 'window');

  // Email overrides are sparse, persistent, and never prune temporarily absent accounts.
  await saveSettings({ accountNotificationModes: { 'a@test': 'sound', 'b@test': 'silent', 'c@test': 'counter' } });
  settings = await loadSettings();
  assert.deepStrictEqual(settings.accountNotificationModes, { 'a@test': 'sound', 'b@test': 'silent', 'c@test': 'counter' });
  assert.strictEqual(resolveAccountNotificationSettings(settings, 'missing@test').accountNotificationMode, 'inherit');
  assert.strictEqual(resolveAccountNotificationSettings(settings, 'a@test').effectiveSoundEnabled, false, 'global sound master remains off');
  settings.soundEnabled = true;
  assert.strictEqual(resolveAccountNotificationSettings(settings, 'a@test').effectiveSoundEnabled, true);
  assert.strictEqual(resolveAccountNotificationSettings(settings, 'b@test').effectiveSoundEnabled, false);
  assert.strictEqual(resolveAccountNotificationSettings(settings, 'c@test').effectiveNotifyEnabled, false);
  assert.strictEqual(resolveAccountNotificationSettings(Object.assign({}, settings, { notifyEnabled: false }), 'a@test').effectiveNotifyEnabled, false);
  assert.strictEqual(resolveAccountNotificationSettings(Object.assign({}, settings, { soundEnabled: false }), 'a@test').effectiveSoundEnabled, false);
  await saveSettings({ accountNotificationModes: { 'a@test': 'inherit', 'b@test': 'inherit' } });
  settings = await loadSettings();
  assert.deepStrictEqual(settings.accountNotificationModes, { 'a@test': 'inherit', 'b@test': 'inherit' }, 'overrides can be reset to inherit');

  // Legacy extension windows are opt-in, reusable, and keep their custom sound behavior.
  h = setup();
  settings = await loadSettings();
  settings.notificationMode = 'window';
  let r = await notifyNew(msg('a'), 'one@example.test', settings);
  assert.strictEqual(r.ok, true);
  r = await notifyNew(msg('b'), 'two@example.test', settings);
  assert.strictEqual(r.ok, true);
  let items = await loadWindowNotices();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(h.stats().createdWindows, 1);
  assert.strictEqual(h.stats().soundCount, 2);

  // Native notifications are silent to avoid a duplicate OS sound; the extension's sound remains audible.
  h = setup();
  settings = await loadSettings();
  settings.effectiveSoundEnabled = true;
  r = await notifyNew(msg('native-ok'), 'native@example.test', settings);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.stats().createdNative, 1);
  assert.strictEqual(h.stats().soundCount, 1, 'native delivery plays the extension signal once per batch');
  assert.strictEqual(h.stats().nativeOptions[0].silent, true, 'native banner never adds a second sound');
  assert.ok(h.stats().nativeOptions[0].title.includes('native@example.test'));
  assert.ok(h.stats().nativeOptions[0].contextMessage.includes('native@example.test'));

  h = setup();
  settings = await loadSettings();
  settings.effectiveSoundEnabled = false;
  await notifyNew(msg('silent'), 'silent@example.test', settings);
  assert.strictEqual(h.stats().nativeOptions[0].silent, true);
  assert.strictEqual(h.stats().soundCount, 0);

  h = setup({ permissionLevel: 'denied' });
  r = await notifyTest(await loadSettings());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.permissionLevel, 'denied');
  assert.match(r.error, /запрещены/i);
  assert.strictEqual(h.stats().createdNative, 0);
  assert.strictEqual(h.stats().soundCount, 1, 'native permission failure still plays the enabled extension signal');

  h = setup();
  settings = await loadSettings();
  settings.soundEnabled = false;
  r = await notifyTest(settings);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(h.stats().nativeOptions[0].silent, true, 'global sound mute applies to test notifications');
  assert.strictEqual(h.stats().soundCount, 0);

  h = setup({ nativeFailure: 'notifications disabled' });
  r = await notifyTest(await loadSettings());
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /notifications disabled/);
  assert.strictEqual(h.stats().soundCount, 1, 'failed native test still plays the enabled extension signal');

  h = setup({ nativeFailure: 'notifications disabled' });
  settings = await loadSettings();
  settings.effectiveSoundEnabled = true;
  r = await notifyNew(msg('native-fail'), 'native@example.test', settings);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(h.stats().soundCount, 1, 'failed new-mail delivery still plays one sound');
  assert.strictEqual(h.stats().nativeOptions[0].silent, true);

  // Counter mode creates no notification; unread state is still stored by checkAccount in smoke coverage.
  h = setup();
  settings = Object.assign({}, await loadSettings(), { effectiveNotifyEnabled: false });
  r = await notifyNew(msg('counter'), 'counter@example.test', settings);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(h.stats().createdNative, 0);
  assert.strictEqual(h.stats().createdWindows, 0);
  assert.strictEqual(h.stats().soundCount, 0, 'counter/global-off skips the extension signal');

  // Closing a legacy window reopens only when the selected mode is still window.
  h = setup();
  h.setMode('window');
  await saveWindowNotices([{ id: 'A', email: 'old', messages: [] }, { id: 'B', email: 'new', messages: [] }]);
  await saveDisplayedNoticeIds(['A']);
  h.session.noticeWindowId = 41;
  await handleNoticeWindowRemoved(41);
  items = await loadWindowNotices();
  assert.deepStrictEqual(items.map((item) => item.id), ['B']);
  assert.strictEqual(h.stats().createdWindows, 1);

  h = setup();
  await saveWindowNotices([{ id: 'legacy', email: 'old', messages: [] }]);
  h.session.noticeWindowId = 41;
  await handleNoticeWindowRemoved(41);
  assert.deepStrictEqual(await loadWindowNotices(), [], 'native mode discards stale popup queue');
  assert.strictEqual(h.stats().createdWindows, 0, 'native mode never recreates legacy popup');

  // Legacy window delivery errors remain structured and test mode reports them.
  h = setup({ createFailure: 'window create failed' });
  settings = await loadSettings();
  settings.notificationMode = 'window';
  r = await notifyTest(settings);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /window create failed/);
  assert.strictEqual(h.stats().soundCount, 1);

  // Offscreen-документ для звука создаётся один раз, даже при одновременных сигналах.
  h = setup();
  await Promise.all([playNotifySound({ effectiveSoundEnabled: true }), playNotifySound({ effectiveSoundEnabled: true })]);
  assert.strictEqual(h.stats().offscreenCreated, 1, 'параллельные сигналы не создают документ дважды');
  assert.strictEqual(h.stats().soundCount, 2, 'оба сигнала отправлены');
  await playNotifySound({ effectiveSoundEnabled: true });
  assert.strictEqual(h.stats().offscreenCreated, 1, 'существующий документ переиспользуется');

  // Chrome 110–115: нет runtime.getContexts, документ уже есть — звук всё равно играет.
  h = setup({ offscreenExists: true });
  delete chrome.runtime.getContexts;
  await playNotifySound({ effectiveSoundEnabled: true });
  assert.strictEqual(h.stats().soundCount, 1, 'ошибка «single offscreen document» не мешает звуку');

  // Без chrome.storage.session токены не уходят на диск.
  h = setup({ noSession: true });
  await assert.rejects(() => setToken('user@mail.ru', 'SECRET'), /storage\.session/);
  assert.ok(!JSON.stringify(h.local).includes('SECRET'), 'токен не записан в local');

  // А1: saveSettings принимает только известные ключи и правильные типы
  h = setup();
  await saveSettings({ notificationMode: 'window', maxMessagesPerAccount: 150 });
  let saved = await saveSettings({ evil: '<script>', notifyEnabled: 'false', soundEnabled: 0, perMessageNotifications: 1, notificationMode: 'popup', intervalMinutes: 5 });
  assert.strictEqual(saved.evil, undefined, 'неизвестный ключ отброшен');
  assert.strictEqual(h.local.settings.evil, undefined, 'неизвестный ключ не сохранён');
  assert.strictEqual(saved.notifyEnabled, true, 'строка не меняет булев флаг');
  assert.strictEqual(saved.soundEnabled, true, 'число не меняет булев флаг');
  assert.strictEqual(saved.perMessageNotifications, true, 'число не меняет булев флаг');
  saved = await saveSettings({ soundEnabled: false });
  assert.strictEqual(saved.soundEnabled, false, 'настоящее булево значение принимается');
  assert.strictEqual(saved.notificationMode, 'window', 'неверный режим не меняет сохранённый');
  assert.strictEqual(saved.maxMessagesPerAccount, 150, 'ключ, которого нет в форме настроек, сохраняется');
  assert.strictEqual(saved.settingsMigrationVersion, 1, 'версия миграции сохраняется');
  assert.strictEqual(saved.intervalMinutes, 5);
  saved = await loadSettings();
  assert.strictEqual(saved.notificationMode, 'window', 'миграция не срабатывает повторно');

  console.log('notification regression tests passed: migration, account modes, delivery, permissions, legacy queue, offscreen, session-only tokens');
})().catch((error) => {
  console.error('notification regression test failed:', error.stack || error);
  process.exitCode = 1;
});