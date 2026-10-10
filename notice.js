'use strict';

const $ = (selector) => document.querySelector(selector);
const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => {
    void chrome.runtime.lastError;
    resolve(response || {});
  });
});

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = String(value || '');
  if (className) element.className = className;
  return element;
}

let renderPromise = Promise.resolve();

function render() {
  renderPromise = renderPromise.then(async () => {
    const response = await send({ type: 'getNoticeQueue' });
    const list = $('#list');
    list.textContent = '';
    const items = Array.isArray(response.items) ? response.items : [];
    if (!items.length) {
      list.appendChild(text('div', 'Новых писем нет', 'empty'));
      return;
    }

    for (const batch of items) {
      const section = document.createElement('section');
      section.className = 'batch';
      section.appendChild(text('div', batch.email, 'acct'));
      for (const message of (batch.messages || [])) {
        const row = document.createElement('article');
        row.className = 'msg';
        row.appendChild(text('div', message.fromName || message.fromEmail, 'from'));
        row.appendChild(text('div', message.subject || '(без темы)', 'subject'));
        if (message.snippet) row.appendChild(text('div', message.snippet, 'snippet'));

        const actions = document.createElement('div');
        actions.className = 'actions';
        if (batch.email === 'test') {
          actions.appendChild(text('span', 'Тестовое уведомление'));
        } else {
          const open = text('button', 'Открыть письмо');
          open.className = 'primary';
          open.onclick = () => send({ type: 'openMessage', email: batch.email, msgId: message.id });
          const inbox = text('button', 'Открыть почту');
          inbox.onclick = () => send({ type: 'openInbox', email: batch.email });
          actions.append(open, inbox);
        }
        row.appendChild(actions);
        section.appendChild(row);
      }
      list.appendChild(section);
    }
    await send({ type: 'markNoticeDisplayed', ids: items.map((item) => item.id) });
  }).catch(() => {});
  return renderPromise;
}

async function closeNotice() {
  await send({ type: 'ackDisplayedNoticeQueue' });
  window.close();
}

$('#close').onclick = closeNotice;
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'notice-refresh') render();
});
document.addEventListener('DOMContentLoaded', render);
