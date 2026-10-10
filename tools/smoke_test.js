'use strict';
/* Smoke-тест background.js на моках chrome.* и fetch (node 18+).
 * Запуск: node tools/smoke_test.js
 */
const path = require('path');
const assert = require('assert');

const BG = path.join(__dirname, '..', 'background.js');

let store = {};
let sess = {};
let badge = { text: '', color: null, title: '' };
let createdNotifs = [];
let createdTabs = [];
let onMessageHandler = null;
let fetchLog = [];
let alarms = {};
let alarmOps = 0;
let sentMessages = [];

function makeArea(obj) {
  return {
    async get(keys) {
      if (keys === null) return Object.assign({}, obj);
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
        return out;
      }
      return obj[keys] !== undefined ? { [keys]: obj[keys] } : {};
    },
    async set(o) { Object.assign(obj, o); },
    async remove(keys) { for (const k of [].concat(keys)) delete obj[k]; },
    async clear() { for (const k of Object.keys(obj)) delete obj[k]; }
  };
}

function makeChrome() {
  return {
    storage: {
      local: makeArea(store),
      session: makeArea(sess)
    },
    alarms: {
      create(name, info) { alarmOps++; alarms[name] = Object.assign({ name }, info); },
      clear: async (name) => { alarmOps++; delete alarms[name]; return true; },
      get: async (name) => alarms[name],
      onAlarm: { addListener() {} }
    },
    notifications: {
      getPermissionLevel(cb) { cb('granted'); },
      create(id, opt, cb) { createdNotifs.push({ id, opt }); cb && cb(id); },
      clear(id, cb) { cb && cb(); },
      onClicked: { addListener() {} },
      onButtonClicked: { addListener() {} },
      onClosed: { addListener() {} }
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) { sentMessages.push(msg); cb && cb(); },
      onMessage: { addListener(fn) { onMessageHandler = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL(p) { return 'chrome-extension://test/' + p; },
      openOptionsPage() {}
    },
    action: {
      setBadgeText(o) { badge.text = o.text; },
      setBadgeBackgroundColor(o) { badge.color = o.color; },
      setBadgeTextColor() {},
      setTitle(o) { badge.title = o.title; }
    },
    tabs: { create(o) { createdTabs.push(o.url); } },
    offscreen: { createDocument: async () => {}, hasDocument: async () => false }
  };
}

// --- мок ответов mail.ru ---
const NOW_S = Math.floor(Date.now() / 1000);
const FOLDERS = [
  { id: '0', name: 'Входящие', messages_unread: 2 },
  { id: '500001', name: 'Спам', messages_unread: 5 },
  { id: '500002', name: 'Корзина', messages_unread: 1 }
];
const MESSAGES = [
  {
    id: '101', folder: '0', date: NOW_S, subject: 'Заказ №42 отправлен',
    snippet: 'Ваш заказ уже в пути…', flags: { unread: true, attach: true },
    correspondents: { from: [{ name: 'Магазин', email: 'shop@ozon.example', avatars: { '50x50': '//e.mail.ru/avatar1.png' } }] }
  },
  {
    id: '102', folder: '0', date: NOW_S - 3600, subject: 'Встреча завтра &mdash; 10:00',
    snippet: 'Привет! Подтверди, пожалуйста…', flags: { unread: true },
    correspondents: { from: [{ name: 'Иван Петров', email: 'ivan@mail.ru', avatars: {} }] }
  },
  {
    id: '666', folder: '500001', date: NOW_S, subject: 'СПАМ', snippet: '…',
    flags: { unread: true }, correspondents: { from: [{ name: 'Spammer', email: 'x@y.z' }] }
  }
];

let marksCalled = 0;
let moveCalled = 0;
let messagesBody = () => MESSAGES;
let messagesFail = false;
let naviEmpty = false;
let naviList = ['user@mail.ru'];
let unreadDelayMs = 0;

function makeFetch({ auth = true } = {}) {
  return async function fetchMock(url, opts = {}) {
    fetchLog.push(url);
    const json = (obj) => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(obj)
    });
    if (url.startsWith('https://portal.mail.ru/NaviData')) {
      if (!auth) return json({ status: 'noauth', data: { action: 'list', list: [] } });
      if (naviEmpty) return json({ status: 'ok', data: { email: '', mail_cnt: 0, list: [] } });
      return json({ status: 'ok', data: { email: 'user@mail.ru', mail_cnt: 8, list: naviList } });
    }
    if (!auth) return json({ status: 403, body: 'user' });
    if (url.includes('/api/v1/tokens')) return json({ status: 200, body: { token: 'TOKEN123' } });
    if (url.includes('/api/v1/folders')) return json({ status: 200, body: FOLDERS });
    if (url.includes('/api/v1/messages/status/unread')) {
      if (messagesFail) return json({ status: 500, body: null });
      const body = messagesBody(); // снимок «сервера» на момент запроса
      if (unreadDelayMs) await sleep(unreadDelayMs);
      return json({ status: 200, body });
    }
    if (url.includes('threads/marks')) { marksCalled++; return json({ status: 200, body: { modified: [] } }); }
    if (url.includes('threads/move')) { moveCalled++; return json({ status: 200, body: { moved: [] } }); }
    return json({ status: 500 });
  };
}

function loadBackground(fetchImpl, { keepAlarms = false } = {}) {
  for (const o of [store, sess]) for (const k of Object.keys(o)) delete o[k];
  if (!keepAlarms) alarms = {};
  alarmOps = 0; sentMessages = []; unreadDelayMs = 0; naviList = ['user@mail.ru'];
  badge = { text: '', color: null, title: '' }; createdNotifs = []; createdTabs = [];
  marksCalled = 0; moveCalled = 0; fetchLog = [];
  messagesFail = false; naviEmpty = false;
  store.settings = { notificationMode: 'native' };
  globalThis.chrome = makeChrome();
  globalThis.fetch = fetchImpl;
  delete require.cache[require.resolve(BG)];
  require(BG);
}

function sendBg(msg) {
  const sender = { url: globalThis.chrome.runtime.getURL('popup.html') };
  return new Promise((resolve) => onMessageHandler(msg, sender, resolve));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitState(pred, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred(store.state)) return store.state;
    await sleep(30);
  }
  throw new Error('timeout waiting for state');
}

(async () => {
  // ========== Сценарий 1: пользователь вошёл ==========
  loadBackground(makeFetch({ auth: true }));
  let st = await waitState(s => s && s.lastCheck > 0);

  assert.strictEqual(st.authStatus, true, 'authStatus');
  assert.strictEqual(st.totalUnread, 2, 'непрочитанные без спама/корзины = 2, получено ' + st.totalUnread);
  assert.strictEqual(badge.text, '2', 'badge');
  const acc = st.accounts['user@mail.ru'];
  assert.ok(acc, 'аккаунт создан');
  assert.strictEqual(acc.messages.length, 2, 'спам-письмо отфильтровано');
  assert.ok(!acc.messages.some(m => m.id === '666'), 'письмо из спама исключено');
  const m1 = acc.messages.find(m => m.id === '101');
  assert.strictEqual(m1.fromName, 'Магазин');
  assert.strictEqual(m1.avatar, 'https://e.mail.ru/avatar1.png', 'протокол аватара исправлен');
  assert.ok(m1.date > 1e12, 'дата в мс');
  const m2 = acc.messages.find(m => m.id === '102');
  assert.strictEqual(m2.subject, 'Встреча завтра — 10:00', 'HTML-сущности декодированы');
  console.log('✓ сценарий 1: вход, счётчик, фильтрация спама, нормализация');

  // первое письмо пришло "заново" — уведомлений при первой инициализации быть не должно
  assert.strictEqual(createdNotifs.length, 0, 'при первой проверке уведомлений нет');

  // ========== имитируем новое письмо и повторную проверку ==========
  messagesBody = () => MESSAGES.concat([{
    id: '103', folder: '0', date: Math.floor(Date.now() / 1000), subject: 'Новое письмо',
    snippet: 'свежее', flags: { unread: true },
    correspondents: { from: [{ name: 'Анна', email: 'anna@mail.ru' }] }
  }]);
  FOLDERS[0].messages_unread = 3;
  await sendBg({ type: 'refresh' });
  st = store.state;
  assert.strictEqual(st.totalUnread, 3, 'счётчик вырос до 3');
  assert.strictEqual(createdNotifs.length, 1, 'уведомление о новом письме создано');
  assert.strictEqual(createdNotifs[0].opt.title, 'Анна · user@mail.ru');
  assert.ok(createdNotifs[0].opt.contextMessage.includes('user@mail.ru'), 'баннер называет ящик');
  assert.strictEqual(createdNotifs[0].opt.silent, true, 'native баннер беззвучен, собственный сигнал проверяет notify regression');
  assert.strictEqual(createdNotifs[0].opt.message, 'Новое письмо');
  assert.ok(createdNotifs[0].opt.buttons && createdNotifs[0].opt.buttons.length === 2, 'кнопки в уведомлении');
  console.log('✓ сценарий 2: уведомление только о новом письме');

  // ========== «прочитано» через попап ==========
  let resp = await sendBg({ type: 'markRead', email: 'user@mail.ru', msgId: '103' });
  assert.strictEqual(resp.ok, true, 'markRead ok');
  assert.strictEqual(marksCalled, 1, 'вызван threads/marks');
  st = store.state;
  assert.strictEqual(st.totalUnread, 2, 'счётчик уменьшился');
  assert.ok(!st.accounts['user@mail.ru'].messages.some(m => m.id === '103'));
  console.log('✓ сценарий 3: отметка «прочитано»');

  // ========== «удалить» ==========
  resp = await sendBg({ type: 'trash', email: 'user@mail.ru', msgId: '101' });
  assert.strictEqual(resp.ok, true, 'trash ok');
  assert.strictEqual(moveCalled, 1, 'вызван threads/move');
  st = store.state;
  assert.strictEqual(st.totalUnread, 1);
  console.log('✓ сценарий 4: удаление в корзину');

  // ========== «прочитать все» ==========
  messagesBody = () => [];
  FOLDERS[0].messages_unread = 0;
  resp = await sendBg({ type: 'markAllRead', email: 'user@mail.ru' });
  assert.strictEqual(resp.ok, true);
  st = store.state;
  assert.strictEqual(st.totalUnread, 0, 'все прочитаны');
  assert.strictEqual(badge.text, '', 'значок пустой');
  console.log('✓ сценарий 5: прочитать все');

  // ========== Сценарий 6: пользователь не вошёл ==========
  loadBackground(makeFetch({ auth: false }));
  st = await waitState(s => s && s.lastCheck > 0);
  assert.strictEqual(st.authStatus, false, 'noauth');
  assert.strictEqual(badge.text, '?', 'badge = ?');
  assert.ok(badge.title.includes('войдите'), 'подсказка о входе');
  console.log('✓ сценарий 6: не вошёл → значок «?»');

  // ========== Сценарий 7: сеть недоступна ==========
  loadBackground(async () => { throw new Error('network down'); });
  st = await waitState(s => s && s.lastCheck > 0);
  assert.ok(st.lastError && st.lastError.includes('Нет связи'), 'сообщение об ошибке сети');
  console.log('✓ сценарий 7: ошибка сети переживает');

  // ========== Сценарий 8: эндпоинт писем лежит — кэш не затирается ==========
  messagesBody = () => MESSAGES;
  FOLDERS[0].messages_unread = 2;
  loadBackground(makeFetch({ auth: true }));
  st = await waitState(s => s && s.lastCheck > 0);
  messagesFail = true;
  FOLDERS[0].messages_unread = 7;
  await sendBg({ type: 'refresh' });
  st = store.state;
  const acc8 = st.accounts['user@mail.ru'];
  assert.ok(acc8, 'аккаунт на месте');
  assert.strictEqual(acc8.messages.length, 2, 'при сбое список писем сохраняется');
  assert.strictEqual(acc8.count, 7, 'счётчик из папок');
  assert.strictEqual(createdNotifs.length, 0, 'ложных уведомлений нет');
  assert.ok(acc8.error && acc8.error.includes('список писем'), 'ошибка аккаунта записана');
  console.log('✓ сценарий 8: эндпоинт писем лежит — кэш и счётчик живы');

  // ========== Сценарий 9: пустой список NaviData не стирает аккаунты ==========
  messagesFail = false;
  naviEmpty = true;
  await sendBg({ type: 'refresh' });
  st = store.state;
  assert.ok(st.accounts['user@mail.ru'], 'аккаунт не удалён при пустом списке ящиков');
  console.log('✓ сценарий 9: пустой NaviData — не выход из ящиков');

  // ========== Сценарий 10: сообщения от чужих страниц отклоняются ==========
  const badResp = await new Promise((resolve) =>
    onMessageHandler({ type: 'getState' }, { url: 'https://evil.example/page' }, resolve));
  assert.strictEqual(badResp.ok, false, 'чужой sender отклонён');
  assert.ok(String(badResp.error).includes('untrusted'), 'причина: untrusted sender');
  const badReset = await new Promise((resolve) =>
    onMessageHandler({ type: 'resetState' }, { url: 'https://evil.example/page' }, resolve));
  assert.strictEqual(badReset.ok, false, 'опасные команды чужому sender не выполняются');
  console.log('✓ сценарий 10: untrusted sender отклоняется');

  // ========== Сценарий 11: токен живёт только в session-памяти ==========
  assert.ok(!JSON.stringify(store.state || {}).includes('TOKEN123'), 'токена нет в local state');
  assert.ok(!JSON.stringify(store.settings || {}).includes('TOKEN123'), 'токена нет в settings');
  assert.ok(JSON.stringify(sess.tokens || {}).includes('TOKEN123'), 'токен в session-хранилище');
  console.log('✓ сценарий 11: токен не попадает на диск');

  // ========== Сценарий 12: «Открыть почту» — прямая ссылка на веб-страницу ==========
  createdTabs.length = 0;
  await sendBg({ type: 'openInbox', email: 'user@mail.ru' });
  assert.strictEqual(createdTabs[createdTabs.length - 1], 'https://e.mail.ru/inbox/',
    'один ящик — прямая ссылка на страницу почты');
  // второй ящик → переключение через auth-обёртку
  store.state.accounts['second@mail.ru'] = { messages: [], count: 0, folders: [] };
  await sendBg({ type: 'openInbox', email: 'user@mail.ru' });
  const last = createdTabs[createdTabs.length - 1];
  assert.ok(last.startsWith('https://auth.mail.ru/cgi-bin/auth'), 'несколько ящиков — auth-обёртка');
  assert.ok(last.includes(encodeURIComponent('user@mail.ru')), 'обёртка содержит Login нужного ящика');
  console.log('✓ сценарий 12: страница почты открывается прямой ссылкой');

  // ========== Сценарий 13: «только счётчик» обновляет данные без всплывающего повтора ==========
  messagesFail = false;
  naviEmpty = false;
  messagesBody = () => MESSAGES;
  FOLDERS[0].messages_unread = 2;
  loadBackground(makeFetch({ auth: true }));
  st = await waitState(s => s && s.lastCheck > 0);
  store.settings = Object.assign({}, store.settings, { accountNotificationModes: { 'user@mail.ru': 'counter' } });
  messagesBody = () => MESSAGES.concat([{
    id: '104', folder: '0', date: Math.floor(Date.now() / 1000), subject: 'Только счётчик',
    snippet: 'counter mode', flags: { unread: true },
    correspondents: { from: [{ name: 'Борис', email: 'boris@mail.ru' }] }
  }]);
  FOLDERS[0].messages_unread = 3;
  await sendBg({ type: 'refresh' });
  st = store.state;
  assert.strictEqual(st.totalUnread, 3, 'badge count updates in counter-only mode');
  assert.ok(st.accounts['user@mail.ru'].messages.some(m => m.id === '104'), 'message remains in the popup list');
  assert.strictEqual(createdNotifs.length, 0, 'counter mode emits no native notification');
  await sendBg({ type: 'refresh' });
  assert.strictEqual(createdNotifs.length, 0, 'the counter-only message is not replayed later');
  console.log('✓ сценарий 13: counter mode keeps badge/list fresh without replay');

  // ========== Сценарий 14: HTML-сущности декодируются ровно один раз ==========
  assert.strictEqual(decodeEntities('a &gt; b'), 'a > b', '&gt; раскодирован');
  assert.strictEqual(decodeEntities('&amp;lt;x&amp;gt;'), '&lt;x&gt;', 'без двойного декодирования');
  assert.strictEqual(decodeEntities('&#128512; &#x41; &#99999999;'), '😀 A &#99999999;', 'код-пойнты и мусор без падения');
  console.log('✓ сценарий 14: декодирование HTML-сущностей');

  // ========== Сценарий 15: «Прочитано» во время фоновой проверки не теряется ==========
  messagesBody = () => MESSAGES;
  FOLDERS[0].messages_unread = 2;
  loadBackground(makeFetch({ auth: true }));
  st = await waitState(s => s && s.lastCheck > 0);
  unreadDelayMs = 200;
  const lastCheck15 = st.lastCheck;
  const refresh15 = sendBg({ type: 'refresh' });
  await sleep(50); // проверка уже получила снимок со 101, но ещё не сохранила
  const mark15 = await sendBg({ type: 'markRead', email: 'user@mail.ru', msgId: '101' });
  assert.strictEqual(mark15.ok, true, 'markRead ok');
  await refresh15;
  await waitState(s => s.lastCheck > lastCheck15);
  assert.ok(!store.state.accounts['user@mail.ru'].messages.some(m => m.id === '101'),
    'прочитанное письмо не возвращается после параллельной проверки');
  unreadDelayMs = 0;
  console.log('✓ сценарий 15: нет гонки между проверкой и «Прочитано»');

  // ========== Сценарий 16: пробуждение service worker не сбрасывает таймер ==========
  messagesBody = () => MESSAGES;
  loadBackground(makeFetch({ auth: true }));
  st = await waitState(s => s && s.lastCheck > 0);
  assert.ok(alarms['mailru-check'], 'alarm создан');
  const savedSettings = store.settings;
  const savedState = store.state;
  loadBackground(makeFetch({ auth: true }), { keepAlarms: true }); // «проснулся» с тем же alarm
  store.settings = savedSettings;
  store.state = savedState;
  await sleep(100);
  assert.strictEqual(alarmOps, 0, 'существующий alarm с тем же периодом не пересоздаётся');
  await sendBg({ type: 'saveSettings', settings: { intervalMinutes: 5 } });
  assert.strictEqual(alarms['mailru-check'].periodInMinutes, 5, 'смена интервала применяется');
  console.log('✓ сценарий 16: alarm не сбрасывается при пробуждении');

  // ========== Сценарий 17: один звук на всю проверку, даже для нескольких ящиков ==========
  messagesBody = () => MESSAGES;
  FOLDERS[0].messages_unread = 2;
  loadBackground(makeFetch({ auth: true }));
  await waitState(s => s && s.lastCheck > 0);
  naviList = ['user@mail.ru', 'second@mail.ru'];
  await sendBg({ type: 'refresh' });
  messagesBody = () => MESSAGES.concat([{
    id: '105', folder: '0', date: Math.floor(Date.now() / 1000), subject: 'Сразу в два ящика',
    snippet: '', flags: { unread: true }, correspondents: { from: [{ name: 'Вера', email: 'vera@mail.ru' }] }
  }]);
  sentMessages = [];
  await sendBg({ type: 'refresh' });
  assert.strictEqual(createdNotifs.filter(n => n.opt.message === 'Сразу в два ящика').length, 2, 'уведомление в каждом ящике');
  assert.strictEqual(sentMessages.filter(m => m.type === 'playSound').length, 1, 'звук один раз за проверку');
  console.log('✓ сценарий 17: один звуковой сигнал на проверку');


  // ========== Сценарий 18: открытое письмо не уведомляет повторно ==========
  messagesBody = () => MESSAGES;
  FOLDERS[0].messages_unread = 2;
  loadBackground(makeFetch({ auth: true }));
  await waitState(s => s && s.lastCheck > 0);
  await sendBg({ type: 'openMessage', email: 'user@mail.ru', msgId: '101' });
  await waitState(s => !s.accounts['user@mail.ru'].messages.some(m => m.id === '101'));
  await sendBg({ type: 'refresh' }); // mail.ru ещё не успел отметить 101 прочитанным
  assert.strictEqual(createdNotifs.length, 0, 'нет повторного уведомления об открытом письме');
  assert.ok(store.state.accounts['user@mail.ru'].messages.some(m => m.id === '101'),
    'письмо, всё ещё непрочитанное на сервере, снова видно в списке');
  messagesBody = () => MESSAGES.concat([{
    id: '106', folder: '0', date: Math.floor(Date.now() / 1000), subject: 'Настоящее новое',
    snippet: '', flags: { unread: true }, correspondents: { from: [{ name: 'Олег', email: 'oleg@mail.ru' }] }
  }]);
  await sendBg({ type: 'refresh' });
  assert.strictEqual(createdNotifs.length, 1, 'новое письмо уведомляет как обычно');
  assert.strictEqual(createdNotifs[0].opt.message, 'Настоящее новое');
  console.log('✓ сценарий 18: нет повторного уведомления после «Открыть»');

  console.log('\nВСЕ ТЕСТЫ ПРОЙДЕНЫ ✔');
})().catch(e => { console.error('ТЕСТ ПРОВАЛЕН:', e.message); process.exit(1); });
