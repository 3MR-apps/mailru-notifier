'use strict';
/* Тесты выбора звука: встроенные сигналы, свой файл, offscreen-воспроизведение.
 * Запуск: node tools/sound_test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function area(obj) {
  return {
    async get(key) { return key === null ? { ...obj } : (obj[key] === undefined ? {} : { [key]: obj[key] }); },
    async set(values) { Object.assign(obj, values); },
    async remove(keys) { for (const key of [].concat(keys)) delete obj[key]; }
  };
}

// Фоновая часть: util + store + notify в одном контексте с подменой chrome.*
function setupBackground() {
  const local = {};
  const sent = [];
  global.chrome = {
    storage: { local: area(local), session: area({}) },
    runtime: {
      lastError: null,
      getURL: (f) => 'chrome-extension://test/' + f,
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
      sendMessage(message, cb) { sent.push(message); if (cb) cb(); }
    },
    offscreen: { async createDocument() {} }
  };
  vm.runInThisContext(read('lib/util.js'), { filename: 'lib/util.js' });
  vm.runInThisContext(read('lib/store.js'), { filename: 'lib/store.js' });
  vm.runInThisContext(read('lib/notify.js'), { filename: 'lib/notify.js' });
  return { local, sent, sounds: () => sent.filter((m) => m.type === 'playSound') };
}

// Offscreen-документ: свой контекст с подменой Audio
function setupOffscreen({ failDataUrl = false } = {}) {
  const created = [];
  let listener = null;
  class FakeAudio {
    constructor(src) { this.src = src; this.volume = 1; created.push(this); }
    play() {
      if (failDataUrl && this.src.startsWith('data:')) return Promise.reject(new Error('decode failed'));
      return Promise.resolve();
    }
  }
  const ctx = {
    Audio: FakeAudio,
    console,
    chrome: {
      runtime: {
        getURL: (f) => 'chrome-extension://test/' + f,
        onMessage: { addListener(fn) { listener = fn; } }
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(read('offscreen.js'), ctx, { filename: 'offscreen.js' });
  return { created, send: (msg) => listener(msg, {}, () => {}) };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const DATA = 'data:audio/wav;base64,UklGRg==';

(async () => {
  // 1. Шесть встроенных сигналов, у каждого есть файл в пакете
  let h = setupBackground();
  assert.strictEqual(SOUND_PRESETS.length, 6, 'шесть встроенных сигналов');
  assert.strictEqual(SOUND_PRESETS[0].id, 'chime', 'первый — сигнал по умолчанию');
  for (const p of SOUND_PRESETS) {
    assert.ok(p.title && typeof p.title === 'string', 'у сигнала есть название: ' + p.id);
    assert.ok(fs.existsSync(path.join(root, 'sound', p.id + '.wav')), 'есть файл sound/' + p.id + '.wav');
  }
  console.log('✓ 1: шесть встроенных сигналов с файлами');

  // 2. По умолчанию играет «Колокольчик»
  await playNotifySound({ effectiveSoundEnabled: true });
  assert.strictEqual(h.sounds()[0].file, 'chime.wav', 'по умолчанию chime.wav');
  assert.strictEqual(h.sounds()[0].dataUrl, undefined);
  console.log('✓ 2: по умолчанию «Колокольчик»');

  // 3. Выбранный встроенный сигнал
  h = setupBackground();
  await playNotifySound({ effectiveSoundEnabled: true, soundId: 'bell' });
  assert.strictEqual(h.sounds()[0].file, 'bell.wav', 'выбранный сигнал');
  console.log('✓ 3: выбранный встроенный сигнал');

  // 4. Свой файл
  h = setupBackground();
  h.local.customSound = { name: 'my.mp3', type: 'audio/mpeg', size: 10, dataUrl: DATA };
  await playNotifySound({ effectiveSoundEnabled: true, soundId: 'custom' });
  assert.strictEqual(h.sounds()[0].dataUrl, DATA, 'свой файл отправлен на воспроизведение');
  assert.strictEqual(h.sounds()[0].file, 'chime.wav', 'запасной сигнал на случай ошибки');
  console.log('✓ 4: свой звук');

  // 5. «Свой» выбран, но файла нет → стандартный
  h = setupBackground();
  await playNotifySound({ effectiveSoundEnabled: true, soundId: 'custom' });
  assert.strictEqual(h.sounds()[0].file, 'chime.wav');
  assert.strictEqual(h.sounds()[0].dataUrl, undefined, 'без файла — стандартный сигнал');
  console.log('✓ 5: без своего файла — стандартный');

  // 6. Неизвестный id сигнала не сохраняется и не играет
  h = setupBackground();
  let s = await saveSettings({ soundId: '../../evil' });
  assert.strictEqual(s.soundId, 'chime', 'неизвестный id заменён на chime');
  s = await saveSettings({ soundId: 'trio' });
  assert.strictEqual(s.soundId, 'trio');
  s = await saveSettings({ soundId: 'custom' });
  assert.strictEqual(s.soundId, 'custom');
  await playNotifySound({ effectiveSoundEnabled: true, soundId: '../x' });
  assert.strictEqual(h.sounds()[0].file, 'chime.wav', 'неизвестный id → chime.wav');
  console.log('✓ 6: проверка id сигнала');

  // 7. Звук выключен — ничего не играет
  h = setupBackground();
  await playNotifySound({ effectiveSoundEnabled: false, soundId: 'bell' });
  assert.strictEqual(h.sounds().length, 0, 'звук выключен');
  console.log('✓ 7: выключенный звук');

  // 8. Проверка своего файла
  const ok = { name: 'a.mp3', type: 'audio/mpeg', size: 1000 };
  assert.strictEqual(validateSoundFile(ok), null, 'mp3 подходит');
  assert.strictEqual(validateSoundFile({ name: 'a.wav', type: 'audio/wav', size: 1000 }), null, 'wav подходит');
  assert.strictEqual(validateSoundFile({ name: 'a.ogg', type: 'audio/ogg', size: 1000 }), null, 'ogg подходит');
  assert.strictEqual(validateSoundFile({ name: 'a.wav', type: '', size: 1000 }), null, 'тип по расширению, если браузер не указал');
  assert.ok(validateSoundFile({ name: 'a.mp3', type: 'audio/mpeg', size: 1024 * 1024 + 1 }), 'больше 1 МБ — ошибка');
  assert.ok(validateSoundFile({ name: 'a.exe', type: 'application/x-msdownload', size: 10 }), 'не аудио — ошибка');
  assert.ok(validateSoundFile({ name: 'a.mp3', type: 'audio/mpeg', size: 0 }), 'пустой файл — ошибка');
  assert.ok(validateSoundFile(null), 'нет файла — ошибка');
  console.log('✓ 8: проверка своего файла');

  // 9. Offscreen: встроенный файл, свой звук, защита от чужих адресов
  let o = setupOffscreen();
  o.send({ type: 'playSound', file: 'bell.wav', volume: 0.5 });
  assert.strictEqual(o.created[0].src, 'chrome-extension://test/sound/bell.wav');
  assert.strictEqual(o.created[0].volume, 0.5);
  o.send({ type: 'playSound', file: '../secret.wav' });
  assert.strictEqual(o.created[1].src, 'chrome-extension://test/sound/chime.wav', 'путь с ../ не принимается');
  o.send({ type: 'playSound', dataUrl: DATA, file: 'chime.wav' });
  assert.strictEqual(o.created[2].src, DATA, 'свой звук играет из data:audio');
  o.send({ type: 'playSound', dataUrl: 'https://evil.example/a.mp3', file: 'chime.wav' });
  assert.strictEqual(o.created[3].src, 'chrome-extension://test/sound/chime.wav', 'внешний адрес не играет');
  o.send({ type: 'playSound', dataUrl: 'data:text/html;base64,AAAA', file: 'chime.wav' });
  assert.strictEqual(o.created[4].src, 'chrome-extension://test/sound/chime.wav', 'не аудио — не играет');
  console.log('✓ 9: offscreen проверяет источник звука');

  // 10. Свой файл не воспроизводится → стандартный сигнал
  o = setupOffscreen({ failDataUrl: true });
  o.send({ type: 'playSound', dataUrl: DATA, file: 'chime.wav' });
  await tick();
  assert.strictEqual(o.created.length, 2, 'после ошибки создан запасной звук');
  assert.strictEqual(o.created[1].src, 'chrome-extension://test/sound/chime.wav');
  console.log('✓ 10: запасной сигнал при ошибке своего файла');

  console.log('\nsound tests passed');
})().catch((e) => { console.error('sound test failed:', e.stack || e); process.exitCode = 1; });
