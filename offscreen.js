'use strict';

/* ======= Mail.ru Нотификатор - 3MR — offscreen: звук уведомлений =======
 * Offscreen-документ нужен, потому что service worker (MV3) не может
 * воспроизводить аудио напрямую. Играет независимо от системных уведомлений.
 * Источник звука: файл из папки sound/ пакета или свой файл пользователя (data:audio/…).
 */

const FALLBACK_FILE = 'chime.wav';

function packagedSound(file) {
  const name = typeof file === 'string' && /^[a-z0-9_-]+\.wav$/i.test(file) ? file : FALLBACK_FILE;
  return chrome.runtime.getURL('sound/' + name);
}

function play(src, volume) {
  const audio = new Audio(src);
  audio.volume = volume;
  return audio.play();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'playSound') return;
  if (!sender || sender.id !== chrome.runtime.id) return; // только из самого расширения
  const volume = typeof msg.volume === 'number' ? Math.min(1, Math.max(0, msg.volume)) : 0.8;
  const fallback = packagedSound(msg.file);
  const custom = typeof msg.dataUrl === 'string' && msg.dataUrl.startsWith('data:audio/') ? msg.dataUrl : null;
  if (!custom) {
    play(fallback, volume).catch(() => { /* например, нет пользовательского жеста — молча пропускаем */ });
    return;
  }
  // свой файл не воспроизвёлся (повреждён или формат не поддерживается) — играем встроенный сигнал
  play(custom, volume).catch(() => play(fallback, volume).catch(() => {}));
});
