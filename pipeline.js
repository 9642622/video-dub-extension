// Полный конвейер перевода файла: звук -> стенограмма с таймкодами -> перевод -> реплики.
// Озвучка здесь не делается — она идёт по ходу просмотра (см. offscreen.js).

import { floatToWavBytes } from './pcm.js';

const ELEVEN_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVEN_MODEL = 'scribe_v1';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const ASR_RATE = 16000;
const ASR_TIMEOUT_MS = 180000;     // без ограничения зависший запрос ждали бы вечно
const TRANSLATE_BATCH = 50;        // реплик в одном запросе: мелкие пачки отвечают заметно быстрее
const CHAT_TIMEOUT_MS = 150000;    // зависший запрос иначе ждали бы бесконечно

// Перевод и разметку говорящих делаем одним запросом: два прохода вдвое дороже по времени,
// а качество разметки то же — она всё равно строится по смыслу диалога.
const TRANSLATE_SYSTEM =
  'Ты профессиональный переводчик-дубляжник и редактор, носитель русского языка. Тебе дают ' +
  'расшифровку живой речи, разбитую на строки «12| текст». Расшифровка сырая: без знаков ' +
  'препинания, с оговорками, повторами и обрывками слов.\n\n' +
  'Верни СТРОГО строки вида «12| S1| перевод» — по одной на каждую исходную, ничего не пропуская, ' +
  'не объединяя и не добавляя новых номеров.\n\n' +
  'S1, S2… — говорящий: определяй по смыслу диалога (вопрос — ответ, обращения, роль в разговоре). ' +
  'Одна метка закреплена за одним человеком на весь разговор, в том числе в следующих пачках.\n\n' +
  'Как переводить:\n' +
  '— Пиши так, как сказал бы живой русский человек в этом же разговоре, а не подстрочником. ' +
  'Итальянские и английские конструкции разворачивай в естественные русские.\n' +
  '— Расставляй знаки препинания сам: заканчивай законченную мысль точкой, вопрос — вопросительным ' +
  'знаком. Это важно: по точкам мы собираем фразы для озвучки.\n' +
  '— Убирай слова-паразиты, заикания и повторы, если они не несут смысла, но не выбрасывай содержание.\n' +
  '— Сохраняй деловую лексику, числа, суммы, названия и единицы измерения точно.\n' +
  '— Держи единообразие терминов по всему разговору (смета, наценка, брус, перекрытие и т. п.).\n' +
  '— Не комментируй, не поясняй, не добавляй ничего от себя.';

export async function decodeAudioFromFile(url, log, onProgress) {
  // credentials: 'include' — файл в хранилище закрыт вашей сессией, без куки сервер
  // отдаёт пустышку или страницу входа.
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`файл не скачался: HTTP ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (/text\/html/i.test(type)) {
    throw new Error('вместо файла пришла веб-страница — похоже, нужна авторизация в хранилище');
  }
  const total = Number(r.headers.get('content-length')) || 0;
  log('Файл', `скачиваю ${total ? (total / 1e6).toFixed(0) + ' МБ' : 'видео'}…`);
  // Улика на случай «не той» ссылки: что за файл сервер отдал на самом деле.
  log('Файл', `сервер отдал: ${type || 'тип неизвестен'} · ` +
    `${decodeURIComponent(r.url).split('/').filter(Boolean).slice(-2).join('/').slice(-80)}`);

  // Читаем потоком, чтобы было видно, что процесс идёт, а не завис.
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  let lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (got - lastTick > 20e6) { // отчитываемся каждые 20 МБ
      lastTick = got;
      const pct = total ? ` (${Math.round(got / total * 100)}%)` : '';
      log('Файл', `скачано ${(got / 1e6).toFixed(0)} МБ${pct}`);
      onProgress?.(got, total);
    }
  }
  if (got < 100000) {
    throw new Error(`сервер отдал всего ${got} байт вместо видео — проверьте ссылку и вход в хранилище`);
  }
  const raw = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { raw.set(p, at); at += p.length; }
  parts.length = 0; // освобождаем куски: держать и их, и склеенный файл — двойной расход
  log('Файл', `скачано ${(got / 1e6).toFixed(0)} МБ, извлекаю звук…`);

  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(raw.buffer);
  ctx.close();
  log('Файл', `звук готов: ${(decoded.duration / 60).toFixed(1)} мин, ` +
    `${decoded.sampleRate} Гц, каналов ${decoded.numberOfChannels}`, 'ok');
  return decoded;
}

// Кусок звука в моно 16 кГц. Считаем вручную и по частям: готовый пересчёт средствами
// браузера создаёт вторую копию всей дорожки — на двадцатиминутном видео это сотни мегабайт.
export function extractMono16k(decoded, fromS, toS) {
  const rate = decoded.sampleRate;
  const step = rate / ASR_RATE;
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null;
  const start = Math.floor(fromS * rate);
  const end = Math.min(Math.floor(toS * rate), left.length);
  const out = new Float32Array(Math.max(0, Math.floor((end - start) / step)));
  const window = Math.max(1, Math.round(step));
  for (let i = 0; i < out.length; i++) {
    const j = start + Math.floor(i * step);
    let sum = 0;
    for (let k = 0; k < window; k++) {           // усреднение вместо простого прореживания
      const idx = j + k;
      if (idx >= end) break;
      sum += right ? (left[idx] + right[idx]) / 2 : left[idx];
    }
    out[i] = sum / window;
  }
  return out;
}

// Расшифровка через ElevenLabs Scribe: сразу даёт пунктуацию, таймкоды по словам
// и — главное — говорящих по голосу, а не по догадке о смысле диалога.
// Файл уходит целиком, поэтому нумерация спикеров сквозная для всей записи.
export async function transcribeEleven(decoded, key, log, onProgress) {
  const samples = extractMono16k(decoded, 0, decoded.duration);
  const wav = floatToWavBytes(samples, ASR_RATE);
  log('Расшифровка', `ElevenLabs: отправляю ${(wav.length / 1e6).toFixed(0)} МБ целиком…`);
  onProgress?.(0, 1);

  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  fd.append('model_id', ELEVEN_MODEL);
  fd.append('diarize', 'true');
  fd.append('timestamps_granularity', 'word');

  const started = Date.now();
  const r = await fetch(ELEVEN_URL, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: fd,
    signal: AbortSignal.timeout(ASR_TIMEOUT_MS * 4), // на всю запись нужно больше времени
  });
  if (!r.ok) throw new Error(`ElevenLabs HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const j = await r.json();
  log('Расшифровка', `язык: ${j.language_code} (уверенность ${Math.round((j.language_probability || 0) * 100)}%), ` +
    `слов: ${(j.words || []).length}, за ${Math.round((Date.now() - started) / 1000)} с`, 'ok');

  let cues = renumberBySpeakingOrder(dropStuckRepeats(wordsToCues(j.words || [])));
  // Ложное «раздвоение» человека проверяем по высоте голоса и склеиваем.
  cues = renumberBySpeakingOrder(mergeFalseSpeakers(cues, speakerPitches(decoded, cues), log));
  const people = new Set(cues.map((c) => c.speaker)).size;
  log('Расшифровка', `собрано ${cues.length} реплик, участников: ${people}`, 'ok');
  onProgress?.(1, 1);
  return cues;
}

// Слова со спикерами -> реплики: рвём на смене говорящего и на конце предложения.
export function wordsToCues(words) {
  const cues = [];
  let cur = null;
  for (const w of words) {
    // Пометки событий («(background noise)», смех, музыка) — не речь, их не переводим.
    if (w.type === 'audio_event') continue;
    const text = w.text || '';
    if (!text.trim()) {                       // пробелы между словами
      if (cur) cur.end = w.end ?? cur.end;
      continue;
    }
    const speaker = speakerNumber(w.speaker_id);
    const newSpeaker = !cur || cur.speaker !== speaker;
    if (newSpeaker || endsSentence(cur.source)) {
      cur = { start: w.start ?? 0, end: w.end ?? 0, speaker, source: text };
      cues.push(cur);
      continue;
    }
    cur.source += (/^[.,!?;:…»)]/.test(text) ? '' : ' ') + text;
    cur.end = w.end ?? cur.end;
  }
  return cues.filter((c) => c.source.trim() && !HALLUCINATIONS.test(c.source));
}

function speakerNumber(id) {
  const m = /(\d+)/.exec(id || '');
  return m ? parseInt(m[1], 10) + 1 : 1;      // speaker_0 -> S1
}

// ---- Пол говорящего по высоте голоса ----
// Частота основного тона: мужчины ~85–155 Гц, женщины ~165–255 Гц. Меряем по самой
// записи, поэтому результат детерминирован: тот же ролик всегда даёт те же голоса.

export function speakerPitches(decoded, cues) {
  const bySpeaker = {};
  for (const c of cues) {
    const list = (bySpeaker[c.speaker] ||= { secs: 0, cues: [] });
    if (list.secs < 12) { list.cues.push(c); list.secs += c.end - c.start; } // ~12 с на человека
  }
  const out = {};
  for (const [sp, { cues: list }] of Object.entries(bySpeaker)) {
    const f0s = [];
    for (const c of list) {
      const mono = extractMono16k(decoded, c.start, Math.min(c.end, c.start + 6));
      for (let off = 0; off + 1280 <= mono.length; off += 1280) { // шаг 80 мс
        const f0 = framePitch(mono, off, ASR_RATE);
        if (f0) f0s.push(f0);
      }
    }
    f0s.sort((a, b) => a - b);
    out[sp] = f0s[f0s.length >> 1] || 0;   // медианный основной тон, Гц
  }
  return out;
}

export function detectGenders(decoded, cues) {
  const pitches = speakerPitches(decoded, cues);
  return Object.fromEntries(Object.entries(pitches).map(([s, f0]) => [s, f0 >= 165 ? 'f' : 'm']));
}

// Расшифровщик иногда «раздваивает» одного человека на двух спикеров — тогда его
// реплики озвучиваются двумя разными голосами вперемешку. Если второстепенный спикер
// говорит мало и по высоте голоса неотличим от основного — это тот же человек.
export function mergeFalseSpeakers(cues, pitches, log) {
  if (!cues.length) return cues; // расшифровка пуста — «речь не распознана» скажет конвейер
  const time = {};
  for (const c of cues) time[c.speaker] = (time[c.speaker] || 0) + (c.end - c.start);
  const total = Object.values(time).reduce((a, b) => a + b, 0) || 1;
  const main = Object.entries(time).sort((a, b) => b[1] - a[1])[0][0];
  const remap = {};
  for (const sp of Object.keys(time)) {
    if (sp === main) continue;
    const share = time[sp] / total;
    const pa = pitches[main] || 0;
    const pb = pitches[sp] || 0;
    const sameBucket = (pa >= 165) === (pb >= 165);
    if (share < 0.2 && sameBucket && Math.abs(pa - pb) < 25) {
      remap[sp] = Number(main);
      log?.('Голоса', `«спикер ${sp}» говорит ${Math.round(share * 100)}% времени и звучит ` +
        `как спикер ${main} (${Math.round(pb)} против ${Math.round(pa)} Гц) — это один человек`, 'warn');
    }
  }
  return cues.map((c) => (remap[c.speaker] ? { ...c, speaker: remap[c.speaker] } : c));
}

// Основной тон одного кадра 40 мс автокорреляцией в диапазоне 70–320 Гц.
export function framePitch(mono, off, rate) {
  const N = Math.floor(0.04 * rate);
  const maxLag = Math.floor(rate / 70);
  if (off + N + maxLag > mono.length) return 0;
  let energy = 0;
  for (let i = 0; i < N; i++) energy += mono[off + i] ** 2;
  if (energy < 1e-3) return 0;                       // тишина — не меряем
  const minLag = Math.floor(rate / 320);
  const sums = new Float32Array(maxLag - minLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += mono[off + i] * mono[off + i + lag];
    sums[lag - minLag] = sum;
    if (sum > best) best = sum;
  }
  if (best / energy < 0.3) return 0;                 // непериодичный звук — не голос
  // Пики стоят и на кратных периодах — глобальный максимум может попасть на субгармонику
  // (ошибка октавы). Берём наименьший лаг, чей пик почти равен максимуму.
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (sums[lag - minLag] >= best * 0.9) return rate / lag;
  }
  return 0;
}

// Пол спикера по тексту перевода: в русском он виден по грамматике («я сказала»,
// «я готов»), по именам и обращениям. Это надёжнее высоты голоса на пограничных
// случаях — высокий мужской или низкий женский по частоте неразличимы.
const GENDER_SYSTEM =
  'Ты определяешь пол говорящих по репликам расшифрованного разговора. Текст может быть ' +
  'на любом языке (итальянский, английский, русский). Опирайся на грамматический род ' +
  '(«sono andata», «я сказала»), имена, обращения («signora», «господин») и на то, как ' +
  'к человеку обращаются собеседники.\n' +
  'Ответь СТРОГО строками вида «1=м», «2=ж», по одной на каждого спикера, без пояснений. ' +
  'Если признаков нет вовсе — поставь «?».';

export async function detectGendersByText(cues, cfg, log) {
  const bySpeaker = {};
  for (const c of cues) {
    const line = (c.text || c.source || '').trim();
    if (!line) continue;
    const list = (bySpeaker[c.speaker] ||= []);
    // Берём подлиннее — в коротких «да/нет» рода не видно.
    if (list.length < 25 && line.length > 12) list.push(line);
  }
  const speakers = Object.keys(bySpeaker);
  if (speakers.length < 1) return {};
  const prompt = speakers
    .map((s) => `Спикер ${s}:\n${bySpeaker[s].slice(0, 25).join('\n')}`)
    .join('\n\n');
  let answer = '';
  try {
    answer = await chat(cfg, GENDER_SYSTEM, prompt, log, 'Пол');
  } catch (e) {
    log?.('Голоса', `определить пол по тексту не вышло: ${e.message}`, 'warn');
    return {};
  }
  const out = {};
  for (const m of answer.matchAll(/(\d+)\s*=\s*([мжmf?])/gi)) {
    const g = m[2].toLowerCase();
    if (g === 'м' || g === 'm') out[m[1]] = 'm';
    else if (g === 'ж' || g === 'f') out[m[1]] = 'f';
  }
  return out;
}

// Спикеры нумеруются по порядку вступления в разговор: кто заговорил первым — Спикер 1
// и первый голос. Номера от расшифровщика произвольны, а так нумерация предсказуема.
export function renumberBySpeakingOrder(cues) {
  const order = new Map();
  for (const c of cues) if (!order.has(c.speaker)) order.set(c.speaker, order.size + 1);
  return cues.map((c) => ({ ...c, speaker: order.get(c.speaker) }));
}

// «Залипание» — вторая примета выдумки: на музыке или тишине расшифровщик повторяет
// одну и ту же длинную фразу подряд. Живые повторы («да, да») короткие — их не трогаем.
export function dropStuckRepeats(cues) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return cues.filter((c, i) => {
    if (i === 0) return true;
    const cur = norm(c.source);
    return cur.length <= 25 || cur !== norm(cues[i - 1].source);
  });
}

// На тишине расшифровщик выдумывает текст — обычно титры и подписи «переводчиков».
const HALLUCINATIONS = /amara\.org|субтитры|подписаться|продолжение следует|sottotitoli|subtitles by|редактор субтитров/i;

// Перевод всей стенограммы пачками, с сохранением номеров — чтобы тайминги не разъехались.
// Когда говорящие уже известны (расшифровщик различил их по голосу), переводчику
// незачем их угадывать — он только переводит, и качество перевода от этого выше.
const TRANSLATE_ONLY_SYSTEM =
  'Ты профессиональный переводчик-дубляжник и редактор, носитель русского языка. Тебе дают ' +
  'реплики живого разговора, пронумерованные как «12| [S2] текст», где [S2] — метка ' +
  'говорящего.\n\n' +
  'Верни СТРОГО строки вида «12| перевод» — по одной на каждую исходную, ничего не пропуская, ' +
  'не объединяя и не добавляя. Метку говорящего в ответ НЕ включай.\n\n' +
  'Как переводить:\n' +
  '— Пиши так, как сказал бы живой русский человек в этом же разговоре, а не подстрочником.\n' +
  '— Убирай слова-паразиты и повторы, если они не несут смысла, но не выбрасывай содержание.\n' +
  '— Сохраняй деловую лексику, числа, суммы, названия и единицы измерения точно.\n' +
  '— Держи единообразие терминов по всему разговору.\n' +
  '— Не комментируй и не добавляй ничего от себя.';

export async function translateAll(cues, cfg, log, onProgress, onBatchReady, genders = {}) {
  const knownSpeakers = cues.every((c) => c.speaker);
  let system = knownSpeakers ? TRANSLATE_ONLY_SYSTEM : TRANSLATE_SYSTEM;
  // Пол говорящих переводчик должен знать ДО работы: иначе в первом лице он гадает
  // и один и тот же человек оказывается то «сказал», то «сказала».
  const known = Object.entries(genders).filter(([, g]) => g === 'm' || g === 'f');
  if (known.length) {
    system += '\n\nПол говорящих: ' +
      known.map(([s, g]) => `S${s} — ${g === 'f' ? 'женщина' : 'мужчина'}`).join(', ') + '.\n' +
      'Соблюдай род СТРОГО и одинаково во всей записи: реплики от первого лица («я сделал» / ' +
      '«я сделала», «я готов» / «я готова»), причастия, прилагательные и обращения к этому ' +
      'человеку от собеседников. Род одного и того же спикера не меняется никогда.';
  }
  const batches = [];
  for (let from = 0; from < cues.length; from += TRANSLATE_BATCH) {
    batches.push(from);
  }
  const LANES = 6; // больше шести запросов разом сервис начинает притормаживать
  // Пачки идут параллельно: это самый долгий этап, а запросы независимы.
  const chars = cues.reduce((n, c) => n + c.source.length, 0);
  log('Перевод', `${cues.length} реплик (${(chars / 1000).toFixed(1)} тыс. символов), ` +
    `${batches.length} пачек параллельно, модель ${cfg.openaiModel}`);
  let done = 0;
  // Пока модель думает, показываем, что работа идёт: иначе кажется, что всё зависло.
  let alive = true;
  const ticker = setInterval(() => {
    if (alive) log('Перевод', `переведено ${done} из ${cues.length}, ждём ответы…`);
  }, 20000);

  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const from = batches[next++];
      await handleBatch(from);
    }
  };
  const handleBatch = async (from) => {
    const batch = cues.slice(from, from + TRANSLATE_BATCH);
    // Метка говорящего в каждой строке: по ней модель согласует род в первом лице.
    const numbered = batch
      .map((c, i) => `${from + i}| ${c.speaker ? `[S${c.speaker}] ` : ''}${c.source}`)
      .join('\n');
    const started = Date.now();
    let answer = '';
    try {
      answer = await chat(cfg, system, numbered, log, 'Перевод');
    } catch (e) {
      // Погибшая пачка не убивает прогон: эти реплики останутся с оригиналом.
      log('Перевод', `реплики ${from + 1}–${from + batch.length} не перевелись: ${e.message}`, 'error');
    }
    const got = (answer || '').split('\n').filter((l) => /^\s*\d+\s*\|/.test(l)).length;
    log('Перевод', `реплики ${from + 1}–${from + batch.length}: получено ${got} строк ` +
      `за ${Math.round((Date.now() - started) / 1000)} с`, got >= batch.length ? 'ok' : 'warn');
    applyNumbered(cues, answer, (cue, value) => {
      // Если говорящие не были известны, модель возвращает их меткой «S1| текст».
      const m = /^S(\d+)\s*\|\s*(.*)$/.exec(value);
      if (m && !knownSpeakers) { cue.speaker = parseInt(m[1], 10); cue.text = m[2]; }
      else cue.text = m ? m[2] : value;
    });
    done += batch.length;
    onProgress?.(done, cues.length);
    // Отдаём готовое сразу: смотреть можно с начала, пока хвост ещё переводится.
    onBatchReady?.(readyPrefix(cues));
  };
  await Promise.all(Array.from({ length: Math.min(LANES, batches.length) }, worker));
  alive = false;
  clearInterval(ticker);
  // Что модель пропустила — не оставляем пустым: лучше оригинал, чем тишина.
  for (const c of cues) {
    if (!c.text) c.text = c.source;
    if (!c.speaker) c.speaker = 1;
  }
  const people = new Set(cues.map((c) => c.speaker)).size;
  log('Перевод', `готово, участников в разговоре: ${people}`, 'ok');
  return cues;
}

// Непрерывный переведённый кусок от начала: смотреть можно ровно до первой дырки.
export function readyPrefix(cues) {
  const out = [];
  for (const c of cues) {
    if (!c.text) break;
    out.push(c);
  }
  return out;
}

function applyNumbered(cues, answer, assign) {
  for (const line of (answer || '').split('\n')) {
    const m = /^\s*(\d+)\s*\|\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const cue = cues[parseInt(m[1], 10)];
    if (cue) assign(cue, m[2]);
  }
}

async function chat(cfg, system, user, log, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let r;
    try {
      r = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.openaiKey}` },
        body: JSON.stringify({
          model: cfg.openaiModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          // Перевод не требует размышлений: с ними ответ идёт дольше при том же качестве.
          reasoning_effort: 'none',
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? 'ответа нет 2,5 минуты' : e.message;
      log(label, `${why}, пробую снова`, 'warn');
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    if (r.ok) return (await r.json()).choices?.[0]?.message?.content || '';
    // Лимиты и внутренние сбои сервера (5xx, в т.ч. 500 «Sorry about that!») — временные:
    // повторяем. Раньше 500 ронял весь перевод, и это выглядело как «слетел ключ».
    if (r.status === 429 || r.status >= 500) {
      log(label, `HTTP ${r.status}, жду 15 с (попытка ${attempt + 1}/5)`, 'warn');
      await new Promise((res) => setTimeout(res, 15000));
      continue;
    }
    throw new Error(`${label} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  }
  throw new Error(`${label}: лимит не отпустил`);
}

// Куски для озвучки: набираем реплики подряд до ~25 секунд, обрывая только на конце
// предложения и только на смене говорящего — фраза никогда не рвётся посередине.
// Кусок озвучки = законченное предложение (или несколько подряд, если они короткие).
// Расшифровщик режет речь на обрывки по 2–5 секунд, часто посреди фразы; склеиваем их
// до точки и берём таймкод начала фразы — так озвучка попадает в своё место и звучит
// с нормальной интонацией, а не обрубками.
export function buildChunks(cues, maxS = 20, maxChars = 600) {
  const chunks = [];
  let cur = null;
  for (const c of cues) {
    const sameSpeaker = cur && cur.speaker === c.speaker;
    const sentenceDone = cur && endsSentence(cur.lines[cur.lines.length - 1].text);
    const tooLong = cur && ((c.end - cur.start) > maxS || (cur.text.length + c.text.length) > maxChars);
    // Соседние предложения одного говорящего склеиваем в один кусок: на обрывках
    // из пары слов клонирующий синтез «плывёт» тембром, и голос кажется чужим.
    const closeEnough = cur && (c.start - cur.end) < 1.2;
    // Продолжаем кусок, пока говорит тот же человек: либо фраза не закончена,
    // либо следующая идёт сразу за ней.
    if (sameSpeaker && !tooLong && (!sentenceDone || closeEnough)) {
      cur.lines.push({ speaker: c.speaker, text: c.text });
      cur.text += ' ' + c.text;
      cur.end = c.end;
      continue;
    }
    cur = {
      start: c.start,
      end: c.end,
      speaker: c.speaker,
      lines: [{ speaker: c.speaker, text: c.text }],
      text: c.text,
    };
    chunks.push(cur);
  }
  return chunks;
}

function endsSentence(text) {
  return /[.!?…]["»)]?\s*$/.test(text || '');
}
