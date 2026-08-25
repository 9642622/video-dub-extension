// Панель дубляжа для ownCloud: переводим файл целиком, смотрим с синхронным текстом.
//
// Звук играет ЗДЕСЬ, на странице, через Web Audio (CSP `media-src` на него не действует —
// у AudioBufferSourceNode нет URL, запрещать нечему). Только эта вкладка видит видео,
// поэтому только она решает, что и когда звучит: пауза, перемотка и подмена плеера
// читаются напрямую с элемента, а не пересказываются сообщениями в другой процесс.
// offscreen.js — лишь синтезатор: «дай озвучку куска N» → байты в ответ.

// Версия видна в шапке панели: сразу понятно, доехала ли новая сборка до браузера
// (после ↻ в chrome://extensions число обязано смениться). Источник один — manifest.json.
const BUILD = 'v' + chrome.runtime.getManifest().version;

document.getElementById('gld-panel')?.remove();
document.getElementById('gld-tab')?.remove();
// Метка на каждой странице: какая сборка content.js реально работает (видно из консоли).
document.documentElement.dataset.gldBuild = BUILD;

// После перезагрузки расширения на странице может остаться осиротевшая копия скрипта —
// у неё жив таймер, и она продолжает дёргать видео, воюя с новой копией. Новая копия
// объявляет о себе событием (DOM общий для всех копий), старые навсегда замолкают.
window.dispatchEvent(new Event('gld-takeover'));
window.addEventListener('gld-takeover', retireThisCopy, { once: true });
function retireThisCopy() {
  clearInterval(timeTimer);
  clearInterval(stageTimer);
  try { stopVoice(); } catch {}
  if (main) {
    main.removeEventListener('pause', onUserPause);
    main.removeEventListener('play', onUserPlay);
  }
  panel?.remove();
  panel = null;
  document.getElementById('gld-tab')?.remove();
}

// Учёт просмотров идёт всегда — панель для него не нужна (см. tracking.js).
startViewTracking();

// ponytail: служебный крючок для отладки — открыть панель событием со страницы,
// когда попап недоступен (автотесты, консоль). Ничего опасного не даёт.
window.addEventListener('gld-debug-toggle', () => togglePanel());

let panel = null;
let main = null;          // видео на странице
let chunks = [];          // реплики с таймкодами
let activeTab = 'text';
let running = false;
let prevVolume = 1;
let timeTimer = null;
let speakingIdx = -1;
let readyDone = false;    // первую готовность обрабатываем один раз за запуск
let lastTime = 0;         // время видео на прошлом тике — по скачку узнаём перемотку

// Воспроизведение озвучки.
let audioCtx = null;         // создаётся по клику «Перевести» — жест разрешает звук
const buffers = new Map();   // ключ куска -> AudioBuffer, готовый к запуску
const requested = new Set(); // куски, чью озвучку уже попросили у offscreen
const played = new Set();    // прозвучавшие — второй раз не начинаем
let curSource = null;        // звучащий сейчас AudioBufferSourceNode
let curIdx = -1;
let ourPause = false;        // видео придержали мы (ждём озвучку), а не пользователь
const LOOKAHEAD_S = 150;     // насколько вперёд просим озвучку

// Ключ куска — его содержимое, а не номер. Пока перевод доходит частями, нарезка
// перестраивается и номера сдвигаются: озвучка под старым номером оказывалась ЧУЖИМ
// текстом, реплики звучали вразнобой. Ключ по содержимому делает это невозможным.
function chunkKey(c) {
  return `${Math.round(c.start * 10)}|${c.speaker}|${c.text.length}|${c.text.slice(0, 24)}`;
}

const logLines = [];

const LOG_COLORS = { error: '#f28b82', warn: '#fdd663', ok: '#81c995', info: '#9aa0a6' };

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'sync_toggle') togglePanel();
  if (!panel) return;
  if (msg.type === 'log') { logLines.push(msg); renderLog(); }
  // После готовности хвост перевода доходит фоном — счётчик стадии уже не нужен.
  if (msg.type === 'file_progress' && !readyDone) setStage(msg.stage, msg.done, msg.total);
  // Готовность приходит дважды: с первой пачкой и в самом конце. Настраиваться на просмотр
  // нужно один раз — второй раз это отбирало у пользователя паузу и портило громкость.
  if (msg.type === 'file_ready') {
    chunks = msg.chunks;
    if (readyDone) { stopStage(); renderText(); highlight(); setStatus(`Перевод готов целиком · ${chunks.length} реплик`); }
    else onReady();
  }
  // Перевод продолжает поступать — дополняем текст, не прерывая просмотр.
  if (msg.type === 'file_more') {
    chunks = msg.chunks;
    renderText();
    highlight();
    setStatus(`Идёт перевод · готово ${chunks.length} реплик`);
  }
  // Пришли байты озвучки — раскодируем и положим наготове. Играть их будет тик.
  if (msg.type === 'speech_data') onSpeech(msg);
  if (msg.type === 'summary') {
    panel.querySelector('#gld-summary-box').textContent = msg.text;
    showTab('summary');
    setStatus('');
  }
  if (msg.type === 'sync_status' && msg.status === 'error') {
    // Смертельную ошибку (ключ, баланс) не должны затирать статусы пауз и пропусков.
    fatalError = msg.error || 'см. журнал';
    setStatus('Ошибка: ' + fatalError);
  }
});

let fatalError = '';

function setStatus(text) {
  const el = panel && panel.querySelector('#gld-status');
  // Пока висит смертельная ошибка, показываем её, а не рабочие статусы.
  if (el) el.textContent = fatalError && !text.startsWith('Ошибка') ? `Ошибка: ${fatalError}` : text;
}

// Живой индикатор стадии: что делаем сейчас, сколько сделано и сколько это уже длится.
const STAGE_NAMES = {
  скачивание: 'Скачиваю видео',
  расшифровка: 'Расшифровываю речь',
  перевод: 'Перевожу',
};
let stage = null;
let stageTimer = null;

function setStage(name, done, total) {
  const started = stage && stage.name === name ? stage.started : Date.now();
  stage = { name, done, total, started };
  clearInterval(stageTimer);
  stageTimer = setInterval(tickStage, 1000);
  tickStage();
}

function tickStage() {
  if (!stage || !panel) return;
  const secs = Math.round((Date.now() - stage.started) / 1000);
  const time = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs} с`;
  const title = STAGE_NAMES[stage.name] || stage.name;
  const of = stage.total > 1 ? ` · ${stage.done} из ${stage.total}` : '';
  const dots = '.'.repeat(1 + (secs % 3));
  setStatus(`${title}${of} · ${time}${dots}`);
}

function stopStage() {
  clearInterval(stageTimer);
  stage = null;
}

function togglePanel() {
  document.getElementById('gld-tab')?.remove();
  if (panel) { stopAll(); panel.remove(); panel = null; return; }

  panel = document.createElement('div');
  panel.id = 'gld-panel';
  panel.style.cssText =
    'position:fixed;top:0;right:0;width:400px;max-width:92vw;height:100vh;z-index:2147483647;' +
    'background:#17181c;color:#e8eaed;font:13px/1.45 -apple-system,sans-serif;' +
    'box-shadow:-4px 0 24px rgba(0,0,0,.5);display:flex;flex-direction:column';
  panel.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid #2b2d31;display:flex;
                align-items:center;justify-content:space-between;flex:none">
      <b style="font-size:14px">Перевод видео
        <span style="font-weight:normal;color:#5f6368;font-size:11px">${BUILD}</span></b>
      <span>
        <span id="gld-gear" title="Настройки" style="cursor:pointer;color:#9aa0a6;margin-right:12px">⚙</span>
        <span id="gld-hide" title="Свернуть" style="cursor:pointer;color:#9aa0a6;margin-right:10px;font-size:16px">⟩</span>
        <span id="gld-close" title="Закрыть" style="cursor:pointer;color:#9aa0a6;font-size:18px">×</span>
      </span>
    </div>

    <div id="gld-register" style="display:none;padding:12px 14px;border-bottom:1px solid #2b2d31;
         background:#1c1d22;flex:none">
      <div style="font-size:12.5px;margin-bottom:8px">Представьтесь, чтобы начать работу</div>
      <input id="gld-email" type="email" placeholder="почта@компания.ru" autocomplete="email"
             style="width:100%;box-sizing:border-box;padding:8px;border-radius:6px;
                    border:1px solid #3c4043;background:#17181c;color:#e8eaed;font-size:13px">
      <button id="gld-reg-go" style="width:100%;margin-top:8px;padding:9px;border:none;border-radius:6px;
              background:#1a73e8;color:#fff;font-size:13px;font-weight:bold;cursor:pointer">
        Продолжить</button>
      <div id="gld-reg-err" style="margin-top:6px;min-height:14px;color:#f28b82;font-size:12px"></div>
    </div>

    <div style="padding:12px 14px;border-bottom:1px solid #2b2d31;flex:none">
      <button id="gld-go" style="width:100%;padding:11px;border:none;border-radius:6px;
              background:#1a73e8;color:#fff;font-size:13px;font-weight:bold;cursor:pointer">
        Перевести это видео</button>
      <div id="gld-status" style="margin-top:8px;min-height:16px;color:#ffd54f;font-size:12px"></div>
    </div>

    <div id="gld-settings" style="display:none;padding:12px 14px;border-bottom:1px solid #2b2d31;
         background:#1c1d22;flex:none;font-size:12px;color:#9aa0a6">
      <label style="display:block">Громкость оригинала: <span id="gld-vol-v">20</span>%
        <input id="gld-vol" type="range" min="0" max="60" value="20" style="width:100%;margin-top:4px">
      </label>
      <div style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap">
        <a href="#" id="gld-keys" style="color:#8ab4f8">ключи API…</a>
        <a href="#" id="gld-savetext" style="color:#8ab4f8">скачать перевод</a>
        <a href="#" id="gld-savesrt" style="color:#8ab4f8">скачать субтитры</a>
        <a href="#" id="gld-savelog" style="color:#8ab4f8">скачать журнал</a>
        <a href="#" id="gld-forget" style="color:#f28b82">забыть перевод</a>
      </div>
    </div>

    <div style="display:flex;border-bottom:1px solid #2b2d31;flex:none">
      <button class="gld-tab-btn" data-tab="text" style="flex:1;padding:9px;border:none;
              background:#22242a;color:#e8eaed;font-size:12px;cursor:pointer;
              border-bottom:2px solid #8ab4f8">Текст</button>
      <button class="gld-tab-btn" data-tab="summary" style="flex:1;padding:9px;border:none;
              background:#17181c;color:#9aa0a6;font-size:12px;cursor:pointer;
              border-bottom:2px solid transparent">Сводка</button>
      <button class="gld-tab-btn" data-tab="log" style="flex:1;padding:9px;border:none;
              background:#17181c;color:#9aa0a6;font-size:12px;cursor:pointer;
              border-bottom:2px solid transparent">Журнал</button>
    </div>

    <div id="gld-pane-text" class="gld-pane" style="flex:1;overflow:auto;padding:10px 14px">
      <div style="color:#9aa0a6;font-size:12px">Нажмите «Перевести это видео».</div>
    </div>

    <div id="gld-pane-summary" class="gld-pane" style="display:none;flex:1;overflow:auto;padding:12px 14px">
      <button id="gld-summary" style="width:100%;padding:9px;border:none;border-radius:6px;
              background:#3c4043;color:#e8eaed;font-size:12px;cursor:pointer">Сделать сводку встречи</button>
      <div id="gld-summary-box" style="margin-top:10px;font-size:12.5px;white-space:pre-wrap"></div>
    </div>

    <div id="gld-pane-log" class="gld-pane" style="display:none;flex:1;overflow:auto;padding:10px 14px;
         background:#101114;font:11px/1.45 ui-monospace,monospace"></div>`;

  document.documentElement.appendChild(panel);
  wirePanel();
  checkForUpdate();
  gateOnRegistration();
}

// Первый запуск: пока пользователь не назвался, панель просит регистрацию,
// а кнопка перевода недоступна. Дальше экран больше не показывается.
async function gateOnRegistration() {
  let account = null;
  try {
    account = await chrome.runtime.sendMessage({ target: 'background', type: 'get_account' });
  } catch { return; }
  if (account && account.email) return;

  const box = panel.querySelector('#gld-register');
  const go = panel.querySelector('#gld-go');
  box.style.display = 'block';
  go.disabled = true;
  go.style.opacity = '.5';
  go.style.cursor = 'default';

  const input = box.querySelector('#gld-email');
  const btn = box.querySelector('#gld-reg-go');
  const err = box.querySelector('#gld-reg-err');
  input.focus();

  const submit = async () => {
    const email = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
      err.textContent = 'Введите рабочий адрес электронной почты';
      return;
    }
    btn.disabled = true;
    err.textContent = '';
    const res = await chrome.runtime.sendMessage({ target: 'background', type: 'register', email });
    btn.disabled = false;
    if (!res || !res.ok) { err.textContent = res?.error || 'Не удалось сохранить, попробуйте ещё раз'; return; }
    box.style.display = 'none';
    go.disabled = false;
    go.style.opacity = '1';
    go.style.cursor = 'pointer';
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// Панель сама узнаёт о новой версии (номер лежит в публичном гисте). Обновить себя
// расширение не может — Chrome запрещает; поэтому только сообщаем и ведём в репозиторий.
async function checkForUpdate() {
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ target: 'background', type: 'check_update' });
  } catch { return; }
  if (!res || !res.newer || !panel) return;
  const row = document.createElement('div');
  row.style.cssText = 'padding:8px 14px;background:#2d2410;color:#fdd663;font-size:12px;' +
    'border-bottom:1px solid #2b2d31;flex:none' + (res.url ? ';cursor:pointer' : '');
  row.textContent = res.url
    ? `Вышла версия ${res.latest} (у вас ${res.mine}). Нажмите, чтобы скачать обновление.`
    : `Вышла версия ${res.latest} (у вас ${res.mine}) — обратитесь к администратору за обновлением.`;
  if (res.url) {
    row.addEventListener('click', () =>
      chrome.runtime.sendMessage({ target: 'background', type: 'open_download' }));
  }
  panel.insertBefore(row, panel.children[1]);
}

function wirePanel() {
  panel.querySelector('#gld-close').addEventListener('click', () => togglePanel());
  panel.querySelector('#gld-hide').addEventListener('click', collapsePanel);
  panel.querySelector('#gld-gear').addEventListener('click', () => {
    const s = panel.querySelector('#gld-settings');
    s.style.display = s.style.display === 'none' ? 'block' : 'none';
  });
  panel.querySelector('#gld-go').addEventListener('click', () => (running ? stopAll() : startTranslation()));
  for (const btn of panel.querySelectorAll('.gld-tab-btn')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }
  panel.querySelector('#gld-vol').addEventListener('input', (e) => {
    panel.querySelector('#gld-vol-v').textContent = e.target.value;
    if (main) main.volume = e.target.value / 100;
  });
  panel.querySelector('#gld-summary').addEventListener('click', () => {
    if (!chunks.length) { setStatus('Сначала переведите видео'); return; }
    setStatus('Готовлю сводку…');
    chrome.runtime.sendMessage({
      target: 'offscreen', type: 'make_summary',
      text: chunks.map((c) => c.text).join('\n'),
    });
  });
  panel.querySelector('#gld-keys').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ target: 'background', type: 'open_options' });
  });
  panel.querySelector('#gld-savetext').addEventListener('click', (e) => {
    e.preventDefault();
    download('перевод.txt', chunks.map((c) => `[${clock(c.start)}] S${c.speaker}: ${c.text}`).join('\n'));
  });
  panel.querySelector('#gld-savesrt').addEventListener('click', (e) => {
    e.preventDefault();
    download('субтитры.srt', toSrt(chunks));
  });
  panel.querySelector('#gld-savelog').addEventListener('click', (e) => {
    e.preventDefault();
    download('журнал.txt', logLines.map((l) => `[${l.t}с] ${l.stage}: ${l.text}`).join('\n'));
  });
  panel.querySelector('#gld-forget').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'forget_cache', key: cacheKey() });
    setStatus('Сохранённый перевод удалён');
  });
}

function collapsePanel() {
  panel.style.display = 'none';
  const tab = document.createElement('div');
  tab.id = 'gld-tab';
  tab.textContent = '◀ Перевод';
  tab.style.cssText =
    'position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;cursor:pointer;' +
    'background:#1a73e8;color:#fff;font:12px/1 sans-serif;padding:10px 8px;border-radius:6px 0 0 6px;' +
    'writing-mode:vertical-rl;box-shadow:-2px 0 10px rgba(0,0,0,.4)';
  tab.addEventListener('click', () => { tab.remove(); panel.style.display = 'flex'; });
  document.documentElement.appendChild(tab);
}

function showTab(name) {
  activeTab = name;
  for (const pane of panel.querySelectorAll('.gld-pane')) {
    pane.style.display = pane.id === `gld-pane-${name}` ? 'block' : 'none';
  }
  for (const btn of panel.querySelectorAll('.gld-tab-btn')) {
    const on = btn.dataset.tab === name;
    btn.style.background = on ? '#22242a' : '#17181c';
    btn.style.color = on ? '#e8eaed' : '#9aa0a6';
    btn.style.borderBottomColor = on ? '#8ab4f8' : 'transparent';
  }
  if (name === 'log') loadHistory().then(renderLog);
}

// Журнал прошлого запуска (например, после краха) хранится в расширении — подтягиваем его.
async function loadHistory() {
  if (logLines.length) return;
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'get_log' });
  for (const l of (res && res.lines) || []) logLines.push(l);
  if (res && !res.live && res.at) {
    const when = new Date(res.at).toLocaleString('ru-RU');
    logLines.unshift({ t: 0, stage: 'История', text: `журнал прошлого запуска от ${when}`, level: 'warn' });
  }
}

// ---- запуск перевода ----

// Видео пользователя — то, которое он видит и слушает. Просмотрщик папки ownCloud —
// карусель: в DOM одновременно три слайда (предыдущий, текущий, следующий), все «видимые».
// Брать «самый крупный» мало — так выбирался сосед по карусели, и переводился чужой ролик.
// Приоритет: играющее видео → то, что в центре экрана (текущий слайд) → самое крупное.
function findVideo() {
  const vids = [...document.querySelectorAll('video')].filter((v) => {
    const r = v.getBoundingClientRect();
    return v.isConnected && r.width > 50 && r.height > 50;
  });
  const cx = innerWidth / 2, cy = innerHeight / 2;
  return vids.find((v) => !v.paused)
    || vids.find((v) => {
      const r = v.getBoundingClientRect();
      return r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy;
    })
    || vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
    || null;
}

// Имя файла из ссылки — для журнала: видно, каким видео мы управляем на самом деле.
function srcName(v) {
  try {
    const u = new URL(v.currentSrc || v.src, location.href);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.pathname);
  } catch { return '?'; }
}

// Ключ обязан быть разным для разных файлов: берём имя ролика и его длительность.
// (Раньше брался кусок адреса — в ownCloud он одинаковый у всех файлов, и переводы смешивались.)
// Служебные куски адреса одинаковы у всех файлов хранилища — по ним ролики не различить.
const SERVICE_PARTS = /^(download|preview|index\.php|remote\.php|s|files|dav|apps|ajax|core)$/i;

function cacheKey() {
  const src = main && (main.currentSrc || main.src);
  if (!src) return '';
  const u = new URL(src, location.href);
  const fromQuery = u.searchParams.get('files') || u.searchParams.get('file')
    || u.searchParams.get('fileId') || '';
  // Из пути берём последний осмысленный кусок: имя файла или код общей ссылки.
  const fromPath = u.pathname.split('/').filter(Boolean).reverse()
    .find((p) => !SERVICE_PARTS.test(p)) || '';
  const name = decodeURIComponent(fromQuery || fromPath).replace(/\.(mp4|mov|mkv|webm|m4v)$/i, '');
  const dur = Math.round(main.duration || 0);
  return `${name}|${dur || '?'}`;
}

let startedSrc = '';   // ссылка, которую переводим: сменилась — старый перевод не годится

// Каждый запуск начинается с чистого листа: никакие реплики, озвучки и флаги
// прошлого ролика не должны дожить до нового — иначе старый звук лезет поверх.
function resetPlayback() {
  fatalError = '';
  stopVoice();
  chunks = [];
  buffers.clear();
  requested.clear();
  played.clear();
  speakingIdx = -1;
  ourPause = false;
  holdSince = 0;
  readyDone = false;
  if (main) {
    main.removeEventListener('pause', onUserPause);
    main.removeEventListener('play', onUserPlay);
    main.volume = prevVolume;
  }
  clearInterval(timeTimer);
  timeTimer = null;
}

async function startTranslation() {
  resetPlayback();
  main = findVideo();
  if (!main) { setStatus('Видео на странице не найдено'); return; }
  const src = main.currentSrc || main.src;
  if (!src || src.startsWith('blob:')) { setStatus('Нужна прямая ссылка на файл'); return; }
  startedSrc = src;
  const box = panel.querySelector('#gld-pane-text');
  if (box) box.innerHTML = '<div style="color:#9aa0a6;font-size:12px">Готовлю перевод…</div>';
  localLog('Плеер', `перевожу «${srcName(main)}» (видео на странице: ` +
    `${document.querySelectorAll('video').length})`);

  // Без длительности ролики не различить между собой — дожидаемся метаданных.
  if (!main.duration || !isFinite(main.duration)) {
    setStatus('Читаю сведения о видео…');
    await new Promise((res) => {
      const done = () => res();
      main.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 5000);
    });
  }
  if (!main.duration || !isFinite(main.duration)) {
    setStatus('Не удалось определить длительность — нажмите ▶ и повторите');
    return;
  }

  running = true;
  readyDone = false;
  ourPause = false;
  markDubbed();   // в учёте просмотров этот ролик пойдёт как «с переводом»
  // Клик — это жест: создаём звуковой контекст сейчас, пока браузер разрешает звук.
  audioCtx = audioCtx || new AudioContext();
  audioCtx.resume().catch(() => {});
  panel.querySelector('#gld-go').textContent = 'Остановить';
  setStatus('Готовлю перевод…');
  chrome.runtime.sendMessage({
    target: 'background', type: 'file_start', url: src,
    cacheKey: cacheKey(),
    duration: Math.round(main.duration || 0), // по ней проверим, что кэш от этого ролика
  });
}

function onReady() {
  readyDone = true;
  stopStage();
  setStatus(`Можно смотреть · готово ${chunks.length} реплик`);
  renderText();
  adoptVideo(main);
  lastTime = main.currentTime;
  clearInterval(timeTimer);
  timeTimer = setInterval(tick, 250);
  tick();
  if (main.paused) {
    main.play().then(
      () => setStatus('Идёт перевод'),
      () => setStatus('Нажмите ▶ на видео'),
    );
  }
}

// Подключаемся к конкретному элементу видео. Отдельной функцией — потому что плеер
// ownCloud пересоздаёт <video> при закрытии/открытии просмотра, и тогда нужно
// подхватить новый элемент (старый «призрак» Chrome продолжает крутить в памяти).
function adoptVideo(v) {
  main = v;
  prevVolume = main.volume;
  main.volume = panel.querySelector('#gld-vol').value / 100;
  main.addEventListener('pause', onUserPause);
  main.addEventListener('play', onUserPlay);
}

// Тик 4 раза в секунду: читаем НАСТОЯЩЕЕ состояние видео и решаем, что звучит.
// Никаких пересказов состояния между процессами — все решения принимаются здесь.
function tick() {
  if (!panel || !chunks.length) return;

  // Плеер закрыли или пересоздали — старый элемент больше не экран.
  if (!main || !main.isConnected) {
    stopVoice();
    const v = findVideo();
    if (!v) return; // просмотр закрыт — молчим, тик продолжит искать
    adoptVideo(v);
    localLog('Плеер', `видео пересоздано — подключился к «${srcName(v)}»`, 'warn');
  }

  // В плеер загрузили другой файл — наш перевод к нему не относится. Молчим и говорим почему.
  if (startedSrc && (main.currentSrc || main.src) !== startedSrc) {
    stopVoice();
    setStatus('Видео сменилось — нажмите «Перевести это видео» заново');
    return;
  }

  const t = main.currentTime;
  if (Math.abs(t - lastTime) > 3) onJump(t); // перемотка видна по скачку времени
  lastTime = t;

  requestAhead(t);
  highlight();

  const idx = pickNext(t);

  if (main.paused) {
    if (!ourPause) { stopVoice(); return; }   // пауза пользователя — не вмешиваемся
    // Наша пауза: озвучка подоспела или говорить пока нечего — отпускаем видео.
    if (idx < 0 || buffers.has(chunkKey(chunks[idx])) || chunks[idx].start > t + 0.3) { release(); return; }
    // Озвучка так и не пришла (сбой синтеза?) — не держим видео вечно, пропускаем кусок.
    if (Date.now() - holdSince > 20000) {
      played.add(chunkKey(chunks[idx]));
      requested.delete(chunkKey(chunks[idx])); // перемотка назад даст куску второй шанс
      localLog('Пауза', `озвучка куска ${idx + 1} не пришла за 20 с — пропускаю`, 'warn');
      release();
    }
    return;
  }

  if (curSource) return;                      // реплика ещё звучит
  if (idx < 0) return;                        // тишина по сценарию
  if (buffers.has(chunkKey(chunks[idx]))) { playChunk(idx); return; }
  // Реплика уже должна звучать, а озвучки нет — придерживаем видео, чтобы не разъехалось.
  if (chunks[idx].start <= t + 0.3) hold(idx);
}

// Следующий несыгранный кусок, до которого дошло видео; безнадёжно отставшие пропускаем.
function pickNext(t) {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (played.has(chunkKey(c))) continue;
    if (c.start > t + 0.3) return -1;
    if (c.end < t - 3) { played.add(chunkKey(c)); continue; }
    return i;
  }
  return -1;
}

// Просим озвучку на 2,5 минуты вперёд и выбрасываем буферы, которые уже не пригодятся.
function requestAhead(t) {
  const alive = new Set();
  for (const c of chunks) {
    if (c.end < t - 1 || c.start > t + LOOKAHEAD_S) continue;
    const key = chunkKey(c);
    alive.add(key);
    if (played.has(key) || requested.has(key) || buffers.has(key)) continue;
    requested.add(key);
    try {
      chrome.runtime.sendMessage({
        target: 'offscreen', type: 'speak_request',
        key, text: c.text, speaker: c.speaker, start: c.start, end: c.end,
      });
    } catch {
      // Расширение перезагрузили — скрипт осиротел. Звук уже наш, просто новых кусков не будет.
      requested.delete(key);
      setStatus('Расширение перезагружено — обновите страницу (⌘R)');
    }
  }
  const cur = curIdx >= 0 && chunks[curIdx] ? chunkKey(chunks[curIdx]) : null;
  for (const key of [...buffers.keys()]) {
    if (!alive.has(key) && key !== cur) {
      buffers.delete(key);
      requested.delete(key); // понадобится снова — offscreen отдаст из кэша мгновенно
    }
  }
}

async function onSpeech({ key, b64 }) {
  if (!audioCtx) return;
  try {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    buffers.set(key, { buf: await audioCtx.decodeAudioData(bytes.buffer) });
    tick(); // возможно, именно этого куска ждало придержанное видео
  } catch {
    requested.delete(key); // не раскодировалось — попросим заново
  }
}

function playChunk(i) {
  const c = chunks[i];
  const { buf } = buffers.get(chunkKey(c));
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  // playbackRate НЕ трогаем: в Web Audio он тянет высоту голоса вместе со скоростью,
  // и голос перестаёт быть собой. Длительность подгоняет сам синтезатор (prosody.speed).
  src.connect(audioCtx.destination);
  src.onended = () => {
    if (curSource !== src) return;
    curSource = null;
    curIdx = -1;
    tick(); // сразу берём следующий кусок, не дожидаясь очередного тика
  };
  curSource = src;
  curIdx = i;
  played.add(chunkKey(c));
  speakingIdx = i;
  src.start();
  localLog('Играю', `кусок ${i + 1} из ${chunks.length} (${clock(c.start)}–${clock(c.end)}), ` +
    `готово впереди: ${buffers.size}`);
}

function stopVoice() {
  if (!curSource) return;
  curSource.onended = null;
  try { curSource.stop(); } catch {}
  curSource = null;
  curIdx = -1;
}

let holdSince = 0;
let holdLogged = -1; // чтобы «придержал видео» не спамился на каждом тике

function hold(idx) {
  if (!ourPause) holdSince = Date.now();
  ourPause = true;
  main.pause();
  setStatus(`Жду озвучку (${clock(chunks[idx].start)}) — видео на паузе…`);
  if (holdLogged !== idx) {
    holdLogged = idx;
    localLog('Пауза', `придержал видео: жду озвучку куска ${idx + 1}`, 'warn');
  }
}

function release() {
  ourPause = false;
  main.play().then(
    () => { setStatus('Идёт перевод'); localLog('Пуск', 'озвучка готова — видео идёт дальше', 'ok'); },
    () => setStatus('Озвучка готова — нажмите ▶ на видео'),
  );
}

function onJump(t) {
  stopVoice();
  played.clear();
  chunks.forEach((c) => { if (c.end <= t) played.add(chunkKey(c)); });
  localLog('Перемотка', `на ${clock(t)}, впереди ${chunks.length - played.size} кусков`);
}

// Пауза и ▶ пользователя: только статус и мгновенная тишина; наши hold/release
// узнаются по флагу ourPause и сюда не попадают.
function onUserPause() {
  if (ourPause) return;
  stopVoice();
  setStatus('Пауза');
}

function onUserPlay() {
  // Любой пуск — своя ли это отпущенная пауза или ▶ пользователя — снимает наш флаг.
  // Раньше флаг застревал: система начинала принимать нажатия пользователя за свои,
  // игнорировала его паузу и пересиливала его ▶ — все жалобы «видео не слушается» отсюда.
  ourPause = false;
  setStatus('Идёт перевод');
  tick();
}

function localLog(stage, text, level = 'info') {
  logLines.push({ t: Math.round(main?.currentTime || 0), stage, text, level });
  renderLog();
}

function stopAll() {
  running = false;
  stopStage();
  resetPlayback();
  chrome.runtime.sendMessage({ target: 'background', type: 'sync_stop' });
  if (panel) {
    panel.querySelector('#gld-go').textContent = 'Перевести это видео';
    setStatus('');
  }
}

// ---- текст, синхронный с видео ----

function renderText() {
  const box = panel.querySelector('#gld-pane-text');
  box.innerHTML = '';
  chunks.forEach((c, i) => {
    const row = document.createElement('div');
    row.dataset.idx = i;
    row.style.cssText = 'padding:8px 10px;margin-bottom:6px;border-radius:6px;cursor:pointer;' +
      'background:#1e1f24;border-left:3px solid #3c4043';
    row.innerHTML =
      `<div style="font-size:11px;color:#9aa0a6;margin-bottom:3px">${clock(c.start)} · Спикер ${c.speaker}</div>` +
      `<div style="font-size:12.5px"></div>`;
    row.lastChild.textContent = c.text;
    row.addEventListener('click', () => { if (main) main.currentTime = c.start; });
    box.appendChild(row);
  });
}

function highlight() {
  if (!main || activeTab !== 'text') return;
  const t = main.currentTime;
  let idx = chunks.findIndex((c) => c.start <= t && c.end > t);
  if (idx < 0) idx = speakingIdx;
  const box = panel.querySelector('#gld-pane-text');
  for (const row of box.children) {
    const on = Number(row.dataset.idx) === idx;
    row.style.background = on ? '#1e3a5f' : '#1e1f24';
    row.style.borderLeftColor = on ? '#8ab4f8' : '#3c4043';
    if (on && !row.dataset.seen) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      for (const other of box.children) delete other.dataset.seen;
      row.dataset.seen = '1';
    }
  }
}

function renderLog() {
  const box = panel && panel.querySelector('#gld-pane-log');
  if (!box || activeTab !== 'log') return;
  box.innerHTML = '';
  for (const l of logLines.slice(-120)) {
    const row = document.createElement('div');
    row.style.color = LOG_COLORS[l.level] || LOG_COLORS.info;
    row.textContent = `${String(l.t).padStart(4)}с  ${l.stage}: ${l.text}`;
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

// ---- мелочи ----

function clock(sec) {
  const m = Math.floor(sec / 60), s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function toSrt(list) {
  const stamp = (sec) => {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.round((sec % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  return list.map((c, i) =>
    `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
