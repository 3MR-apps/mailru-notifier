'use strict';

/* ======= Mail.ru Нотификатор — страница настроек ======= */

const $ = (id) => document.getElementById(id);
let settingsDraft = null;
let settingsSaveQueue = Promise.resolve();

const SETTING_KEYS = [
  'notifyEnabled',
  'perMessageNotifications',
  'notificationButtons',
  'soundEnabled',
  'notificationMode',
  'excludeSpamTrash'
];

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false });
    });
  });
}

function toast(text) {
  const t = $('saved-toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1400);
}

function collectSettings() {
  const s = { intervalMinutes: parseInt($('interval').value, 10) || 2 };
  for (const k of SETTING_KEYS) s[k] = k === 'notificationMode' ? $('notificationMode').value : $(k).checked;
  s.accountNotificationModes = Object.assign({}, settingsDraft && settingsDraft.accountNotificationModes || {});
  return s;
}

function applySettings(s) {
  settingsDraft = Object.assign({}, s || {}, { accountNotificationModes: Object.assign({}, s && s.accountNotificationModes || {}) });
  const sel = $('interval');
  const v = String(s.intervalMinutes || 2);
  if (!sel.querySelector(`option[value="${v}"]`)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `каждые ${v} мин`;
    sel.appendChild(o);
  }
  sel.value = v;
  for (const k of SETTING_KEYS) { if (k === 'notificationMode') $('notificationMode').value = s[k] === 'native' ? 'native' : 'window'; else $(k).checked = !!s[k]; }
}

function renderAccountPreferences(state, settings) {
  const root = $('account-preferences');
  if (!root) return;
  root.replaceChildren();
  const accounts = Object.keys(state && state.accounts || {}).sort((a, b) => a.localeCompare(b));
  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Пока нет подключённых ящиков.';
    root.appendChild(empty);
    return;
  }
  const modes = Object.assign({}, settings && settings.accountNotificationModes || {});
  for (const email of accounts) {
    const row = document.createElement('div');
    row.className = 'row account-pref-row';
    const label = document.createElement('div');
    label.className = 'label account-pref-email';
    label.textContent = email;
    const select = document.createElement('select');
    select.dataset.email = email;
    select.setAttribute('aria-label', 'Уведомления для ' + email);
    for (const [value, title] of [['inherit', 'По общим настройкам'], ['sound', 'Со звуком'], ['silent', 'Без звука'], ['counter', 'Только счётчик']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = title;
      select.appendChild(option);
    }
    select.value = ['inherit', 'sound', 'silent', 'counter'].includes(modes[email]) ? modes[email] : 'inherit';
    select.addEventListener('change', async () => {
      if (!settingsDraft) settingsDraft = {};
      if (!settingsDraft.accountNotificationModes) settingsDraft.accountNotificationModes = {};
      if (select.value === 'inherit') delete settingsDraft.accountNotificationModes[email];
      else settingsDraft.accountNotificationModes[email] = select.value;
      await save(false);
    });
    row.append(label, select);
    root.appendChild(row);
  }
}

function renderStatus(state) {
  if (!state) return;

  const auth = $('st-auth');
  if (state.authStatus === true) { auth.textContent = 'выполнен ✓'; auth.className = 'ok'; }
  else if (state.authStatus === false) { auth.textContent = 'не выполнен — войдите в mail.ru в браузере'; auth.className = 'bad'; }
  else { auth.textContent = 'ещё не проверялось'; auth.className = 'dim'; }

  $('st-check').textContent = state.lastCheck
    ? new Date(state.lastCheck).toLocaleString('ru-RU')
    : '—';

  $('st-unread').textContent = String(state.totalUnread || 0);

  const ul = $('st-accounts');
  const emails = Object.keys(state.accounts || {});
  ul.innerHTML = '';
  if (!emails.length) {
    const li = document.createElement('li');
    li.className = 'dim';
    li.textContent = 'нет данных';
    ul.appendChild(li);
  } else {
    for (const email of emails) {
      const acc = state.accounts[email] || {};
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = email;
      const right = document.createElement('span');
      right.className = acc.error ? 'bad' : 'dim';
      right.textContent = acc.error || `непрочитанных: ${acc.count || 0}`;
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    }
  }

  const delivery = $('st-notif');
  if (delivery) { delivery.textContent = state.notificationError ? 'Ошибка уведомления: ' + state.notificationError : ''; delivery.classList.toggle('hidden', !state.notificationError); }

  const err = $('st-error');
  if (state.lastError) {
    err.textContent = 'Ошибка: ' + state.lastError;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }
}

async function save(silent) {
  const settings = collectSettings();
  const pending = settingsSaveQueue.then(() => send({ type: 'saveSettings', settings }));
  settingsSaveQueue = pending.then((resp) => resp, (error) => ({ ok: false, error: String(error && error.message || error) }));
  const resp = await pending;
  if (resp.ok) {
    const currentModes = Object.assign({}, settingsDraft && settingsDraft.accountNotificationModes || settings.accountNotificationModes || {});
    settingsDraft = Object.assign({}, settingsDraft || {}, resp.settings || settings);
    settingsDraft.accountNotificationModes = currentModes;
  }
  if (!silent) toast(resp.ok ? 'Сохранено' : 'Не удалось сохранить');
  return resp;
}

function disableSettingsInputs(disabled) {
  $('interval').disabled = disabled;
  for (const key of SETTING_KEYS) $(key).disabled = disabled;
  for (const select of $('account-preferences').querySelectorAll('select')) select.disabled = disabled;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('st-version').textContent = 'v' + chrome.runtime.getManifest().version;

  // загрузка текущих значений
  const resp = await send({ type: 'getState' });
  if (resp.ok) {
    applySettings(resp.settings || {});
    renderStatus(resp.state);
    renderAccountPreferences(resp.state, settingsDraft);
  }

  // автосохранение при изменении
  $('interval').addEventListener('change', () => save(false));
  for (const k of SETTING_KEYS) $(k).addEventListener('change', () => save(false));

  $('btn-check').addEventListener('click', async () => {
    $('btn-check').disabled = true;
    $('btn-check').textContent = 'Проверяем…';
    await send({ type: 'refresh' });
    const r = await send({ type: 'getState' });
    if (r.ok) { renderStatus(r.state); renderAccountPreferences(r.state, settingsDraft); }
    $('btn-check').disabled = false;
    $('btn-check').textContent = 'Проверить сейчас';
  });

  $('btn-open-mail').addEventListener('click', () => send({ type: 'openInbox' }));

  $('btn-reset-order').addEventListener('click', async () => {
    await chrome.storage.local.remove('accountOrder');
    toast('Порядок ящиков сброшен');
  });

  $('btn-test-notif').addEventListener('click', async () => {
    const button = $('btn-test-notif');
    const status = $('st-notif');
    button.disabled = true;
    disableSettingsInputs(true);
    try {
      const saveResult = await save(true);
      if (!saveResult.ok) {
        if (status) { status.textContent = 'Тест не отправлен: не удалось сохранить настройки (' + (saveResult.error || 'неизвестная ошибка') + ').'; status.className = 'note bad'; }
        return;
      }
      const r = await send({ type: 'testNotification' });
      const mode = r.notificationMode || r.result && r.result.notificationMode;
      const accepted = mode === 'native'
        ? 'Chrome принял запрос (' + (r.result && r.result.permissionLevel || 'разрешение неизвестно') + '). Это не подтверждает фактический показ баннера; если его не видно, проверьте уведомления Windows и режим «Не беспокоить». '
        : mode === 'window' ? 'Окно расширения создано.' : 'Chrome принял запрос, способ доставки не определён.';
      if (status) { status.textContent = r.ok ? accepted : 'Ошибка доставки: ' + (r.error || 'неизвестная ошибка'); status.className = r.ok ? 'note ok' : 'note bad'; }
    } catch (error) {
      if (status) { status.textContent = 'Тест не отправлен: не удалось сохранить настройки (' + String(error && error.message || error) + ').'; status.className = 'note bad'; }
    } finally {
      disableSettingsInputs(false);
      button.disabled = false;
    }
  });

  $('btn-reset').addEventListener('click', async () => {
    if (!confirm('Сбросить сохранённые токены и кэш писем? Расширение запросит данные заново.')) return;
    await send({ type: 'resetState' });
    const r = await send({ type: 'getState' });
    if (r.ok) { renderStatus(r.state); renderAccountPreferences(r.state, settingsDraft); }
    toast('Состояние сброшено');
  });
});
