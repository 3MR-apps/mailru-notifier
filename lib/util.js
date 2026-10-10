'use strict';

/* ======= Mail.ru Нотификатор — общие утилиты =======
 * Подключается:
 *  - в service worker через importScripts('lib/util.js');
 *  - в popup через <script src="lib/util.js"></script>;
 *  - в node (smoke-тест) через require().
 */

(function (g) {
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bdquo: '„',
    copy: '©', reg: '®', trade: '™', euro: '€', bull: '•', middot: '·', times: '×'
  };

  // один проход: результат одной сущности не раскодируется повторно (&amp;lt; → &lt;)
  function decodeEntities(str) {
    if (!str) return '';
    return String(str).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
      if (name) {
        const ch = NAMED_ENTITIES[name.toLowerCase()];
        return ch === undefined ? whole : ch;
      }
      const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    });
  }

  function fixUrl(u) {
    if (!u || typeof u !== 'string') return '';
    if (u.startsWith('//')) return 'https:' + u;
    return u;
  }

  // экранирование для вставки в HTML
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- звуки ---------- */

  // встроенные сигналы: файлы sound/<id>.wav создаёт tools/make_sound.py
  const SOUND_PRESETS = [
    { id: 'chime', title: 'Колокольчик' },
    { id: 'drop', title: 'Капля' },
    { id: 'bell', title: 'Звон' },
    { id: 'soft', title: 'Мягкий' },
    { id: 'trio', title: 'Три ноты' },
    { id: 'blip', title: 'Двойной сигнал' }
  ];
  const DEFAULT_SOUND_ID = 'chime';
  const CUSTOM_SOUND_ID = 'custom';
  const MAX_CUSTOM_SOUND_BYTES = 1024 * 1024;
  const CUSTOM_SOUND_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

  function isSoundId(id) {
    return id === CUSTOM_SOUND_ID || SOUND_PRESETS.some((p) => p.id === id);
  }

  // файл встроенного сигнала; неизвестный id — сигнал по умолчанию
  function presetSoundFile(id) {
    const preset = SOUND_PRESETS.find((p) => p.id === id);
    return (preset ? preset.id : DEFAULT_SOUND_ID) + '.wav';
  }

  // MIME-тип своего звука по расширению файла ('' — формат не поддерживается)
  function customSoundMime(name) {
    return CUSTOM_SOUND_TYPES[String(name || '').split('.').pop().toLowerCase()] || '';
  }

  // null — файл подходит, иначе текст ошибки для пользователя
  function validateSoundFile(file) {
    if (!file || !file.name) return 'Файл не выбран';
    const type = String(file.type || '').toLowerCase();
    const allowedTypes = Object.values(CUSTOM_SOUND_TYPES).concat(['audio/mp3', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);
    if (!customSoundMime(file.name) || (type && !allowedTypes.includes(type))) return 'Подходят только файлы MP3, WAV или OGG';
    if (!(file.size > 0)) return 'Файл пустой';
    if (file.size > MAX_CUSTOM_SOUND_BYTES) return 'Файл больше 1 МБ — выберите звук короче';
    return null;
  }

  g.SOUND_PRESETS = SOUND_PRESETS;
  g.DEFAULT_SOUND_ID = DEFAULT_SOUND_ID;
  g.CUSTOM_SOUND_ID = CUSTOM_SOUND_ID;
  g.isSoundId = isSoundId;
  g.presetSoundFile = presetSoundFile;
  g.customSoundMime = customSoundMime;
  g.validateSoundFile = validateSoundFile;
  g.plural = plural;
  g.decodeEntities = decodeEntities;
  g.fixUrl = fixUrl;
  g.esc = esc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
