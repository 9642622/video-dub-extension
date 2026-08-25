import { floatTo16BitPCM, int16ToBase64, base64ToFloat32, base64ToInt16, int16ToWavBase64 } from './pcm.js';
import { VOTClient } from './vot-bundle.js';
import {
  decodeAudioFromFile, transcribeEleven, translateAll, buildChunks, detectGenders,
  detectGendersByText,
} from './pipeline.js';

// Режим «вдогонку» (захват вкладки): gemini-3.5-live-translate-preview — конвейерная
// модель синхронного перевода речи, минимальная задержка.
// Синхро-режим (v5): качественный конвейер — сегменты по паузам -> перевод старшей
// моделью с контекстом -> нейро-TTS. Медленнее, но фора видео это скрывает.
const ORIGINAL_VOLUME = 0.2;
const TARGET_LANG = 'ru';
const WS_URL = (key) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

const GEN_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
const TRANSLATE_MODEL = 'gemini-3.6-flash';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const TTS_VOICE = 'Kore';
// Голоса Gemini TTS: раздаём по собеседникам, мужчинам мужские, женщинам женские.
const GEMINI_VOICES = {
  male: ['Puck', 'Charon', 'Fenrir', 'Orus', 'Iapetus'],
  female: ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Autonoe'],
};
const FISH_URL = 'https://api.fish.audio/v1/tts';
const FISH_MODEL = 's2.1-pro'; // лучшая модель Fish, на тарифе владельца работает (проверено)
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ASR_MODEL = 'gpt-4o-transcribe';
const SPEAKER_TAGS_PROMPT =
  'В исходном тексте реплики идут сплошным потоком без указания говорящих. Раздели диалог ' +
  'по смыслу (вопрос — ответ, смена темы, обращения) и начинай каждую реплику с новой строки ' +
  'с меткой [S1], [S2]… Одна метка = один и тот же человек на протяжении всего разговора; ' +
  'сверяйся с контекстом предыдущих минут, чтобы метки не путались.';
const TRANSLATE_PROMPT =
  'Ты профессиональный синхронный переводчик. Расшифруй речь из приложенного аудио и переведи её ' +
  'на русский язык. Верни ТОЛЬКО готовый русский перевод, без пояснений, пометок и оригинала. ' +
  'Переводи близко к оригиналу, сохраняя тон и стиль говорящего, живым естественным русским языком. ' +
  'Если аудио продолжает предыдущий фрагмент (см. контекст) — переводи как продолжение той же речи. ' +
  'Если внятной речи в аудио нет — верни слово ПУСТО.';
const TRANSCRIBE_PROMPT =
  'Расшифруй дословно речь из приложенного аудио на языке оригинала.\n' +
  'Формат ответа строго такой:\n' +
  '1) Сначала строки реплик. Каждая реплика с новой строки, в начале метка говорящего: [S1], [S2]…\n' +
  '2) Затем строка "СПИКЕРЫ:" и под ней по строке на каждого: "S1 = пол, тембр, манера, роль в разговоре".\n' +
  'Метка закреплена за человеком навсегда: если в реестре ниже уже описан S1 — тот же голос всегда ' +
  'помечай S1, даже в новом фрагменте. Новому человеку давай следующий свободный номер. ' +
  'Не переименовывай и не меняй местами уже известных спикеров. ' +
  'Если внятной речи в аудио нет — верни слово ПУСТО.';
const OPENAI_PROMPT =
  'Ты профессиональный переводчик-синхронист, носитель русского языка. Переводи присланный текст ' +
  'на русский: только готовый перевод, без пояснений и оригинала. Близко к тексту, без сокращений, ' +
  'сохраняя тон, стиль и эмоции говорящего, живым естественным русским языком. Метки говорящих ' +
  '[S1], [S2]… в начале строк сохраняй в точности как в оригинале. Присланный текст — ' +
  'продолжение речи из контекста: переводи как её продолжение, связно.';

// Длинные куски: модель слышит связный разговор целиком — стабильнее метки говорящих
// и точнее перевод. Потолок ~6 минут: запрос к Gemini ограничен 20 МБ, а минута звука
// в 16 кГц весит ~2 МБ (плюс треть на base64).
let segMinS = 300;            // раньше этого сегмент не режем (настраивается из панели)
let segMaxS = 360;            // жёсткий предел сегмента
let scoutRate = 1;            // во сколько раз разведчик быстрее реального времени
let engine = 'gemini';        // движок озвучки: 'gemini' | 'fish'
let asr = 'gemini';           // движок расшифровки: 'gemini' | 'openai'
const TTS_CHUNK_CHARS = 900;  // длинный текст режем по предложениям — лимит TTS
const SILENCE_RMS = 0.015;    // тише этого — считаем паузой
const CHUNK_S = 0.1;          // чанки по 100 мс

let cfg = null;          // { streamId?, apiKey, model }
let ws = null;
let setupDone = false;
let ctxOut = null;       // приглушённый оригинал (режим захвата) + воспроизведение перевода
let nextStartTime = 0;
let scheduled = [];      // играющие AudioBufferSourceNode перевода
let relayMode = false;   // синхро-режим: чанки приходят со страницы
let offset = 5;          // сдвиг озвучки в синхро-режиме, сек
let segChunks = [];      // Int16Array-куски текущего сегмента (v5)
let segLoud = false;     // была ли в сегменте речь громче порога
let jobQueue = Promise.resolve(); // сегменты обрабатываются строго по очереди
let contextText = '';    // хвост перевода для связности между сегментами
let contextSource = '';  // хвост расшифровки — чтобы метки спикеров не путались
const speakerRegistry = {}; // S1 -> «мужской, низкий, ведущий»: закрепляет метку за человеком
let firstPlayback = true;
let voiceWarned = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'offscreen_start') start(msg);
  if (msg.type === 'offscreen_relay') startRelay(msg);
  if (msg.type === 'audio_chunk') relayMode ? pushChunk(msg.data) : sendEncodedChunk(msg.data);
  if (msg.type === 'set_offset') offset = msg.value;
  if (msg.type === 'yandex_translate') yandexTranslate(msg);
  if (msg.type === 'yandex_audio_load') loadYandexTrack(msg.url);
  if (msg.type === 'yandex_audio_sync') syncYandexTrack(msg);
  if (msg.type === 'yandex_audio_stop') stopYandexTrack();
  if (msg.type === 'kick_speech') kickSpeech();
  if (msg.type === 'make_summary') makeSummary(msg.text);
  if (msg.type === 'prepare_finish') finishPreparation();
  if (msg.type === 'file_translate') translateFile(msg);
  if (msg.type === 'speak_request') onSpeakRequest(msg);
  if (msg.type === 'forget_cache') forgetCache(msg.key);
  if (msg.type === 'video_started') { videoStarted = true; kickSpeech(); }
  if (msg.type === 'video_paused') { videoStarted = false; if (speechAudio) speechAudio.pause(); }
  if (msg.type === 'video_resumed') {
    videoStarted = true;
    if (speechAudio && speechAudio.paused && speechAudio.src) speechAudio.play().catch(() => {});
    else kickSpeech();
  }
});

// Дорожка играет здесь, а не на странице: сайты вроде ownCloud запрещают
// сторонние медиа своей CSP, и <audio> на странице молча не грузится.
let trackAudio = null;

function loadYandexTrack(url) {
  stopYandexTrack();
  trackAudio = new Audio(url);
  trackAudio.preload = 'auto';
  trackAudio.onerror = () => report('error', 'дорожка не загрузилась (ссылка устарела?)');
}

function syncYandexTrack({ time, paused }) {
  if (!trackAudio) return;
  if (Math.abs(trackAudio.currentTime - time) > 0.4) trackAudio.currentTime = time;
  if (paused) {
    if (!trackAudio.paused) trackAudio.pause();
  } else if (trackAudio.paused) {
    trackAudio.play().catch((e) => report('error', 'звук заблокирован: ' + e.message));
  }
}

function stopYandexTrack() {
  if (!trackAudio) return;
  trackAudio.pause();
  trackAudio.src = '';
  trackAudio = null;
}

// ================= Перевод файла целиком, озвучка по ходу просмотра =================

// Воспроизведением занимается САМА СТРАНИЦА (content.js): только она видит видео.
// Здесь — тупой синтезатор: «пришёл номер куска — верни байты озвучки». Никаких
// представлений о времени, паузе или перемотке у этого документа нет и быть не должно:
// прошлая архитектура (звук здесь, видео там, между ними пересказ состояния сообщениями)
// и была причиной рассинхрона.
let chunks = [];              // {start, end, speaker, text} — что и когда говорить
const speechCache = new Map();// индекс куска -> Blob готовой озвучки (кэш на сессию)
const speaking = new Set();   // куски, которые синтезируются прямо сейчас
const speakQueue = [];        // очередь заявок от страницы

// Маска ключа для журнала: видно, ТОТ ли ключ используется, но сам ключ не светится.
function maskKey(k) {
  return k ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} симв.)` : 'ПУСТО';
}

async function translateFile({ url, cacheKey, duration, ...cfgIn }) {
  cfg = cfgIn;
  log('Ключи', `Fish: ${maskKey(cfg.fishKey)} · ElevenLabs: ${maskKey(cfg.elevenKey)}`);
  // Видно, какие голоса реально в деле: из настроек или встроенные.
  const pack = (list, def) => (list?.length ? `из настроек ${list.map((v) => v.slice(0, 8)).join(', ')}` :
    `встроенные ${def.map((v) => v.slice(0, 8)).join(', ')}`);
  log('Голоса', `мужские — ${pack(cfg.fishMale, VOICES.m.slice(0, 2))}; ` +
    `женские — ${pack(cfg.fishFemale, VOICES.f.slice(0, 2))}`);
  // Новый запуск — старые заявки и озвучки не нужны.
  speaking.clear();
  speakQueue.length = 0;
  speechCache.clear();
  speakerGenders = {};
  fishDead = false; // новый запуск — ключ мог поменяться
  try {
    const cached = await loadCached(cacheKey);
    // Сверяем длительность: перевод чужого ролика не должен подставиться под этот.
    const cachedEnd = cached ? Math.round(cached.chunks[cached.chunks.length - 1]?.end || 0) : 0;
    // Без длительности сверять не с чем — тогда кэшу не доверяем вовсе.
    const fits = cached && duration > 0 && Math.abs(cachedEnd - duration) < duration * 0.2 + 30;
    if (cached && !fits) log('Кэш', 'сохранённый перевод от другого ролика — перевожу заново', 'warn');
    if (fits) {
      chunks = cached.chunks;
      speakerGenders = cached.genders || {};
      log('Кэш', `перевод этого файла уже готов: ${chunks.length} кусков`, 'ok');
    } else {
      const t0 = Date.now();
      const since = () => `${Math.round((Date.now() - t0) / 1000)} с от старта`;

      const samples = await decodeAudioFromFile(url, log,
        (got, total) => sendProgress('скачивание', Math.round(got / 1e6), Math.round(total / 1e6)));
      log('Этап', `звук получен — ${since()}`, 'ok');

      const tAsr = Date.now();
      // Расшифровка — только ElevenLabs Scribe: различает говорящих по голосу и даёт
      // пунктуацию. Запасной Whisper убран: он выдумывал текст на музыке и тишине.
      if (!cfg.elevenKey) {
        throw new Error('нет ключа ElevenLabs — впишите его в настройках расширения');
      }
      const cues = await transcribeEleven(samples, cfg.elevenKey, log,
        (done, total) => sendProgress('расшифровка', done, total));
      if (!cues.length) throw new Error('речь не распознана');
      log('Этап', `расшифровка заняла ${Math.round((Date.now() - tAsr) / 1000)} с — ${since()}`, 'ok');

      // Кто есть кто — ДО перевода: переводчику нужно знать пол, чтобы род в первом
      // лице («я сделал» / «я сделала») был одинаков во всей записи.
      speakerGenders = detectGenders(samples, cues);
      log('Голоса', 'по голосу: ' + Object.entries(speakerGenders)
        .map(([s, g]) => `S${s} — ${g === 'f' ? 'женский' : 'мужской'}`).join(', '), 'ok');
      // Уточняем по расшифровке: грамматический род («sono andata»), имена и обращения
      // надёжнее высоты голоса на пограничных голосах.
      const byText = await detectGendersByText(cues, cfg, log);
      for (const [s, g] of Object.entries(byText)) {
        if (speakerGenders[s] && speakerGenders[s] !== g) {
          log('Голоса', `S${s}: по голосу ${speakerGenders[s] === 'f' ? 'женский' : 'мужской'}, ` +
            `по тексту ${g === 'f' ? 'женский' : 'мужской'} — верю тексту`, 'warn');
        }
        speakerGenders[s] = g;
      }
      log('Голоса', 'итог: ' + Object.entries(speakerGenders)
        .map(([s, g]) => `S${s} — ${g === 'f' ? 'женщина' : 'мужчина'}`).join(', '), 'ok');

      const tTr = Date.now();
      let started = false;
      await translateAll(cues, cfg, log,
        (done, total) => sendProgress('перевод', done, total),
        (ready) => {
          // Готовое начало отдаём сразу — смотреть можно, не дожидаясь всего перевода.
          if (ready.length < 5) return;
          chunks = buildChunks(ready);
          chrome.runtime.sendMessage({
            target: 'background', type: started ? 'file_more' : 'file_ready', chunks,
          });
          if (!started) {
            started = true;
            log('Готово', `первые ${chunks.length} кусков готовы — можно смотреть`, 'ok');
          }
        }, speakerGenders);
      log('Этап', `перевод занял ${Math.round((Date.now() - tTr) / 1000)} с — ${since()}`, 'ok');

      chunks = buildChunks(cues);
      chrome.runtime.sendMessage({ target: 'background', type: 'file_more', chunks });
      const avg = chunks.length ? (cues.length / chunks.length).toFixed(1) : 0;
      log('Готово', `${chunks.length} кусков озвучки (в среднем ${avg} реплик в куске), ` +
        `всего ${Math.round((Date.now() - t0) / 1000)} с`, 'ok');
      await saveCached(cacheKey, chunks, speakerGenders);
    }
    chrome.runtime.sendMessage({ target: 'background', type: 'file_ready', chunks });
  } catch (e) {
    // Нехватку памяти браузер сообщает по-разному — переводим в понятную причину.
    const memory = /allocation|out of memory|Array buffer allocation failed/i.test(e.message);
    const why = memory
      ? 'не хватило памяти на такой большой файл'
      : `${e.name || 'Ошибка'}: ${e.message}`;
    log('Ошибка', why, 'error');
    if (e.stack) log('Ошибка', e.stack.split('\n').slice(0, 3).join(' | '), 'error');
    report('error', why);
  }
}

function sendProgress(stage, done, total) {
  chrome.runtime.sendMessage({ target: 'background', type: 'file_progress', stage, done, total });
}

// В offscreen-документе из API расширения доступен только обмен сообщениями,
// поэтому с хранилищем работает фоновый скрипт.
async function loadCached(key) {
  if (!key) return null;
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'cache_get', key });
  return res && res.chunks ? { chunks: res.chunks, genders: res.genders } : null;
}

async function saveCached(key, data, genders) {
  if (!key) return;
  await chrome.runtime.sendMessage({
    target: 'background', type: 'cache_put', key, chunks: data, genders,
  });
}

async function forgetCache(key) {
  await chrome.runtime.sendMessage({ target: 'background', type: 'cache_del', key });
  log('Кэш', 'сохранённый перевод удалён', 'ok');
}

// Заявка от страницы: «нужна озвучка вот этого текста» (ключ — содержимое куска,
// а не номер: номера сдвигаются, пока перевод доходит частями, и озвучка под старым
// номером оказывалась чужим текстом). Готовое — из кэша, новое — в очередь.
function onSpeakRequest(req) {
  if (!req || !req.key || !req.text) return;
  if (speechCache.has(req.key)) { sendSpeech(req.key); return; }
  if (speaking.has(req.key) || speakQueue.some((q) => q.key === req.key)) return;
  if (fishDead && cfg?.fishKey) return; // ключ отвергнут — не крутим вхолостую
  speakQueue.push(req);
  pumpSpeech();
}

// Больше трёх запросов одновременно держать нельзя: сервисы режут по числу обращений в минуту.
function pumpSpeech() {
  while (speaking.size < 3 && speakQueue.length) {
    const req = speakQueue.shift();
    speaking.add(req.key);
    synthChunk(req);
  }
}

async function synthChunk(req) {
  let usedVoice = '';
  try {
    let blob = null;
    if (cfg.fishKey) {
      // Основной путь: Fish Audio, свой голос каждому собеседнику.
      const manual = (cfg.fishVoice || '').split(',').map((s) => s.trim()).filter(Boolean);
      const vid = voiceFor(req.speaker, manual);
      usedVoice = vid;
      // Скорость речи просим у самого синтезатора: он ускоряет без изменения высоты
      // голоса. Ускорять готовый звук на странице нельзя — playbackRate в Web Audio
      // сдвигает тон, и один голос звучит как разные люди.
      const room = Math.max(1, req.end - req.start);
      const expected = req.text.length / 15; // русская речь ~15 символов в секунду
      // Выше 1,25× речь звучит тараторящей — лучше слегка вылезти за фразу.
      const speed = Math.min(1.25, Math.max(1, expected / room));
      log('Голос', `${clockOf(req.start)}: S${req.speaker} → ${vid ? vid.slice(0, 8) + '…' : 'нет'}` +
        (speed > 1.05 ? ` · скорость ${speed.toFixed(2)}` : ''));
      blob = await fishSpeak(req.text, vid, speed);
    } else {
      const speech = await ttsDialog(req); // запасной путь, если ключа Fish нет
      if (speech) {
        const i16 = base64ToInt16(speech.data);
        const wavB64 = int16ToWavBase64(i16, speech.rate);
        blob = new Blob([Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))], { type: 'audio/wav' });
      }
    }
    // Не вышло — страница пропустит реплику по сроку, видео не зависнет.
    if (!blob) return;
    speechCache.set(req.key, blob);
    sendSpeech(req.key);
  } finally {
    speaking.delete(req.key);
    pumpSpeech();
  }
}

async function sendSpeech(key) {
  const blob = speechCache.get(key);
  chrome.runtime.sendMessage({
    target: 'background', type: 'speech_data', key,
    b64: await blobToBase64(blob), mime: blob.type || 'audio/wav',
  });
}

// Байты озвучки уходят на страницу сообщением, а сообщения — только текстовые.
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function clockOf(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// ---- Голоса: соответствуют полу и не меняются до конца записи ----
// Пол каждого спикера определён по высоте его голоса из самой записи (см. detectGenders),
// поэтому выбор детерминирован: тот же ролик — всегда те же голоса, и внутри записи
// голос закреплён за человеком. Каталог Fish не опрашиваем: его выдача менялась
// день ото дня, из-за этого голоса «скакали» между запусками.
// Свои голоса: ID через запятую в настройках — список заменит встроенный по номерам спикеров.
// ponytail: клоны голосов реальных людей сознательно не используем.
// Порядок = приоритет: первые — основные (выбор владельца: №2 и №3 из пакета),
// дальше — запас для дополнительных участников. Назначение детерминировано
// (пол — по высоте голоса из записи, номер — по порядку вступления в разговор),
// поэтому выданный голос держится до конца беседы и одинаков между запусками.
const VOICES = {
  m: [
    'f175cd7c61de4898960f1fa4b8044124', // «точно» — дикторский, ровный (№15) — выбор владельца
    '868377a7b08f4c0d9acf8c9f059571aa', // молодой аналитик (№3) — выбор владельца
    '7312c38557eb4fb384e3874e8e9cea67', // профессиональный, ровный (№4) — на третьего
    '563736b1eb904cb29572f5eb5d9c46d2', // Анатолий, постарше (№5)
    'efe82aa926bc4e0a85b3ef4933a97a7f', // глубокий
    '39a4e619463b464fb726ebd73be6ba52', // спокойный
    'af5a794626ce47988446235baed3b0af', // глубокий, постарше
  ],
  f: [
    '6aea743fab7e4b2b99ad7b3b8129b8ce', // Юлия Романова (№13) — выбор владельца
    'd567e990d9ad433892ed15ecfd70ce54', // молодой, звонкий (№11) — выбор владельца
    'f14e1f9fb32d4dbd8cd5b40a0fef86a5', // дикторский (№12)
    '2a1036d645634680b3cc69aeeb60375b', // спокойный
    'aa615eaff73f417e91cfbb4ea0e42df8', // средних лет
    'e64409e787324864bdf9e5c1b6acd97a', // тёплый спокойный
    '6d4d6122fa0244b5b801e50f0beac378', // мягкий
  ],
};

let speakerGenders = {}; // номер спикера -> 'm' | 'f', из расшифровки текущего ролика

function voiceFor(speaker, manualVoices) {
  const n = speaker || 1;
  if (manualVoices.length) return manualVoices[(n - 1) % manualVoices.length];
  const g = speakerGenders[n] || 'm';
  // Пакет из настроек (галочки) важнее встроенного списка.
  const pack = g === 'f'
    ? (cfg?.fishFemale?.length ? cfg.fishFemale : VOICES.f)
    : (cfg?.fishMale?.length ? cfg.fishMale : VOICES.m);
  // Номер среди спикеров того же пола: у каждого свой голос, порядок стабилен.
  const sameGender = Object.keys(speakerGenders)
    .filter((s) => (speakerGenders[s] || 'm') === g)
    .sort((a, b) => a - b);
  const idx = Math.max(0, sameGender.indexOf(String(n)));
  return pack[idx % pack.length];
}

// «[S2] текст…» построчно -> [{speaker: 2, text}]; подряд идущие реплики одного склеиваем.
function splitBySpeaker(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[?S(\d+)\]?\s*[:\-]?\s*(.*)$/.exec(line);
    const speaker = m ? parseInt(m[1], 10) : 0;
    const body = (m ? m[2] : line).trim();
    if (!body) continue;
    const prev = out[out.length - 1];
    if (prev && prev.speaker === speaker) prev.text += ' ' + body;
    else out.push({ speaker, text: body });
  }
  return out;
}

// Длинный перевод режем по границам предложений — TTS не любит простыни.
function splitForTTS(text) {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const parts = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > TTS_CHUNK_CHARS) { parts.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// ponytail: разные голоса на спикера — только через Fish; Gemini-путь говорит одним голосом
// Голос Gemini закрепляется за спикером на всю запись, пол берём из реестра.
const geminiAssign = {};
function geminiVoiceFor(speaker) {
  const key = `S${speaker || 1}`;
  if (geminiAssign[key]) return geminiAssign[key];
  const desc = (speakerRegistry[key] || '').toLowerCase();
  const wantFemale = /женск|female/.test(desc);
  const primary = wantFemale ? GEMINI_VOICES.female : GEMINI_VOICES.male;
  const fallback = wantFemale ? GEMINI_VOICES.male : GEMINI_VOICES.female;
  const used = new Set(Object.values(geminiAssign));
  geminiAssign[key] = [...primary, ...fallback].find((v) => !used.has(v)) || TTS_VOICE;
  log('Голос', `${key} → ${geminiAssign[key]}`, 'ok');
  return geminiAssign[key];
}

async function speakWithGemini(text, segIndex = -1, segStart = 0, voice = TTS_VOICE) {
  const speech = await ttsSpeak(text.replace(/^\[S\d+\]\s*/gm, ''), voice);
  if (!speech) return;
  const i16 = base64ToInt16(speech.data);
  const wavB64 = int16ToWavBase64(i16, speech.rate);
  const bytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));
  enqueueSpeech(new Blob([bytes], { type: 'audio/wav' }), segIndex, segStart);
}

// Очередь озвучки: обычный плеер (в offscreen он точно звучит, проверено на дорожке Яндекса).
const speechQueue = [];
let speechPlaying = false;
let speechAudio = null;
let videoStarted = false; // озвучка ждёт старта видео: она бывает готова раньше
let prepareMode = false;  // «перевести всё заранее»: копим озвучку, не играем
let videoTime = 0;        // текущая позиция видео — чтобы отрезки звучали вовремя
let segReady = 0;         // сколько отрезков уже озвучено

function enqueueSpeech(blob, segIndex = -1, segStart = 0) {
  const wasEmpty = !speechQueue.length;
  speechQueue.push({ url: URL.createObjectURL(blob), segIndex, segStart });
  if (prepareMode) return; // всё копим, играть начнём после полной подготовки
  // Первая готовая озвучка — сигнал странице: можно запускать видео, ждать больше нечего.
  if (!videoStarted) chrome.runtime.sendMessage({ target: 'background', type: 'speech_ready' });
  else if (wasEmpty) chrome.runtime.sendMessage({ target: 'background', type: 'queue_refilled' });
  if (!speechPlaying) playNextSpeech();
}

// ---- «Яндекс-дорожка»: неофициальный API перевода видео (тот же движок, что в Яндекс.Браузере) ----

let yandexActive = false;

// Ответ об ошибке приходит бинарным protobuf, иногда вложенным в {success, data}.
function describeErrorData(data, depth = 0) {
  if (data == null || depth > 2) return '';
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const buf = ArrayBuffer.isView(data) ? data.buffer : data;
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const readable = (raw.match(/[ -~А-Яа-яЁё]{4,}/g) || []).join(' | ').trim();
    return readable || `бинарный ответ, ${buf.byteLength} байт`;
  }
  if (typeof data === 'string') return data.slice(0, 160);
  if (typeof data === 'object') {
    return describeErrorData(data.data ?? data.message ?? data.error, depth + 1)
      || JSON.stringify(data).slice(0, 160);
  }
  return String(data).slice(0, 160);
}

async function yandexTranslate({ url, videoId, duration }) {
  yandexActive = true;
  let lastStatus = 0;
  const client = new VOTClient({
    fetchOpts: { credentials: 'omit', cache: 'no-store' },
    // ponytail: Sec-* заголовки браузер вырезает, но Яндекс их и не требует (проверено)
    fetchFn: async (input, init = {}) => {
      const r = await fetch(input, init);
      lastStatus = r.status;
      return r;
    },
  });
  const videoData = { url, videoId, host: 'custom', duration };
  for (let attempt = 0; attempt < 30 && yandexActive; attempt++) { // до ~10 минут ожидания
    let res;
    try {
      res = await client.translateVideo({ videoData, requestLang: 'en', responseLang: 'ru' });
    } catch (e) {
      const detail = describeErrorData(e.data);
      if (attempt < 2) { // первые сбои бывают временными — пробуем ещё пару раз
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      report('error', `Яндекс [HTTP ${lastStatus || '?'}]: ${e.message || 'ошибка'}${detail ? ' — ' + detail.slice(0, 90) : ''}`);
      return;
    }
    if (res.translated && res.url) {
      chrome.runtime.sendMessage({ target: 'background', type: 'yandex_ready', url: res.url });
      return;
    }
    const wait = Math.min(Math.max(res.remainingTime || 20, 10), 60);
    chrome.runtime.sendMessage({
      target: 'background', type: 'yandex_progress',
      remaining: res.remainingTime > 0 ? res.remainingTime : 0,
      // 2 — обычное ожидание, 3 — «долгое» (видео в очереди надолго)
      longWait: res.status === 3,
    });
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  if (yandexActive) report('error', 'Яндекс: дорожка не готова за 10 минут, попробуйте позже');
}

// ---- v5: качественный конвейер синхро-режима ----

function pushChunk(b64) {
  const i16 = base64ToInt16(b64);
  let sum = 0;
  for (let i = 0; i < i16.length; i++) { const v = i16[i] / 0x8000; sum += v * v; }
  const rms = Math.sqrt(sum / (i16.length || 1));
  segChunks.push(i16);
  if (rms >= SILENCE_RMS) segLoud = true;
  const secs = segChunks.length * CHUNK_S;
  if ((secs >= segMinS && rms < SILENCE_RMS) || secs >= segMaxS) cutSegment();
}

function cutSegment() {
  const chunks = segChunks;
  const hadSpeech = segLoud;
  segChunks = [];
  segLoud = false;
  if (!chunks.length) return;
  // Длительность в секундах видео: поток идёт ускоренным, поэтому умножаем на скорость.
  const videoSeconds = chunks.length * CHUNK_S * (scoutRate || 1);
  if (!hadSpeech) { videoClock += videoSeconds; return; } // тишина — не тратим ключ
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Int16Array(total);
  let p = 0;
  for (const c of chunks) { merged.set(c, p); p += c.length; }
  const wav = int16ToWavBase64(merged, 16000);
  log('Отрезок', `нарезан: ${Math.round(videoSeconds)} с видео, ${(wav.length / 1e6).toFixed(1)} МБ`);
  jobQueue = jobQueue.then(() => processSegment(wav, videoSeconds))
    .catch((e) => log('Отрезок', 'сбой обработки: ' + e.message, 'error'));
}

let segCounter = 0;
let videoClock = 0; // сколько секунд видео уже «прослушано» разведчиком

async function processSegment(wavB64, segDurationS) {
  const segIndex = segCounter++;
  const segStart = videoClock;
  videoClock += segDurationS;
  // Перевод: с ключом OpenAI — два шага (Gemini расшифровка -> OpenAI перевод),
  // без него — Gemini делает всё одним запросом.
  let text;
  let source = '';
  if (cfg.openaiKey && asr === 'openai') {
    source = await transcribeWithOpenAI(wavB64);
    if (!source) return;
    text = await openaiTranslate(source, true); // спикеров размечает переводчик
  } else if (cfg.openaiKey) {
    source = await transcribeAudio(wavB64);
    if (!source) return;
    text = await openaiTranslate(source);
  } else {
    text = await translateAudio(wavB64);
  }
  if (!text) return;
  chrome.runtime.sendMessage({
    target: 'background', type: 'transcript',
    source, translation: text,
    speakers: Object.entries(speakerRegistry).map(([id, d]) => `${id} = ${d}`).join('\n'),
  });
  contextText = (contextText + ' ' + text).slice(-1500);

  // Свой голос каждому собеседнику; метка [S1] закреплена за человеком реестром спикеров,
  // поэтому голос у него один и тот же от начала до конца записи.
  const useFish = engine === 'fish' && cfg.fishKey;
  for (const line of splitBySpeaker(text)) {
    for (const part of splitForTTS(line.text)) {
      if (useFish) {
        const voices = (cfg.fishVoice || '').split(',').map((s) => s.trim()).filter(Boolean);
        const blob = await fishSpeak(part, await voiceFor(line.speaker, voices));
        if (blob) enqueueSpeech(blob, segIndex, segStart);
      } else {
        await speakWithGemini(part, segIndex, segStart, geminiVoiceFor(line.speaker));
      }
    }
  }
  segReady++;
  if (prepareMode) {
    chrome.runtime.sendMessage({ target: 'background', type: 'prepare_progress', done: segReady });
  }
}

// Разведчик добежал до конца — дорезаем хвост и ждём, пока обработается очередь.
async function finishPreparation() {
  cutSegment();
  await jobQueue;
  chrome.runtime.sendMessage({
    target: 'background', type: 'all_ready', pieces: speechQueue.length, segments: segReady,
  });
}

function playNextSpeech() {
  if (!videoStarted) { speechPlaying = false; return; } // ждём, пока видео реально пойдёт
  // Готовый перевод не должен обгонять картинку: ждём, пока видео дойдёт до начала отрезка.
  const head = speechQueue[0];
  if (head && head.segStart > videoTime + 0.5) {
    speechPlaying = true;
    setTimeout(playNextSpeech, 500);
    return;
  }
  const item = speechQueue.shift();
  if (!item) {
    speechPlaying = false;
    // Озвучка кончилась, следующий отрезок ещё готовится — просим придержать видео.
    if (videoStarted && !prepareMode) {
      chrome.runtime.sendMessage({ target: 'background', type: 'queue_empty' });
    }
    return;
  }
  const { url, segIndex } = item;
  speechPlaying = true;
  speechAudio = new Audio(url);
  const next = () => { URL.revokeObjectURL(url); playNextSpeech(); };
  speechAudio.onended = next;
  speechAudio.onerror = next;
  speechAudio.play().then(
    () => {
      if (firstPlayback) { firstPlayback = false; report('translating'); }
      if (segIndex >= 0) {
        chrome.runtime.sendMessage({ target: 'background', type: 'speaking', index: segIndex });
      }
    },
    () => {
      // Браузер требует клик пользователя — просим показать кнопку и ждём.
      speechQueue.unshift(item);
      speechPlaying = false;
      chrome.runtime.sendMessage({ target: 'background', type: 'need_gesture' });
    },
  );
}

function kickSpeech() {
  if (!speechPlaying) playNextSpeech();
}

const SUMMARY_PROMPT =
  'Ниже стенограмма разговора (перевод на русский). Составь деловое резюме на русском языке ' +
  'строго по разделам, без вступлений и воды:\n\n' +
  'О ЧЁМ РАЗГОВОР — 2-3 предложения.\n' +
  'О ЧЁМ ДОГОВОРИЛИСЬ — маркированный список конкретных договорённостей; если о чём-то ' +
  'договориться не удалось, так и напиши.\n' +
  'РЕШЕНИЯ И ИТОГ — к чему в итоге пришёл разговор.\n' +
  'ЗАДАЧИ — кто что должен сделать и к какому сроку (если сроки прозвучали).\n' +
  'ОТКРЫТЫЕ ВОПРОСЫ — что осталось нерешённым.\n\n' +
  'Опирайся только на стенограмму, ничего не додумывай. Если раздел пуст — напиши «не обсуждалось».';

async function makeSummary(text) {
  if (!text || !text.trim()) { report('error', 'сводка: текста пока нет'); return; }
  let summary = '';
  if (cfg?.openaiKey) {
    const j = await postWithRetry(OPENAI_URL, {
      model: cfg.openaiModel,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: text.slice(-60000) },
      ],
    }, 'сводка', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.openaiKey}`,
    });
    summary = j?.choices?.[0]?.message?.content?.trim() || '';
  } else if (cfg?.apiKey) {
    const j = await postWithRetry(GEN_URL(TRANSLATE_MODEL, cfg.apiKey), {
      contents: [{ parts: [{ text: SUMMARY_PROMPT + '\n\nСтенограмма:\n' + text.slice(-60000) }] }],
    }, 'сводка');
    summary = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  }
  if (summary) chrome.runtime.sendMessage({ target: 'background', type: 'summary', text: summary });
  else report('error', 'сводка не получилась');
}


async function transcribeAudio(wavB64) {
  const registry = Object.entries(speakerRegistry)
    .map(([id, desc]) => `${id} = ${desc}`).join('\n');
  const prompt = TRANSCRIBE_PROMPT
    + (registry ? `\n\nРеестр уже известных спикеров (метки менять нельзя):\n${registry}` : '')
    + (contextSource ? `\n\nКонец предыдущей расшифровки:\n${contextSource}` : '');
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'audio/wav', data: wavB64 } },
      ],
    }],
  };
  log('Gemini', `расшифровка: отправляю ${(wavB64.length / 1e6).toFixed(1)} МБ`);
  const j = await postWithRetry(GEN_URL(TRANSLATE_MODEL, cfg.apiKey), body, 'расшифровка');
  if (!j) { log('Gemini', 'расшифровка не удалась', 'error'); return ''; }
  const raw = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!raw || raw === 'ПУСТО') { log('Gemini', 'речи в отрезке нет', 'warn'); return ''; }
  log('Gemini', `расшифровано ${raw.length} символов`, 'ok');

  // Отделяем реестр спикеров от реплик и запоминаем описания — они стабилизируют метки.
  const [replicas, speakersBlock = ''] = raw.split(/^\s*СПИКЕРЫ:\s*$/mi);
  for (const line of speakersBlock.split('\n')) {
    const m = /^\s*(S\d+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !speakerRegistry[m[1]]) speakerRegistry[m[1]] = m[2].slice(0, 120);
  }
  const text = replicas.trim();
  contextSource = (contextSource + '\n' + text).slice(-1200);
  return text;
}

// Расшифровка силами OpenAI: быстрее и не зависит от квот Google. Меток говорящих не даёт —
// их расставит переводчик по смыслу диалога.
async function transcribeWithOpenAI(wavB64) {
  const bytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  fd.append('model', ASR_MODEL);
  log('OpenAI', `расшифровка: ${(bytes.length / 1e6).toFixed(1)} МБ, модель ${ASR_MODEL}`);
  const started = performance.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${cfg.openaiKey}` }, body: fd,
      });
    } catch (e) {
      log('OpenAI', 'сеть: ' + e.message, 'error');
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    if (r.ok) {
      const j = await r.json();
      const t = (j.text || '').trim();
      log('OpenAI', `расшифровано ${t.length} символов за ${((performance.now() - started) / 1000).toFixed(0)} с`, 'ok');
      return t;
    }
    if (r.status === 429 || r.status === 503) {
      log('OpenAI', `лимит, жду 15 с (попытка ${attempt + 1}/4)`, 'warn');
      await new Promise((res) => setTimeout(res, 15000));
      continue;
    }
    log('OpenAI', `расшифровка HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`, 'error');
    return '';
  }
  return '';
}

async function openaiTranslate(sourceText, needSpeakerTags = false) {
  const body = {
    model: cfg.openaiModel,
    messages: [
      { role: 'system', content: OPENAI_PROMPT + (needSpeakerTags ? '\n\n' + SPEAKER_TAGS_PROMPT : '') },
      {
        role: 'user',
        content: (contextText ? `Контекст — мой перевод предыдущих минут:\n${contextText}\n\n` : '') +
          `Переведи:\n${sourceText}`,
      },
    ],
  };
  log('OpenAI', `перевод: ${sourceText.length} символов, модель ${cfg.openaiModel}`);
  const j = await postWithRetry(OPENAI_URL, body, 'перевод OpenAI', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.openaiKey}`,
  });
  const out = j?.choices?.[0]?.message?.content?.trim() || '';
  log('OpenAI', out ? `переведено ${out.length} символов` : 'перевод не получен', out ? 'ok' : 'error');
  return out;
}

let fishDead = false; // ключ отвергнут — больше не стучимся

async function fishSpeak(text, voiceId, speed = 1) {
  if (fishDead) return null; // ключ отвергнут — не спамим журнал сливом очереди
  const started = performance.now();
  log('Fish', `запрос: ${text.length} симв., голос ${voiceId ? voiceId.slice(0, 8) + '…' : 'не задан'}`);
  // Моргнувшая сеть или лимит — не приговор куску: пробуем ещё, иначе фраза
  // теряется навсегда и в переводе возникает немая дыра.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (fishDead) return null;
    let r;
    try {
      r = await fetch(FISH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.fishKey}`,
          'Content-Type': 'application/json',
          'model': FISH_MODEL,
        },
        body: JSON.stringify({
          text,
          format: 'wav',
          // Измерено: без ограничения тот же голос гуляет по высоте на 64 Гц от куска
          // к куску (89–165 Гц — от баса до женского), при 0.3 разброс падает до 29 Гц.
          // 0.2 звучало мертвенно, 0.3 — компромисс живости и постоянства.
          temperature: 0.3,
          top_p: 0.7,
          // Подгонка темпа на стороне синтезатора: высота голоса не меняется.
          ...(speed > 1.05 ? { prosody: { speed: Math.round(speed * 20) / 20, volume: 0 } } : {}),
          ...(voiceId ? { reference_id: voiceId } : {}),
        }),
      });
    } catch (e) {
      log('Fish', `сеть: ${e.message} — попытка ${attempt + 1} из 4`, 'warn');
      await new Promise((res) => setTimeout(res, 2500 * (attempt + 1)));
      continue;
    }
    if (r.ok) {
      const blob = await r.blob();
      log('Fish', `готово: ${(blob.size / 1024).toFixed(0)} КБ за ${((performance.now() - started) / 1000).toFixed(1)} с`, 'ok');
      return blob;
    }
    const errText = await r.text().catch(() => '');
    // Неверный ключ и пустой счёт сами не починятся — прекращаем попытки,
    // иначе журнал заполняется сотнями одинаковых отказов.
    if (r.status === 401 || r.status === 402 || r.status === 403) {
      const why = r.status === 402 ? 'нет баланса, пополните счёт' : 'неверный ключ в настройках расширения';
      if (!fishDead) {
        fishDead = true;
        log('Fish', `HTTP ${r.status}: ${why} — озвучка остановлена. ` +
          `Использовался ключ ${maskKey(cfg.fishKey)}. Ответ: ${errText.slice(0, 100)}`, 'error');
        report('error', `Озвучка Fish: ${why}`);
      }
      return null;
    }
    log('Fish', `отказ ${r.status}: ${errText.slice(0, 120)} — попытка ${attempt + 1} из 4`, 'warn');
    await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
  }
  log('Fish', 'кусок не озвучился после четырёх попыток', 'error');
  return null;
}

// POST с повторами: 429/503 (лимиты тарифа) ждём и пробуем ещё раз.
// Пауз нужно много: у Google лимит считается по токенам в минуту, а аудио «весит» дорого.
async function postWithRetry(url, body, label, headers = { 'Content-Type': 'application/json' }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      log(label, 'сеть: ' + e.message, 'error');
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    if (r.ok) return r.json();
    if (r.status === 429 || r.status === 503) {
      const raw = await r.text().catch(() => '');
      // Google подсказывает, сколько ждать — уважаем его цифру, иначе растём сами.
      const suggested = parseFloat(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(raw)?.[1] || '0');
      const wait = Math.min(Math.max(suggested * 1000, 15000 + attempt * 10000), 90000);
      const quota = /Quota exceeded for metric: ([^\\",\n]+)/.exec(raw)?.[1] || `HTTP ${r.status}`;
      log(label, `${quota} — жду ${Math.round(wait / 1000)} с (попытка ${attempt + 1}/8)`, 'warn');
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    const errText = await r.text().catch(() => ''); // не 'body' — так зовётся параметр запроса
    log(label, `HTTP ${r.status}: ${errText.slice(0, 160)}`, 'error');
    report('error', `${label}: HTTP ${r.status}`);
    return null;
  }
  log(label, 'лимит запросов не отпустил за 8 попыток (~5 мин), отрезок пропущен', 'error');
  report('error', `${label}: лимит запросов, сегмент пропущен`);
  return null;
}

async function translateAudio(wavB64) {
  const body = {
    contents: [{
      parts: [
        { text: TRANSLATE_PROMPT + (contextText ? `\n\nКонтекст — перевод предыдущих минут:\n${contextText}` : '') },
        { inlineData: { mimeType: 'audio/wav', data: wavB64 } },
      ],
    }],
  };
  const j = await postWithRetry(GEN_URL(TRANSLATE_MODEL, cfg.apiKey), body, 'перевод');
  if (!j) return '';
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return text === 'ПУСТО' ? '' : text;
}

// Диалог целиком одним запросом: движок озвучивает реплики разными голосами сам.
// Так вместо десятка коротких обращений уходит одно — и лимиты Google не срабатывают.
async function ttsDialog(chunk) {
  // Кусок — фраза одного человека, поэтому голос один и метки в тексте не нужны.
  const voice = geminiVoiceFor(chunk.speaker);
  const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
  const text = chunk.text;

  log('Озвучка', `${clockOf(chunk.start)} · S${chunk.speaker} · ${voice} · ` +
    `${Math.round(chunk.end - chunk.start)} с · ${text.length} симв.`);
  const j = await postWithRetry(GEN_URL(TTS_MODEL, cfg.apiKey), {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig },
  }, 'озвучка');
  if (!j) return null;
  const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) { log('Озвучка', 'ответ без аудио', 'error'); return null; }
  const rate = parseInt(/rate=(\d+)/i.exec(part.inlineData.mimeType || '')?.[1], 10) || 24000;
  log('Озвучка', `готово: ${(part.inlineData.data.length / 1024).toFixed(0)} КБ`, 'ok');
  return { data: part.inlineData.data, rate };
}

async function ttsSpeak(text, voice = TTS_VOICE) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  log('Озвучка', `Gemini, голос ${voice}, ${text.length} симв.`);
  const j = await postWithRetry(GEN_URL(TTS_MODEL, cfg.apiKey), body, 'озвучка');
  if (!j) { log('Озвучка', 'не удалась', 'error'); return null; }
  const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) { log('Озвучка', 'ответ без аудио', 'error'); return null; }
  const rate = parseInt(/rate=(\d+)/i.exec(part.inlineData.mimeType || '')?.[1], 10) || 24000;
  log('Озвучка', `готово: ${(part.inlineData.data.length / 1024).toFixed(0)} КБ, ${rate} Гц`, 'ok');
  return { data: part.inlineData.data, rate };
}

function report(status, error) {
  chrome.runtime.sendMessage({ target: 'background', type: 'status', status, error });
}

// Журнал: каждый шаг конвейера видно в панели — сразу ясно, где отвалилось.
function log(stage, text, level = 'info') {
  chrome.runtime.sendMessage({
    target: 'background', type: 'log',
    stage, text, level, t: Math.round(performance.now() / 1000),
  }).catch(() => {});
}

// Сбои, которые иначе тонут молча: необработанные ошибки и нехватка памяти.
self.addEventListener('error', (e) => {
  log('Сбой', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`, 'error');
});
self.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  log('Сбой', 'необработанная ошибка: ' + (r && r.message ? r.message : String(r)), 'error');
});

async function start(msg) {
  cfg = msg;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: cfg.streamId },
      },
    });

    // Путь 1: приглушённый оригинал в колонки (родная частота, без потери качества).
    ctxOut = new AudioContext();
    const gain = ctxOut.createGain();
    gain.gain.value = ORIGINAL_VOLUME;
    ctxOut.createMediaStreamSource(stream).connect(gain).connect(ctxOut.destination);

    // Путь 2: контекст 16 кГц (Chrome сам ресемплирует) -> worklet -> PCM -> Gemini.
    const ctxIn = new AudioContext({ sampleRate: 16000 });
    await ctxIn.audioWorklet.addModule('chunker-worklet.js');
    const chunker = new AudioWorkletNode(ctxIn, 'chunker');
    ctxIn.createMediaStreamSource(stream).connect(chunker);
    chunker.port.onmessage = (e) => sendAudioChunk(e.data);

    connect();
  } catch (err) {
    report('error', 'захват звука: ' + err.message);
  }
}

function startRelay(msg) {
  cfg = msg;
  relayMode = true;
  videoStarted = false;
  firstPlayback = true;
  speechQueue.length = 0;
  prepareMode = !!msg.prepare;
  engine = msg.engine || 'gemini';
  asr = msg.asr || 'gemini';
  log('Старт', `расшифровка: ${asr === 'openai' ? 'OpenAI' : 'Gemini'}, ` +
    `озвучка: ${engine === 'fish' ? 'Fish Audio' : 'Gemini'}, отрезок ${Math.round((msg.segmentS || 0) / 60)} мин` +
    (prepareMode ? ', режим «весь ролик заранее»' : ''));
  videoClock = 0;
  segReady = 0;
  segCounter = 0;
  videoTime = 0;
  if (msg.segmentS) {
    // Разведчик играет быстрее, значит и звук приходит быстрее: чтобы отрезок соответствовал
    // выбранной длине видео, режем по реальному времени потока.
    scoutRate = msg.scoutRate || 1;
    segMaxS = msg.segmentS / scoutRate;
    segMinS = Math.round(segMaxS * 0.85);
  }
  offset = typeof msg.offset === 'number' ? msg.offset : 1;
  ctxOut = new AudioContext();
  ensureRunning(); // Chrome создаёт AudioContext усыплённым — очередь молча не звучит
  // v5: WebSocket не нужен — сегменты идут через generateContent (перевод + TTS).
}

async function ensureRunning() {
  if (!ctxOut || ctxOut.state === 'running') return;
  try {
    await ctxOut.resume();
  } catch (e) {
    report('error', 'звук заблокирован браузером: ' + e.message);
  }
}

function connect() {
  setupDone = false;
  ws = new WebSocket(WS_URL(cfg.apiKey));

  ws.onopen = () => {
    ws.send(JSON.stringify({
      setup: {
        model: `models/${cfg.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: TARGET_LANG,
            echoTargetLanguage: false, // русская речь в оригинале не дублируется
          },
        },
      },
    }));
  };

  ws.onmessage = async (event) => {
    const text = typeof event.data === 'string' ? event.data : await event.data.text();
    const msg = JSON.parse(text);
    if (msg.setupComplete) { setupDone = true; report('translating'); return; }
    if (msg.error) { report('error', msg.error.message || 'ошибка API'); return; }
    for (const part of msg.serverContent?.modelTurn?.parts || []) {
      if (part.inlineData?.data) schedulePlayback(part.inlineData.data);
    }
  };

  ws.onclose = (e) => {
    if (!cfg) return;
    if (!setupDone) {
      report('error', `соединение отклонено (код ${e.code}${e.reason ? ': ' + e.reason : ''}): проверьте ключ и модель`);
      return;
    }
    report('connecting');
    setTimeout(connect, 1000); // сессии Live API конечны — просто переподключаемся
  };
}

function sendAudioChunk(f32) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !setupDone) return;
  ws.send(JSON.stringify({
    realtimeInput: {
      audio: { data: int16ToBase64(floatTo16BitPCM(f32)), mimeType: 'audio/pcm;rate=16000' },
    },
  }));
}

function sendEncodedChunk(b64) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !setupDone) return;
  ws.send(JSON.stringify({
    realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } },
  }));
}

function pcmToBuffer(b64, rate = 24000) {
  const f32 = base64ToFloat32(b64);
  if (!f32.length) return null;
  const buf = ctxOut.createBuffer(1, f32.length, rate);
  buf.copyToChannel(f32, 0);
  return buf;
}

function schedulePlayback(b64, rate = 24000) {
  const buf = pcmToBuffer(b64, rate);
  if (buf) scheduleBuffer(buf);
}

async function scheduleBuffer(buf) {
  await ensureRunning();
  const src = ctxOut.createBufferSource();
  src.buffer = buf;
  src.connect(ctxOut.destination);
  // Синхро-режим: новую порцию озвучки задерживаем на offset, чтобы она совпала
  // с отстающим видимым видео; внутри порции куски идут встык.
  nextStartTime = Math.max(nextStartTime, ctxOut.currentTime + (relayMode ? offset : 0.05));
  src.start(nextStartTime);
  nextStartTime += buf.duration;
  scheduled.push(src);
  src.onended = () => { scheduled = scheduled.filter((s) => s !== src); };
}
