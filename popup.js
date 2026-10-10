'use strict';

/* ======= Mail.ru Нотификатор - 3MR — popup =======
 * Список писем по ящикам: каждый ящик — сворачиваемая секция
 * (шапка ящика + его письма), как в Checker Plus.
 * Состояние «свёрнуто» хранится в chrome.storage.local.collapsedAccounts.
 */

let state = null;
let settings = null;
let refreshing = false;
let sectionsBuilt = false;
let collapsed = {};      // email -> true
let accountOrder = [];   // ручной порядок ящиков (email[])
let dragCtx = null;        // активное перетаскивание секции
let pendingRender = false; // отложенный рендер на время перетаскивания

const $ = (id) => document.getElementById(id);

const AVATAR_COLORS = [
  '#f25022', '#7fba00', '#00a4ef', '#ffb900', '#8764b8',
  '#e3008c', '#008272', '#ca5010', '#005ff9', '#c239b3'
];

function avatarColor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'вчера';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'нет ответа' });
      }
    });
  });
}

/* ---------- иконки ---------- */

const SVG = (inner, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const I_CHEVRON = SVG('<polyline points="6 9 12 15 18 9"/>');
const I_ENVELOPE = SVG('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>');
const I_CHECK = SVG('<polyline points="20 6 9 17 4 12"/>');
const I_CHECK_ALL = SVG('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>');
const I_EXT = SVG('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>');
const I_TRASH = SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>');
const I_CLIP = SVG('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>', 'paperclip');
const I_GRIP = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
const I_CHEVS_DOWN = SVG('<polyline points="7 6 12 11 17 6"/><polyline points="7 13 12 18 17 13"/>');
const I_CHEVS_UP = SVG('<polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/>');

/* ---------- данные ---------- */

function accountList() {
  if (!state || !state.accounts) return [];
  return Object.keys(state.accounts)
    .map((email) => ({ email, acc: state.accounts[email] }))
    .filter((x) => x.acc && Array.isArray(x.acc.messages));
}

function totalMessages(accounts) {
  return accounts.reduce((s, a) => s + (a.acc.messages || []).length, 0);
}

function totalUnread(accounts) {
  return accounts.reduce((s, a) => s + (a.acc.count || 0), 0);
}

/* ---------- сворачивание секций ---------- */

async function loadCollapsed() {
  const r = await chrome.storage.local.get('collapsedAccounts');
  collapsed = (r && r.collapsedAccounts) || {};
}

function setCollapsed(email, value) {
  collapsed[email] = value;
  chrome.storage.local.set({ collapsedAccounts: collapsed });
}

/* ---------- ручной порядок ящиков ---------- */

async function loadOrder() {
  const r = await chrome.storage.local.get('accountOrder');
  accountOrder = (r && Array.isArray(r.accountOrder)) ? r.accountOrder : [];
}

function sortedAccounts(accounts) {
  const idx = new Map(accountOrder.map((e, i) => [e, i]));
  return accounts.slice().sort((a, b) => {
    const ia = idx.has(a.email) ? idx.get(a.email) : Number.MAX_SAFE_INTEGER;
    const ib = idx.has(b.email) ? idx.get(b.email) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.email.localeCompare(b.email);
  });
}

function persistOrderFromDom() {
  const root = $('sections');
  accountOrder = Array.from(root.children)
    .filter((el) => el.classList.contains('acct'))
    .map((el) => el.dataset.email);
  chrome.storage.local.set({ accountOrder });
}

function getAfterElement(container, y) {
  let closest = null;
  for (const el of container.querySelectorAll('.acct:not(.dragging)')) {
    const box = el.getBoundingClientRect();
    const mid = box.top + box.height / 2;
    if (y < mid && (closest === null || mid < closest.mid)) closest = { el, mid };
  }
  return closest ? closest.el : null;
}

/* ---------- перетаскивание секций (pointer events) ----------
 * HTML5 drag&drop в попапе расширения ведёт себя нестабильно,
 * поэтому используем мышиные события: надёжно и управляемо. */

function initSectionDrag(sec, grip) {
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragCtx = { sec, root: $('sections') };
    sec.classList.add('dragging');
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd, { once: true });
  });
}

function onDragMove(e) {
  if (!dragCtx) return;
  const root = dragCtx.root;

  // автопрокрутка списка у краёв
  const rb = root.getBoundingClientRect();
  if (e.clientY < rb.top + 26) root.scrollTop -= 10;
  else if (e.clientY > rb.bottom - 26) root.scrollTop += 10;

  const after = getAfterElement(root, e.clientY);
  if (after == null) {
    if (root.lastElementChild !== dragCtx.sec) root.appendChild(dragCtx.sec);
  } else if (after !== dragCtx.sec) {
    root.insertBefore(dragCtx.sec, after);
  }
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  if (!dragCtx) return;
  dragCtx.sec.classList.remove('dragging');
  persistOrderFromDom();
  dragCtx = null;
  if (pendingRender) {
    pendingRender = false;
    render();
  }
}

/* ---------- рендер ---------- */

function showView(view) {
  for (const p of ['pane-loading', 'pane-login', 'pane-error', 'pane-empty']) {
    $(p).classList.toggle('hidden', p !== view);
  }
  $('sections').classList.toggle('hidden', view !== 'sections');
}

function render() {
  if (dragCtx) { pendingRender = true; return; } // не перерисовываем список во время перетаскивания
  if (!state) return;

  const accounts = accountList();
  const unread = totalUnread(accounts);
  const msgs = totalMessages(accounts);

  // подзаголовок
  if (state.authStatus === false) {
    $('header-subtitle').textContent = 'нужен вход в mail.ru';
  } else if (!accounts.length) {
    $('header-subtitle').textContent = state.lastError || 'нет данных';
  } else {
    const boxes = `${accounts.length} ${plural(accounts.length, 'ящик', 'ящика', 'ящиков')}`;
    $('header-subtitle').textContent = unread > 0
      ? `${unread} ${plural(unread, 'непрочитанное письмо', 'непрочитанных письма', 'непрочитанных писем')} · ${boxes}`
      : `всё прочитано · ${boxes}`;
  }

  // выбор представления
  if (state.authStatus === false) {
    showView('pane-login');
  } else if (!accounts.length) {
    if (state.lastError) {
      $('error-text').textContent = state.lastError;
      showView('pane-error');
    } else if (!refreshing && state.authStatus === true) {
      $('empty-hint').textContent = 'Mail.ru не вернул список ящиков. Обновите или откройте почту в браузере.';
      showView('pane-empty');
    } else {
      showView('pane-loading');
    }
  } else if (refreshing && !sectionsBuilt) {
    showView('pane-loading');
  } else {
    showView('sections');
    renderSections(accounts);
    sectionsBuilt = true;
  }

  $('btn-mark-all').disabled = msgs === 0 || refreshing;

  // кнопка «свернуть/развернуть все»
  const anyExpanded = accounts.some((a) => !collapsed[a.email]);
  const bca = $('btn-collapse-all');
  bca.disabled = accounts.length === 0;
  bca.title = anyExpanded ? 'Свернуть все ящики' : 'Развернуть все ящики';
  bca.innerHTML = anyExpanded ? I_CHEVS_DOWN : I_CHEVS_UP;

  $('updated').textContent = (state.lastCheck
    ? `Обновлено в ${new Date(state.lastCheck).toLocaleTimeString('ru-RU')}`
    : (state.lastError || 'ещё не проверялось'))
    + ' · v' + chrome.runtime.getManifest().version;
}

/* ---------- секции ящиков ---------- */

function renderSections(accounts) {
  const root = $('sections');
  root.innerHTML = '';

  for (const { email, acc } of sortedAccounts(accounts)) {
    const isCollapsed = !!collapsed[email];
    const msgs = (acc.messages || []).slice().sort((a, b) => (b.date || 0) - (a.date || 0));

    const sec = document.createElement('section');
    sec.className = 'acct' + (isCollapsed ? ' collapsed' : '');
    sec.dataset.email = email;

    // --- шапка ящика ---
    const head = document.createElement('header');
    head.className = 'acct-head';
    const sub = acc.error
      ? acc.error
      : (acc.count > 0
        ? `${acc.count} ${plural(acc.count, 'непрочитанное', 'непрочитанных', 'непрочитанных')}`
        : 'нет непрочитанных');
    head.innerHTML = `
      <span class="acct-grip" title="Перетащите, чтобы изменить порядок ящиков">${I_GRIP}</span>
      <button class="acct-toggle" title="${isCollapsed ? 'Развернуть ящик' : 'Свернуть ящик'}">${I_CHEVRON}</button>
      <div class="acct-ico">${I_ENVELOPE}</div>
      <div class="acct-info">
        <div class="acct-email" title="${esc(email)}">${esc(email)}</div>
        <div class="acct-sub${acc.error ? ' err' : ''}">${esc(sub)}</div>
      </div>
      <div class="acct-actions"><button class="icon-btn sm a-compose" title="Написать письмо">✎</button>
        <button class="icon-btn sm a-mark" title="Прочитать все в этом ящике">${I_CHECK_ALL}</button>
        <button class="icon-btn sm a-open" title="Открыть страницу этого ящика">${I_EXT}</button>
      </div>`;

    const composeBtn = head.querySelector('.a-compose');
    composeBtn.title = 'Написать письмо с ' + email;
    composeBtn.setAttribute('aria-label', composeBtn.title);

    head.addEventListener('click', (e) => {
      if (e.target.closest('.acct-actions') || e.target.closest('.acct-grip')) return;
      setCollapsed(email, !isCollapsed);
      render();
    });

    // --- перетаскивание секции за ручку (pointer events) ---
    initSectionDrag(sec, head.querySelector('.acct-grip'));

    // двойной клик по шапке — открыть страницу этого ящика
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('.acct-actions') || e.target.closest('.acct-grip')) return;
      send({ type: 'openInbox', email });
      window.close();
    });

    head.querySelector('.a-mark').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      await send({ type: 'markAllRead', email });
      const r = await send({ type: 'refresh' });
      if (r.ok && r.state) { state = r.state; render(); }
      else btn.disabled = false;
    });

    head.querySelector('.a-open').addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ type: 'openInbox', email });
      window.close();
    });

    head.querySelector('.a-compose').addEventListener('click', async (e) => {
      e.stopPropagation();
      await send({ type: 'openCompose', email });
      window.close();
    });

    sec.appendChild(head);

    // --- тело: письма ящика ---
    const body = document.createElement('div');
    body.className = 'acct-body';
    if (msgs.length) {
      const ul = document.createElement('ul');
      ul.className = 'letters';
      for (const m of msgs) ul.appendChild(buildLetter(email, m));
      body.appendChild(ul);
    } else {
      const empty = document.createElement('div');
      empty.className = 'acct-empty';
      empty.textContent = acc.error ? ' ' : 'Непрочитанных писем нет';
      body.appendChild(empty);
    }
    sec.appendChild(body);

    root.appendChild(sec);
  }
}

/* ---------- письмо ---------- */

function buildLetter(email, m) {
  const li = document.createElement('li');
  li.className = 'letter';

  const name = m.fromName || m.fromEmail || 'Отправитель';
  const initial = (name.trim()[0] || '?').toUpperCase();
  const color = avatarColor(m.fromEmail || name);

  // аватар (без inline-обработчиков — MV3 CSP их запрещает)
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  const makeInitial = () => {
    const div = document.createElement('div');
    div.className = 'initial';
    div.style.background = color;
    div.textContent = initial;
    return div;
  };
  if (m.avatar) {
    const img = document.createElement('img');
    img.src = m.avatar;
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(makeInitial()));
    avatar.appendChild(img);
  } else {
    avatar.appendChild(makeInitial());
  }
  const dot = document.createElement('div');
  dot.className = 'dot';
  avatar.appendChild(dot);

  li.innerHTML = `
    <div class="lbody">
      <div class="line1">
        <span class="from" title="${esc(m.fromEmail)}">${esc(name)}</span>
        <span class="time">${esc(fmtTime(m.date))}</span>
      </div>
      <div class="subject">${esc(m.subject || '(без темы)')}</div>
      ${m.snippet ? `<div class="snippet">${esc(m.snippet)}</div>` : ''}
      <div class="meta">${m.attach ? I_CLIP : ''}</div>
    </div>
    <div class="tools">
      <button class="tool read" title="Отметить прочитанным">${I_CHECK}</button>
      <button class="tool trash" title="Удалить (в корзину)">${I_TRASH}</button>
    </div>`;
  li.prepend(avatar);

  li.addEventListener('click', async () => {
    await send({ type: 'openMessage', email, msgId: m.id });
    window.close();
  });

  // строка скрывается сразу: ответ может ждать окончания фоновой проверки;
  // при ошибке строка возвращается
  const optimisticAction = async (e, type) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.classList.add('busy');
    li.classList.add('hidden');
    const resp = await send({ type, email, msgId: m.id });
    if (!resp || !resp.ok) {
      li.classList.remove('hidden');
      btn.classList.remove('busy');
    }
  };
  li.querySelector('.tool.read').addEventListener('click', (e) => optimisticAction(e, 'markRead'));
  li.querySelector('.tool.trash').addEventListener('click', (e) => optimisticAction(e, 'trash'));

  return li;
}

/* ---------- действия ---------- */

async function doRefresh() {
  if (refreshing) return;
  refreshing = true;
  $('btn-refresh').classList.add('spinning');
  if (!sectionsBuilt) showView('pane-loading');
  const resp = await send({ type: 'refresh' });
  refreshing = false;
  $('btn-refresh').classList.remove('spinning');
  if (resp.ok && resp.state) {
    state = resp.state;
    settings = resp.settings || settings;
  }
  render();
}

function primaryEmail() {
  return state && state.currentEmail ? state.currentEmail : null;
}

/* ---------- инициализация ---------- */

document.addEventListener('DOMContentLoaded', async () => {
  await loadCollapsed();
  await loadOrder();

  $('btn-refresh').addEventListener('click', doRefresh);
  $('btn-retry').addEventListener('click', doRefresh);
  $('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('btn-login').addEventListener('click', async () => { await send({ type: 'openLogin' }); window.close(); });
  $('btn-open').addEventListener('click', async () => { await send({ type: 'openInbox', email: primaryEmail() }); window.close(); });
  $('btn-open-web').addEventListener('click', async () => { await send({ type: 'openInbox', email: primaryEmail() }); window.close(); });
  $('btn-open-empty').addEventListener('click', async () => { await send({ type: 'openInbox', email: primaryEmail() }); window.close(); });
  $('btn-compose').addEventListener('click', async () => { await send({ type: 'openCompose', email: primaryEmail() }); window.close(); });
  $('btn-mark-all').addEventListener('click', async () => {
    const emails = accountList().map((a) => a.email);
    if (!emails.length) return;
    $('btn-mark-all').disabled = true;
    for (const e of emails) await send({ type: 'markAllRead', email: e });
    const resp = await send({ type: 'refresh' });
    if (resp.ok && resp.state) state = resp.state;
    render();
  });

  // свернуть / развернуть все ящики
  $('btn-collapse-all').addEventListener('click', () => {
    const accounts = accountList();
    if (!accounts.length) return;
    const anyExpanded = accounts.some((a) => !collapsed[a.email]);
    for (const a of accounts) collapsed[a.email] = anyExpanded;
    chrome.storage.local.set({ collapsedAccounts: collapsed });
    render();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'state-updated' && msg.state) {
      state = msg.state;
      settings = msg.settings || settings;
      render();
    }
  });

  const resp = await send({ type: 'getState' });
  if (resp.ok) {
    state = resp.state;
    settings = resp.settings;
    render();
    if (!state.lastCheck || accountList().length === 0) {
      if (state.authStatus !== false) doRefresh();
    }
  } else {
    $('error-text').textContent = 'Не удалось связаться с фоновым модулем: ' + (resp.error || '');
    showView('pane-error');
  }
});
