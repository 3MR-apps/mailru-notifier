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
    nbsp: ' ', mdash: '—', laquo: '«', raquo: '»'
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

  g.plural = plural;
  g.decodeEntities = decodeEntities;
  g.fixUrl = fixUrl;
  g.esc = esc;
})(typeof globalThis !== 'undefined' ? globalThis : this);
