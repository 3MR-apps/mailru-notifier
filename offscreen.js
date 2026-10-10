'use strict';

/* ======= Mail.ru Нотификатор - 3MR — offscreen: звук уведомлений =======
 * Offscreen-документ нужен, потому что service worker (MV3) не может
 * воспроизводить аудио напрямую. Играет независимо от системных уведомлений.
 */

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'playSound') return;
  const file = typeof msg.file === 'string' && /^[a-z0-9._-]+$/i.test(msg.file) ? msg.file : 'notify.wav';
  const audio = new Audio(chrome.runtime.getURL('sound/' + file));
  audio.volume = typeof msg.volume === 'number' ? Math.min(1, Math.max(0, msg.volume)) : 0.8;
  audio.play().catch(() => { /* например, нет пользовательского жеста — молча пропускаем */ });
});
