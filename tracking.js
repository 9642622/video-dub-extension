// Учёт просмотров: кто какое видео смотрел и сколько времени.
//
// ВАЖНО: это content-скрипт, модулей тут нет — файл делит область видимости
// с content.js (оба перечислены в manifest). Поэтому без export/import.
//
// Работает НЕЗАВИСИМО от переводчика — панель может быть не открыта вовсе.
// Считаем только фактический просмотр: секунды идут, пока видео реально играет
// (пауза, свёрнутая вкладка и открытая, но не запущенная запись в счёт не идут).
//
// Собирается только на домене хранилища (см. TRACK_HOSTS) — на остальных сайтах
// расширение ничего не записывает.

const TRACK_HOSTS = ['cloud.frame-house.eu'];
const FLUSH_EVERY_MS = 20000;   // отправляем накопленное раз в 20 с
const MIN_SECONDS = 3;          // случайные клики по ролику в журнал не пишем

let session = null;             // текущий просмотр
let lastTick = 0;

function startViewTracking() {
  if (!TRACK_HOSTS.includes(location.hostname)) return;
  setInterval(tickTracking, 1000);
  setInterval(() => flush(false), FLUSH_EVERY_MS);
  // Уход со страницы — последний шанс досчитать и отправить.
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(false); });
}

// Имя пользователя хранилища берём со страницы: ownCloud кладёт его в разметку.
function storageUser() {
  const head = document.querySelector('head[data-user]')?.dataset.user;
  const meta = document.querySelector('meta[name="user"]')?.content;
  const input = document.querySelector('#user, input[name="user"]')?.value;
  return head || meta || input || '';
}

function visibleVideo() {
  const vids = [...document.querySelectorAll('video')].filter((v) => {
    const r = v.getBoundingClientRect();
    return v.isConnected && r.width > 50 && r.height > 50;
  });
  return vids.find((v) => !v.paused) || vids[0] || null;
}

function fileNameOf(v) {
  try {
    const u = new URL(v.currentSrc || v.src, location.href);
    const q = u.searchParams.get('files') || u.searchParams.get('file') || '';
    const path = u.pathname.split('/').filter(Boolean).reverse()
      .find((p) => !/^(download|preview|index\.php|remote\.php|s|files|dav|apps|ajax|core)$/i.test(p)) || '';
    return decodeURIComponent(q || path);
  } catch {
    return '';
  }
}

function tickTracking() {
  const v = visibleVideo();
  const now = Date.now();
  const file = v ? fileNameOf(v) : '';

  // Сменился файл или видео исчезло — закрываем прошлый просмотр.
  if (session && (!v || file !== session.file)) { flush(true); session = null; }
  if (!v || !file) { lastTick = now; return; }

  if (!session) {
    session = {
      file,
      url: (v.currentSrc || v.src || '').slice(0, 300),
      user: storageUser(),
      duration: Math.round(v.duration || 0),
      startedAt: new Date(now).toISOString(),
      watched: 0,     // секунды фактического просмотра
      maxPos: 0,      // до какой минуты дошёл
      dubbed: false,  // включал ли перевод
    };
  }
  // Считаем только идущее воспроизведение и только когда вкладка на виду.
  const delta = Math.min(2, (now - lastTick) / 1000);
  if (!v.paused && !v.ended && !document.hidden) session.watched += delta;
  session.maxPos = Math.max(session.maxPos, Math.round(v.currentTime || 0));
  if (!session.duration) session.duration = Math.round(v.duration || 0);
  lastTick = now;
}

// Панель сообщает, что для этого просмотра включали перевод.
function markDubbed() {
  if (session) session.dubbed = true;
}

function flush(closing) {
  if (!session || session.watched < MIN_SECONDS) { if (closing) session = null; return; }
  const event = {
    ...session,
    watched: Math.round(session.watched),
    endedAt: new Date().toISOString(),
    closed: !!closing,
  };
  try {
    chrome.runtime.sendMessage({ target: 'background', type: 'view_event', event });
  } catch {
    // Расширение перезагрузили — этот отрезок теряем, следующий уйдёт заново.
  }
  if (closing) session = null;
  else { session.startedAt = event.endedAt; session.watched = 0; } // отрезок отправлен, считаем дальше
}
