// После перезагрузки расширения старый content.js на странице «осиротевший» и не отвечает.
// Переустанавливаем его сам — чтобы не приходилось жать ⌘R на каждой вкладке.
chrome.runtime.onInstalled.addListener(reinjectContentScripts);

async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["tracking.js", "content.js"] });
    } catch {} // chrome://, магазин расширений и прочие закрытые страницы — пропускаем
  }
}

let state = { status: 'idle', error: null };
let offscreenCreating = null;

// Вкладка с активным переводом. Фоновый скрипт MV3 умирает после ~30 с простоя
// (например, пока идёт долгая расшифровка) — в памяти номер вкладки не переживёт
// перезапуск, поэтому он хранится в storage.session и восстанавливается на лету.
let relayTabId = null;

function setRelayTab(id) {
  relayTabId = id ?? null;
  chrome.storage.session.set({ relayTab: relayTabId }).catch(() => {});
}

async function relay(msg) {
  if (relayTabId === null) {
    const { relayTab = null } = await chrome.storage.session.get('relayTab');
    relayTabId = relayTab;
  }
  if (relayTabId !== null) chrome.tabs.sendMessage(relayTabId, msg).catch(() => {});
}

const DEFAULT_MODEL = 'gemini-3.5-live-translate-preview';

// Поднимаем, когда меняется набор голосов по умолчанию: сохранённый в настройках
// выбор от прежней сборки молча перекрывал новый пакет — женщины продолжали
// говорить голосами, которые владелец давно заменил.
const VOICE_PACK_VERSION = 5;

async function getConfig() {
  const cfg = await chrome.storage.local.get({
    apiKey: '', model: DEFAULT_MODEL,
    openaiKey: '', openaiModel: 'gpt-5.6-terra',
    elevenKey: '',
    fishKey: '', fishVoice: '',
    fishMale: [], fishFemale: [], voicePack: 0,
  });
  if (cfg.voicePack < VOICE_PACK_VERSION) {
    cfg.fishMale = [];
    cfg.fishFemale = [];
    cfg.voicePack = VOICE_PACK_VERSION;
    chrome.storage.local.set({ fishMale: [], fishFemale: [], voicePack: VOICE_PACK_VERSION });
  }
  // Миграция со старого дефолта (разговорная модель не тянет синхронный перевод).
  if (cfg.model === 'gemini-3.1-flash-live-preview') {
    cfg.model = DEFAULT_MODEL;
    chrome.storage.local.set({ model: cfg.model });
  }
  return cfg;
}

function setState(status, error = null) {
  state = { status, error };
  chrome.runtime.sendMessage({ target: 'popup', type: 'status', status, error }).catch(() => {});
  relay({ type: 'sync_status', status, error });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'get_state') { sendResponse(state); return; }
  if (msg.type === 'start') start(msg.tabId);
  if (msg.type === 'stop') stop();
  if (msg.type === 'status') setState(msg.status, msg.error || null);
  if (msg.type === 'cache_get') { cacheGet(msg.key).then(sendResponse); return true; }
  if (msg.type === 'cache_put') { cachePut(msg.key, msg.chunks, msg.genders).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'cache_del') { cacheDel(msg.key).then(() => sendResponse({ ok: true })); return true; }
  if (msg.type === 'file_start') fileStart(sender.tab && sender.tab.id, msg);
  if (msg.type === 'open_options') chrome.runtime.openOptionsPage();
  if (msg.type === 'check_update') { checkUpdate().then(sendResponse); return true; }
  if (msg.type === 'open_download') {
    // Куда идти за обновлением, решает файл версии — репозиторий приватный,
    // и сотрудники в него не попадают (именно на это они и жаловались).
    checkUpdate().then(({ url }) => {
      if (url) chrome.tabs.create({ url });
    });
  }
  if (msg.type === 'get_server') { server().then(sendResponse); return true; }
  if (msg.type === 'open_admin') chrome.tabs.create({ url: chrome.runtime.getURL('admin.html') });
  if (msg.type === 'get_account') { chrome.storage.local.get('account').then((v) => sendResponse(v.account || null)); return true; }
  if (msg.type === 'register') { register(msg.email).then(sendResponse); return true; }
  if (msg.type === 'view_event') keepView(msg.event, sender);
  if (msg.type === 'get_views') { getViews().then(sendResponse); return true; }
  if (msg.type === 'log') keepLog(msg);
  if (msg.type === 'get_log') { getLog().then(sendResponse); return true; }
  if (['file_progress', 'file_ready', 'file_more', 'speech_data',
    'speech_ready', 'queue_empty', 'queue_refilled', 'prepare_progress', 'all_ready', 'log',
    'speaking', 'summary', 'transcript', 'need_gesture', 'yandex_ready', 'yandex_progress']
    .includes(msg.type)) {
    relay(msg);
  }
  if (msg.type === 'sync_start') syncStart(sender.tab && sender.tab.id, msg);
  if (msg.type === 'sync_stop') stop();
  if (msg.type === 'yandex_start') yandexStart(sender.tab && sender.tab.id, msg);
  if (msg.type === 'yandex_ready') setState('translating');
});

async function yandexStart(tabId, { url, videoId, duration }) {
  setRelayTab(tabId);
  setState('connecting');
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'yandex_translate', url, videoId, duration });
}

// ---- Регистрация ----
// Хранится локально: расширение работает и без сервера. Если адрес и ключ Supabase
// заданы, запись о пользователе уходит и туда — но недоступность сервера не должна
// мешать человеку начать работу, поэтому отказ сети регистрацию не отменяет.
const ADMIN_EMAIL = '9642622@gmail.com';

// Адрес проекта и ПУБЛИЧНЫЙ ключ одинаковы для всех — им место в коде, а не в
// настройках каждого сотрудника. Ключ безопасен в открытом виде: правами базы ему
// разрешено только добавлять строки, читать журнал им нельзя (см. server/supabase.sql).
const DEFAULT_SERVER_URL = 'https://fupzvecyuchlrxxfscgi.supabase.co';
const DEFAULT_SERVER_KEY = 'sb_publishable_C-QSoXbCEWF7KAlFiFNPhw_DTji20d2';

// Настройки перекрывают умолчания — на случай отдельного проекта для проверок.
async function server() {
  const { serverUrl = '', serverKey = '' } = await chrome.storage.local.get(['serverUrl', 'serverKey']);
  return { url: (serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, ''), key: serverKey || DEFAULT_SERVER_KEY };
}

async function register(emailRaw) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return { ok: false, error: 'Неверный адрес почты' };
  const account = {
    email,
    isAdmin: email === ADMIN_EMAIL,
    registeredAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version,
  };
  await chrome.storage.local.set({ account });
  syncViewer(account);           // не ждём: сервер может быть недоступен
  return { ok: true, account };
}

async function syncViewer(account) {
  const { url, key } = await server();
  if (!url || !key) return;
  try {
    await fetch(url + '/rest/v1/viewers?on_conflict=email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([{
        email: account.email,
        last_seen: new Date().toISOString(),
        ext_version: account.version,
      }]),
    });
  } catch {} // сеть подождёт: попробуем при следующей отправке просмотров
}

// ---- Учёт просмотров ----
// События копятся локально и уходят на сервер пачкой. Сервер может быть не задан
// (пока его нет) или недоступен — тогда события ждут своей очереди на диске,
// а не теряются. Отправленное из очереди убираем, последние 500 держим для отчёта.

async function keepView(event, sender) {
  const { viewLog = [], viewQueue = [], account = null } =
    await chrome.storage.local.get(['viewLog', 'viewQueue', 'account']);
  const row = {
    ...event,
    email: account?.email || '',            // кто смотрел (по регистрации в расширении)
    tab: sender?.tab?.title?.slice(0, 120) || '',
    version: chrome.runtime.getManifest().version,
    at: Date.now(),
  };
  viewLog.push(row);
  viewQueue.push(row);
  await chrome.storage.local.set({
    viewLog: viewLog.slice(-500),
    viewQueue: viewQueue.slice(-2000),      // если сервер долго молчит, копим, но не бесконечно
  });
  sendViews();
}

async function getViews() {
  const { viewLog = [], viewQueue = [] } = await chrome.storage.local.get(['viewLog', 'viewQueue']);
  return { rows: viewLog, pending: viewQueue.length };
}

let sending = false;

async function sendViews() {
  if (sending) return;
  const { viewQueue = [], account = null } = await chrome.storage.local.get(['viewQueue', 'account']);
  const { url, key } = await server();
  if (!url || !key || !viewQueue.length) return;
  sending = true;
  try {
    // Supabase REST: пишем прямо в таблицу views публичным ключом (ему разрешён
    // только INSERT — читать журнал этим ключом нельзя, см. server/supabase.sql).
    const rows = viewQueue.map((e) => ({
      email: account?.email || null,
      storage_user: e.user || null,
      file: e.file,
      url: e.url || null,
      duration: e.duration || null,
      watched: e.watched,
      max_pos: e.maxPos || null,
      dubbed: !!e.dubbed,
      started_at: e.startedAt,
      ended_at: e.endedAt,
    }));
    const r = await fetch(url + '/rest/v1/views', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (r.ok) {
      const { viewQueue: fresh = [] } = await chrome.storage.local.get(['viewQueue']);
      // За время отправки могли добавиться новые — убираем только отправленные.
      await chrome.storage.local.set({ viewQueue: fresh.slice(viewQueue.length) });
    }
  } catch {
    // Сети нет — очередь остаётся, отправим со следующим событием.
  } finally {
    sending = false;
  }
}

// Журнал переживает крах вкладки и перезапуск фонового скрипта: он нужен именно тогда,
// когда что-то упало, а память страницы уже потеряна.
let logBuffer = [];
let logSaveTimer = null;

function keepLog(entry) {
  logBuffer.push({ t: entry.t, stage: entry.stage, text: entry.text, level: entry.level });
  if (logBuffer.length > 800) logBuffer = logBuffer.slice(-800);
  clearTimeout(logSaveTimer);
  logSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ dubLog: logBuffer, dubLogAt: Date.now() }).catch(() => {});
  }, 1000);
}

async function getLog() {
  if (logBuffer.length) return { lines: logBuffer, live: true };
  const { dubLog = [], dubLogAt = 0 } = await chrome.storage.local.get(['dubLog', 'dubLogAt']);
  return { lines: dubLog, live: false, at: dubLogAt };
}

// Падения фонового скрипта и вкладок: Chrome сообщает о них сюда.
chrome.runtime.onStartup?.addListener(() => keepLog({
  t: 0, stage: 'Система', text: 'браузер запущен, расширение поднялось', level: 'info',
}));

// Кэш готовых переводов: ключ — код файла из ссылки. Хранилище доступно только отсюда.
// Версию поднимаем, когда меняется формат кусков, — иначе всплывут переводы от старой сборки.
const CACHE_VERSION = 2;

async function cacheGet(key) {
  const { dubCache = {} } = await chrome.storage.local.get(['dubCache']);
  const entry = dubCache[key];
  if (!entry || entry.v !== CACHE_VERSION) return null;
  // Дополнительная страховка: куски должны быть размечены по говорящим.
  if (!Array.isArray(entry.chunks) || !entry.chunks[0]?.lines) return null;
  return entry;
}

async function cachePut(key, chunks, genders) {
  const { dubCache = {} } = await chrome.storage.local.get(['dubCache']);
  dubCache[key] = { v: CACHE_VERSION, chunks, genders, at: Date.now() };
  // ponytail: держим последние 5 переводов, старые вытесняем — хранилище не резиновое
  for (const k of Object.keys(dubCache).sort((a, b) => dubCache[b].at - dubCache[a].at).slice(5)) {
    delete dubCache[k];
  }
  await chrome.storage.local.set({ dubCache });
}

async function cacheDel(key) {
  const { dubCache = {} } = await chrome.storage.local.get(['dubCache']);
  delete dubCache[key];
  await chrome.storage.local.set({ dubCache });
}

async function fileStart(tabId, { url, cacheKey }) {
  setRelayTab(tabId);
  const cfg = await getConfig();
  // Расшифровка — ElevenLabs, перевод — OpenAI, озвучка — Fish (Gemini — запасная озвучка).
  if (!cfg.elevenKey) { setState('error', 'нет ключа ElevenLabs — откройте настройки расширения'); return; }
  if (!cfg.openaiKey) { setState('error', 'нет ключа OpenAI — откройте настройки расширения'); return; }
  if (!cfg.fishKey && !cfg.apiKey) {
    setState('error', 'нет ключа озвучки: впишите Fish Audio (или Gemini) в настройках');
    return;
  }
  setState('connecting');
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'file_translate', url, cacheKey, ...cfg });
}

async function syncStart(tabId, { offset, segmentS, scoutRate, prepare, engine, asr }) {
  setRelayTab(tabId);
  const cfg = await getConfig();
  if (!cfg.apiKey) { setState('error', 'нет API-ключа, откройте настройки расширения'); return; }
  setState('connecting');
  await ensureOffscreen();
  chrome.runtime.sendMessage({
    target: 'offscreen', type: 'offscreen_relay',
    ...cfg, offset, segmentS, scoutRate, prepare, engine, asr,
  });
}

async function start(tabId) {
  if (state.status !== 'idle' && state.status !== 'error') await stop(); // одна вкладка за раз
  const { apiKey, model } = await getConfig();
  if (!apiKey) { setState('error', 'нет API-ключа, откройте настройки'); return; }
  setState('connecting');
  chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, async (streamId) => {
    if (chrome.runtime.lastError || !streamId) {
      setState('error', 'не удалось захватить звук вкладки');
      return;
    }
    await ensureOffscreen();
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen_start', streamId, apiKey, model });
  });
}

async function stop() {
  // ponytail: закрытие offscreen-документа само рвёт WebSocket и захват — отдельный cleanup не нужен
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  setState('idle');
  setRelayTab(null);
}

// Свежая версия публикуется в публичном гисте (сам код — в приватном репозитории).
// Chrome не разрешает распакованному расширению обновлять свои файлы, поэтому панель
// только сообщает о новой версии; обновление — git pull + ↻ на карточке расширения.
const VERSION_URL =
  'https://gist.githubusercontent.com/9642622/3a219cf98437e58465ddcca38293f204/raw/version.json';

async function checkUpdate() {
  const mine = chrome.runtime.getManifest().version;
  try {
    const r = await fetch(VERSION_URL, { cache: 'no-store' });
    const { version, url = '', notes = '' } = await r.json();
    const newer = version && version.localeCompare(mine, undefined, { numeric: true }) > 0;
    return { latest: version, mine, newer, url, notes };
  } catch {
    return { newer: false, mine }; // нет сети — молчим, это не повод мешать переводу
  }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Захват звука вкладки и воспроизведение перевода',
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}
