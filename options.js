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
  const s = { intervalMinutes: parseInt($('interval').value, 10) || 2, soundId: $('soundId').value };
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
  renderSoundChoice(s.soundId);
  for (const k of SETTING_KEYS) { if (k === 'notificationMode') $('notificationMode').value = s[k] === 'native' ? 'native' : 'window'; else $(k).checked = !!s[k]; }
}

/* ---------- мелодия сигнала ---------- */

let customSound = null;   // { name, type, size, dataUrl } из chrome.storage.local
let previewAudio = null;

function soundStatus(text, bad) {
  const el = $('sound-status');
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

// список: встроенные сигналы + «Свой: имя файла», если файл загружен
function renderSoundChoice(soundId) {
  const select = $('soundId');
  const options = SOUND_PRESETS.map((p) => new Option(p.title, p.id));
  if (customSound) options.push(new Option('Свой: ' + customSound.name, CUSTOM_SOUND_ID));
  select.replaceChildren(...options);
  select.value = soundId === CUSTOM_SOUND_ID && !customSound ? DEFAULT_SOUND_ID : (isSoundId(soundId) ? soundId : DEFAULT_SOUND_ID);
  $('btn-sound-remove').hidden = !customSound;
}

let soundBusy = false;

function setSoundBusy(busy) {
  soundBusy = busy;
  for (const id of ['soundId', 'btn-sound-preview', 'btn-sound-upload', 'btn-sound-remove']) $(id).disabled = busy;
}

function previewSound() {
  soundStatus('');
  if (previewAudio) previewAudio.pause();
  const id = $('soundId').value;
  const src = id === CUSTOM_SOUND_ID && customSound
    ? customSound.dataUrl
    : chrome.runtime.getURL('sound/' + presetSoundFile(id));
  previewAudio = new Audio(src);
  previewAudio.volume = 0.8;
  previewAudio.play().catch(() => soundStatus('Не удалось воспроизвести звук', true));
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// true, если браузер смог разобрать звук (иначе файл повреждён или формат не тот)
function canDecode(dataUrl) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const done = (ok) => {
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load(); // освобождает загруженные данные
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 5000);
    audio.addEventListener('loadedmetadata', () => done(true), { once: true });
    audio.addEventListener('error', () => done(false), { once: true });
    audio.src = dataUrl;
  });
}

// Одна операция со звуком за раз: кнопки заблокированы, ошибка показывается в строке статуса.
async function runSoundAction(action) {
  if (soundBusy) return;
  setSoundBusy(true);
  try {
    await action();
  } catch (e) {
    soundStatus('Не получилось: ' + String(e && e.message || e), true);
  } finally {
    setSoundBusy(false);
  }
}

// Сохраняет выбранную мелодию; при ошибке возвращает в списке сохранённый выбор.
async function saveSoundChoice(successText) {
  const resp = await save(true);
  if (!resp.ok) {
    renderSoundChoice(settingsDraft && settingsDraft.soundId);
    soundStatus('Не удалось сохранить выбор мелодии', true);
    return;
  }
  soundStatus(successText);
}

function uploadSound(file) {
  return runSoundAction(async () => {
    const error = validateSoundFile(file);
    if (error) return soundStatus(error, true);
    soundStatus('Загружаем…');
    // тип берём по расширению: браузер может не указать его или указать иначе
    const raw = await readAsDataUrl(file);
    const dataUrl = 'data:' + customSoundMime(file.name) + raw.slice(raw.indexOf(';'));
    if (!(await canDecode(dataUrl))) return soundStatus('Браузер не смог воспроизвести этот файл', true);
    customSound = { name: String(file.name).slice(0, 80), type: customSoundMime(file.name), size: file.size, dataUrl };
    await chrome.storage.local.set({ customSound });
    renderSoundChoice(CUSTOM_SOUND_ID);
    await saveSoundChoice('Свой звук сохранён');
  });
}

function removeCustomSound() {
  return runSoundAction(async () => {
    customSound = null;
    await chrome.storage.local.remove('customSound');
    renderSoundChoice($('soundId').value);
    await saveSoundChoice('Свой звук удалён, выбрана мелодия «' + $('soundId').selectedOptions[0].text + '»');
  });
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
  // без загруженных настроек форма содержит значения по умолчанию — сохранять их нельзя
  if (!settingsDraft) {
    if (!silent) toast('Настройки ещё не загружены');
    return { ok: false, error: 'настройки ещё не загружены' };
  }
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
  setSoundBusy(disabled);
  for (const key of SETTING_KEYS) $(key).disabled = disabled;
  for (const select of $('account-preferences').querySelectorAll('select')) select.disabled = disabled;
}

document.addEventListener('DOMContentLoaded', async () => {
  $('st-version').textContent = 'v' + chrome.runtime.getManifest().version;

  // загрузка текущих значений
  ({ customSound = null } = await chrome.storage.local.get('customSound'));
  renderSoundChoice(DEFAULT_SOUND_ID); // до ответа фона список не пустой
  const resp = await send({ type: 'getState' });
  if (resp.ok) {
    applySettings(resp.settings || {});
    // выбран свой звук, а файла нет (удалён в другой вкладке) — сохраняем то, что показано в списке
    if (resp.settings && resp.settings.soundId === CUSTOM_SOUND_ID && !customSound) save(true);
    renderStatus(resp.state);
    renderAccountPreferences(resp.state, settingsDraft);
  }

  // автосохранение при изменении
  $('interval').addEventListener('change', () => save(false));
  $('soundId').addEventListener('change', () => { soundStatus(''); save(false); });
  $('btn-sound-preview').addEventListener('click', previewSound);
  $('btn-sound-upload').addEventListener('click', () => $('sound-file').click());
  $('sound-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // повторный выбор того же файла тоже срабатывает
    if (file) uploadSound(file);
  });
  $('btn-sound-remove').addEventListener('click', removeCustomSound);
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
