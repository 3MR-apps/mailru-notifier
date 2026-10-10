'use strict';
/* Тесты страницы настроек: сохранение и операции со звуком.
 * Запуск: node tools/options_test.js
 * options.js выполняется в vm с минимальной подделкой DOM и chrome.*.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function fakeElement(id) {
  const classes = new Set();
  return {
    id, value: '', checked: false, disabled: false, hidden: false, textContent: '', options: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c)
    },
    replaceChildren(...children) { this.options = children; },
    get selectedOptions() { return this.options.filter((o) => o.value === this.value); },
    addEventListener() {},
    querySelectorAll() { return []; },
    appendChild() {}
  };
}

function setup({ saveReply = { ok: true } } = {}) {
  const elements = {};
  const sent = [];
  const local = {};
  const ctx = {
    console, setTimeout, clearTimeout, Promise,
    Option: function Option(text, value) { this.text = text; this.value = value; },
    document: {
      getElementById: (id) => elements[id] || (elements[id] = fakeElement(id)),
      addEventListener() {},
      createElement: () => fakeElement('')
    },
    chrome: {
      runtime: {
        lastError: null,
        getManifest: () => ({ version: 'test' }),
        getURL: (f) => 'chrome-extension://test/' + f,
        sendMessage(msg, cb) {
          sent.push(msg);
          const reply = msg.type === 'saveSettings' ? (typeof saveReply === 'function' ? saveReply(msg) : saveReply) : { ok: true };
          setTimeout(() => cb(reply), 0);
        }
      },
      storage: {
        local: {
          get: async (k) => (local[k] === undefined ? {} : { [k]: local[k] }),
          set: async (o) => { Object.assign(local, o); },
          remove: async (k) => { for (const x of [].concat(k)) delete local[x]; }
        }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(read('lib/util.js'), ctx, { filename: 'lib/util.js' });
  vm.runInContext(read('options.js'), ctx, { filename: 'options.js' });
  const run = (code) => vm.runInContext(code, ctx);
  return { elements, sent, local, run, el: (id) => ctx.document.getElementById(id) };
}

const saves = (h) => h.sent.filter((m) => m.type === 'saveSettings');
const SOUND_CONTROLS = ['soundId', 'btn-sound-preview', 'btn-sound-upload', 'btn-sound-remove'];

(async () => {
  // 1. Пока настройки не загружены, форма не сохраняется
  let h = setup();
  let r = await h.run('save(true)');
  assert.strictEqual(r.ok, false, 'save без настроек отклонён');
  assert.strictEqual(saves(h).length, 0, 'значения по умолчанию не отправлены');
  console.log('✓ 1: форма не сохраняется до загрузки настроек');

  // 2. Ошибка сохранения мелодии: выбор возвращается к сохранённому, статус — ошибка
  h = setup({ saveReply: { ok: false, error: 'test' } });
  h.run(`settingsDraft = { soundId: 'bell', accountNotificationModes: {} };
         customSound = { name: 'my.wav', type: 'audio/wav', size: 10, dataUrl: 'data:audio/wav;base64,AA' };
         renderSoundChoice(CUSTOM_SOUND_ID);`);
  assert.strictEqual(h.el('soundId').value, 'custom');
  await h.run("saveSoundChoice('ok')");
  assert.strictEqual(h.el('soundId').value, 'bell', 'выбор откатан к сохранённому');
  assert.ok(h.el('sound-status').classList.contains('bad'), 'показана ошибка');
  assert.strictEqual(saves(h).length, 1);
  console.log('✓ 2: откат выбора при ошибке сохранения');

  // 3. Одна операция со звуком за раз; блокировка других полей её не снимает
  h = setup();
  h.run(`settingsDraft = { soundId: 'chime', accountNotificationModes: {} }; renderSoundChoice('chime');
         var release; var calls = 0;
         var first = runSoundAction(() => { calls++; return new Promise((res) => { release = res; }); });
         runSoundAction(async () => { calls++; });`);
  assert.strictEqual(h.run('calls'), 1, 'вторая операция при занятом звуке не выполняется');
  for (const id of SOUND_CONTROLS) assert.strictEqual(h.el(id).disabled, true, id + ' выключен во время операции');
  h.run('disableSettingsInputs(true); disableSettingsInputs(false);'); // например, «Тестовое уведомление»
  for (const id of SOUND_CONTROLS) assert.strictEqual(h.el(id).disabled, true, id + ' остаётся выключенным, пока идёт операция со звуком');
  h.run('release()');
  await h.run('first');
  for (const id of SOUND_CONTROLS) assert.strictEqual(h.el(id).disabled, false, id + ' включён после операции');
  h.run('disableSettingsInputs(true)');
  assert.strictEqual(h.el('btn-sound-upload').disabled, true, 'тест уведомления выключает кнопки звука');
  h.run('disableSettingsInputs(false)');
  assert.strictEqual(h.el('btn-sound-upload').disabled, false);
  console.log('✓ 3: блокировка операций со звуком');

  // 4. Режимы ящиков в списке совпадают с теми, что принимает фон
  h = setup();
  assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(ACCOUNT_MODES.map((m) => m.id))')), ['inherit', 'sound', 'silent', 'counter']);
  console.log('✓ 4: единый список режимов ящиков');

  console.log('\noptions tests passed');
})().catch((e) => { console.error('options test failed:', e.stack || e); process.exitCode = 1; });
