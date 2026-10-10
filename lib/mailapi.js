'use strict';

/* ======= Mail.ru Нотификатор — веб-API mail.ru (lib/mailapi.js) =======
 * Используются те же эндпоинты, что и веб-клиент e.mail.ru;
 * авторизация — cookies текущей сессии браузера (credentials: 'include').
 */

(function (g) {
  const NAVI_URL = 'https://portal.mail.ru/NaviData?mac=1';
  const API_BASE = 'https://mailru-checker-api.e.mail.ru/api/v1';
  const SDC_URL = 'https://auth.mail.ru/sdc?from=';
  const MARKS_URL = 'https://e.mail.ru/api/v1/threads/marks';
  const MOVE_URL = 'https://e.mail.ru/api/v1/threads/move';

  // служебные папки mail.ru (спам/корзина и т.п.)
  const DEFAULT_EXCLUDED_FOLDERS = ['950', '500000', '500001', '500002'];
  const TRASH_FOLDER_FALLBACK = '500002';
  const SPAM_TRASH_RE = /спам|корзин|мусор|удален|spam|trash|junk/i;
  const TRASH_NAME_RE = /корзин|мусор|удален|trash/i;

  const POST_HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json, text/plain, */*'
  };

  /* ---------- транспорт ---------- */

  async function apiFetch(url, { method = 'GET', body = null, headers = null, timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: headers || undefined,
        credentials: 'include',
        signal: ctrl.signal
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* не JSON */ }
      return { ok: res.ok, status: res.status, text, json, error: null };
    } catch (e) {
      return { ok: false, status: 0, text: '', json: null, error: String((e && e.message) || e) };
    } finally {
      clearTimeout(t);
    }
  }

  function isAuthError(json) {
    return !!json && (json.status === 401 || json.status === 403);
  }

  /* ---------- нормализация ---------- */

  function normalizeMsg(m) {
    if (!m || typeof m !== 'object') return null;
    const id = m.id === undefined || m.id === null ? '' : String(m.id);
    if (!id) return null;
    const from = (m.correspondents && Array.isArray(m.correspondents.from) && m.correspondents.from[0]) || null;
    const av = (from && from.avatars && typeof from.avatars === 'object') ? from.avatars : {};
    let date = Number(m.date) || 0;
    if (date > 0 && date < 1e12) date *= 1000; // секунды -> мс
    return {
      id,
      folder: String(m.folder === undefined || m.folder === null ? '0' : m.folder),
      date,
      subject: decodeEntities(m.subject || '').slice(0, 300),
      snippet: decodeEntities(m.snippet || '').slice(0, 500),
      attach: !!(m.flags && m.flags.attach),
      fromName: decodeEntities((from && from.name) || '').slice(0, 200),
      fromEmail: String((from && from.email) || '').slice(0, 254),
      avatar: safeAvatarUrl(av['50x50'] || av['180x180'] || av['default'] || '')
    };
  }

  // аватары — только https и только с серверов mail.ru: браузер не обращается к чужим сайтам
  const AVATAR_HOST_RE = /(^|\.)(mail\.ru|imgsmail\.ru)$/i;
  function safeAvatarUrl(u) {
    const fixed = fixUrl(u);
    if (!fixed) return '';
    try {
      const parsed = new URL(fixed);
      return parsed.protocol === 'https:' && AVATAR_HOST_RE.test(parsed.hostname) ? fixed : '';
    } catch (e) {
      return '';
    }
  }

  function parseFolders(json) {
    if (!json || json.status !== 200 || !json.body) return null;
    const body = json.body;
    return Array.isArray(body) ? body : Object.values(body);
  }

  function folderName(f) {
    return [f.name, f.title, f.label, f.type].filter(Boolean).join(' ');
  }

  function excludedFolderIds(folders, settings) {
    const set = new Set(DEFAULT_EXCLUDED_FOLDERS);
    if (settings.excludeSpamTrash) {
      for (const f of folders || []) {
        if (SPAM_TRASH_RE.test(folderName(f))) set.add(String(f.id));
      }
    }
    return set;
  }

  function findTrashFolderId(folders) {
    for (const f of folders || []) {
      const name = String(f.name || f.title || f.label || '');
      if (TRASH_NAME_RE.test(name)) return String(f.id);
    }
    return TRASH_FOLDER_FALLBACK;
  }

  /* ---------- эндпоинты ---------- */

  async function fetchNavi() {
    return apiFetch(NAVI_URL);
  }

  // токен API: прямой запрос, при 403 "nosdc" — через редирект auth.mail.ru/sdc
  async function fetchToken(email) {
    const q = `?email=${encodeURIComponent(email)}&x-email=${encodeURIComponent(email)}`;
    const url = API_BASE + '/tokens' + q;
    let r = await apiFetch(url);
    let j = r.json;
    if (j && j.status === 200 && j.body && j.body.token) return j.body.token;
    if (j && j.status === 403 && j.body === 'nosdc') {
      r = await apiFetch(SDC_URL + encodeURIComponent(url));
      j = r.json;
      if (j && j.status === 200 && j.body && j.body.token) return j.body.token;
    }
    return null;
  }

  async function ensureToken(email) {
    const cached = await getToken(email);
    if (cached) return cached;
    const token = await fetchToken(email);
    if (token) await setToken(email, token);
    return token;
  }

  function accountQuery(email, token, limit) {
    return `?email=${encodeURIComponent(email)}&x-email=${encodeURIComponent(email)}` +
      `&token=${encodeURIComponent(token)}&limit=${limit || 100}&last_modified=0`;
  }

  async function fetchFolders(email, token, limit) {
    return apiFetch(API_BASE + '/folders' + accountQuery(email, token, limit));
  }

  async function fetchUnread(email, token, limit) {
    return apiFetch(API_BASE + '/messages/status/unread' + accountQuery(email, token, limit));
  }

  function threadIdOf(msgId, folderId) {
    return `0:${msgId}:${folderId || '0'}`;
  }

  // снять флаг «не прочитано»
  async function apiMarkRead(email, token, msgId, folderId) {
    const threadId = threadIdOf(msgId, folderId);
    const params = new URLSearchParams();
    params.append('marks', JSON.stringify([{ name: 'unread', unset: [threadId], folder: 0 }]));
    params.append('message_id_last', JSON.stringify({ [threadId]: String(msgId) }));
    params.append('email', email);
    params.append('htmlencoded', 'false');
    params.append('token', token);
    return apiFetch(MARKS_URL, { method: 'POST', headers: POST_HEADERS, body: params.toString() });
  }

  // переместить в корзину
  async function apiMoveToTrash(email, token, msgId, folderId, trashId) {
    const threadId = threadIdOf(msgId, folderId);
    const params = new URLSearchParams();
    params.append('ids', JSON.stringify([threadId]));
    params.append('msg_ids', JSON.stringify([{ id: threadId, folder: folderId || '0' }]));
    params.append('folder', trashId);
    params.append('message_id_last', JSON.stringify({ [threadId]: String(msgId) }));
    params.append('email', email);
    params.append('htmlencoded', 'false');
    params.append('token', token);
    return apiFetch(MOVE_URL, { method: 'POST', headers: POST_HEADERS, body: params.toString() });
  }

  g.apiFetch = apiFetch;
  g.isAuthError = isAuthError;
  g.normalizeMsg = normalizeMsg;
  g.parseFolders = parseFolders;
  g.excludedFolderIds = excludedFolderIds;
  g.findTrashFolderId = findTrashFolderId;
  g.fetchNavi = fetchNavi;
  g.fetchToken = fetchToken;
  g.ensureToken = ensureToken;
  g.fetchFolders = fetchFolders;
  g.fetchUnread = fetchUnread;
  g.apiMarkRead = apiMarkRead;
  g.apiMoveToTrash = apiMoveToTrash;
  g.threadIdOf = threadIdOf;
})(typeof globalThis !== 'undefined' ? globalThis : this);
