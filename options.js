const DEFAULT_MODEL = 'gemini-3.5-live-translate-preview';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra'; // втрое быстрее при том же качестве перевода
const FIELDS = ['apiKey', 'model', 'openaiKey', 'openaiModel', 'elevenKey', 'fishKey', 'fishVoice',
  'serverUrl', 'serverKey'];
const DEFAULTS = {
  apiKey: '', model: DEFAULT_MODEL,
  openaiKey: '', openaiModel: DEFAULT_OPENAI_MODEL,
  elevenKey: '',
  fishKey: '', fishVoice: '',
  fishMale: [], fishFemale: [],
  serverUrl: '', serverKey: '',
};

// Пакет дикторских голосов из каталога Fish. Без клонов знаменитостей — принцип проекта.
const VOICE_PACK = {
  male: [
    { id: 'f175cd7c61de4898960f1fa4b8044124', name: 'Дикторский мужской, ровный' },
    { id: '39a4e619463b464fb726ebd73be6ba52', name: 'Спокойный мужской' },
    { id: 'efe82aa926bc4e0a85b3ef4933a97a7f', name: 'Глубокий мужской' },
    { id: '868377a7b08f4c0d9acf8c9f059571aa', name: 'Молодой аналитик' },
    { id: '7312c38557eb4fb384e3874e8e9cea67', name: 'Профессиональный, ровный' },
    { id: '563736b1eb904cb29572f5eb5d9c46d2', name: 'Анатолий — постарше, спокойный' },
    { id: 'af5a794626ce47988446235baed3b0af', name: 'Глубокий, постарше' },
  ],
  female: [
    { id: '6aea743fab7e4b2b99ad7b3b8129b8ce', name: 'Юлия Романова — дикторский, спокойный' },
    { id: '2a1036d645634680b3cc69aeeb60375b', name: 'Спокойный женский' },
    { id: 'aa615eaff73f417e91cfbb4ea0e42df8', name: 'Женский, средних лет' },
    { id: '6d4d6122fa0244b5b801e50f0beac378', name: 'Мягкий женский' },
    { id: 'e64409e787324864bdf9e5c1b6acd97a', name: 'Тёплый спокойный' },
    { id: 'd567e990d9ad433892ed15ecfd70ce54', name: 'Молодой, звонкий' },
    { id: 'f14e1f9fb32d4dbd8cd5b40a0fef86a5', name: 'Дикторский женский' },
  ],
};
// Что отмечено, если пользователь ещё ничего не выбирал: выбор владельца —
// профессиональный и Анатолий у мужчин, молодой звонкий у женщин.
const PRECHECKED = {
  male: ['f175cd7c61de4898960f1fa4b8044124', '868377a7b08f4c0d9acf8c9f059571aa'],
  female: ['6aea743fab7e4b2b99ad7b3b8129b8ce', 'd567e990d9ad433892ed15ecfd70ce54'],
};

let preview = null; // звучащий сейчас образец — новый клик глушит прошлый

// Результат проверки уходит в общий журнал расширения: видно во вкладке «Журнал»
// панели и в скачанном файле журнала — не нужно пересказывать, что показала кнопка.
function toLog(text, level = 'info') {
  chrome.runtime.sendMessage({ target: 'background', type: 'log', t: 0, stage: 'Проверка', text, level })
    .catch(() => {});
}

function renderPack(saved) {
  const box = document.getElementById('voicePack');
  for (const [group, title] of [['male', 'Мужские'], ['female', 'Женские']]) {
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:12px;color:#666;margin:8px 0 2px';
    box.appendChild(h);
    for (const v of VOICE_PACK[group]) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.style.cssText = 'width:auto;margin:0';
      cb.dataset.group = group;
      cb.dataset.id = v.id;
      const chosen = saved[group === 'male' ? 'fishMale' : 'fishFemale'];
      cb.checked = (chosen.length ? chosen : PRECHECKED[group]).includes(v.id);
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = '▶';
      play.title = 'Послушать образец';
      play.style.cssText = 'margin:0;padding:2px 10px';
      play.addEventListener('click', (e) => { e.preventDefault(); playSample(v.id, play); });
      row.append(cb, play, document.createTextNode(v.name));
      box.appendChild(row);
    }
  }
}

async function playSample(voiceId, btn) {
  const key = document.getElementById('fishKey').value.trim();
  if (!key) { btn.textContent = 'нет ключа'; setTimeout(() => (btn.textContent = '▶'), 1500); return; }
  if (preview) { preview.pause(); preview = null; }
  btn.textContent = '…';
  try {
    const r = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      // Модель и температура — как в реальном дубляже, иначе образец обманывает.
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'model': 's2.1-pro' },
      body: JSON.stringify({
        text: 'Здравствуйте! Примерно так будет звучать перевод вашей встречи.',
        format: 'mp3', temperature: 0.3, top_p: 0.7, reference_id: voiceId,
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    preview = new Audio(URL.createObjectURL(await r.blob()));
    preview.onended = () => (btn.textContent = '▶');
    await preview.play();
    btn.textContent = '■';
  } catch (e) {
    btn.textContent = 'ошибка';
    setTimeout(() => (btn.textContent = '▶'), 2000);
  }
}

chrome.storage.local.get(DEFAULTS, (v) => {
  for (const f of FIELDS) document.getElementById(f).value = v[f];
  renderPack(v);
});

// Кто представился на этом компьютере — и возможность назваться заново.
chrome.storage.local.get('account', ({ account }) => {
  const box = document.getElementById('account');
  if (!box) return;
  if (!account?.email) { box.textContent = 'Пользователь ещё не указан — панель спросит при открытии.'; return; }
  box.textContent = `Пользователь: ${account.email} · `;
  if (account.isAdmin) {
    const link = document.getElementById('adminLink');
    link.style.display = 'block';
    document.getElementById('openAdmin').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ target: 'background', type: 'open_admin' });
    });
  }
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = 'сменить';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.storage.local.remove('account', () => {
      box.textContent = 'Сброшено — панель спросит при следующем открытии.';
    });
  });
  box.appendChild(a);
});

// Быстрая проверка СОХРАНЁННЫХ ключей (не того, что в полях): каждый сервис отвечает
// на дешёвый запрос — 401 значит ключ отвергнут, любой другой ответ значит ключ принят.
async function probeKey(name, key, doFetch, okText) {
  if (!key) return `✗ ${name}: ключ не задан`;
  const masked = `${key.slice(0, 6)}…${key.slice(-4)}`;
  try {
    const r = await doFetch();
    if (r.status === 401 || r.status === 403) return `✗ ${name}: ключ ${masked} ОТВЕРГНУТ (HTTP ${r.status})`;
    if (r.status === 402) return `✗ ${name}: ключ ${masked} принят, но НЕТ БАЛАНСА`;
    const extra = r.ok && okText ? await okText(r).catch(() => '') : '';
    return `✓ ${name}: ключ ${masked} работает${extra ? ` · ${extra}` : ''}`;
  } catch (e) {
    return `? ${name}: сеть не отвечает (${e.message})`;
  }
}

// Сквозной тест озвучки: тот же запрос, что делает расширение во время перевода,
// сохранённым ключом. Слышно результат — значит, путь до Fish полностью рабочий.
document.getElementById('testDub').addEventListener('click', async () => {
  const box = document.getElementById('testResult');
  const v = await chrome.storage.local.get(DEFAULTS);
  if (!v.fishKey) { box.textContent = '✗ Ключ Fish не сохранён — впишите его и нажмите «Сохранить»'; return; }
  const masked = `${v.fishKey.slice(0, 6)}…${v.fishKey.slice(-4)}`;
  const voice = (v.fishMale && v.fishMale[0]) || PRECHECKED.male[0];
  box.textContent = `Отправляю тестовую фразу ключом ${masked}…`;
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${v.fishKey}`, 'Content-Type': 'application/json', model: 's2.1-pro' },
      body: JSON.stringify({
        text: 'Добрый день, коллеги. Это тестовая озвучка перевода встречи.',
        format: 'mp3', temperature: 0.3, top_p: 0.7, reference_id: voice,
      }),
    });
    if (!r.ok) {
      const why = r.status === 401 || r.status === 403 ? 'ключ ОТВЕРГНУТ'
        : r.status === 402 ? 'НЕТ БАЛАНСА' : `отказ HTTP ${r.status}`;
      const body = (await r.text()).slice(0, 200);
      box.textContent = `✗ Озвучка не прошла: ${why}\nКлюч ${masked}\nОтвет: ${body}`;
      toLog(`тест озвучки НЕ прошёл: ${why}, ключ ${masked}. Ответ: ${body.slice(0, 120)}`, 'error');
      return;
    }
    const blob = await r.blob();
    if (preview) preview.pause();
    preview = new Audio(URL.createObjectURL(blob));
    await preview.play();
    const msg = `озвучка прошла: ключ ${masked}, голос ${voice.slice(0, 8)}…, ` +
      `${(blob.size / 1024).toFixed(0)} КБ за ${((Date.now() - t0) / 1000).toFixed(1)} с`;
    box.textContent = `✓ ${msg[0].toUpperCase()}${msg.slice(1)} — слушайте.`;
    toLog(msg, 'ok');
  } catch (e) {
    box.textContent = `? Сеть не отвечает: ${e.message}`;
    toLog(`тест озвучки: сеть не отвечает (${e.message})`, 'error');
  }
});

document.getElementById('testKeys').addEventListener('click', async () => {
  const box = document.getElementById('testResult');
  box.textContent = 'Проверяю сохранённые ключи…';
  const v = await chrome.storage.local.get(DEFAULTS);
  const results = await Promise.all([
    probeKey('Fish Audio', v.fishKey,
      () => fetch('https://api.fish.audio/wallet/self/api-credit',
        { headers: { Authorization: `Bearer ${v.fishKey}` } }),
      async (r) => `баланс ${(await r.json()).credit}`),
    probeKey('ElevenLabs', v.elevenKey,
      () => fetch('https://api.elevenlabs.io/v1/speech-to-text',
        { method: 'POST', headers: { 'xi-api-key': v.elevenKey } })), // без файла: не-401 = ключ принят
    probeKey('OpenAI', v.openaiKey,
      () => fetch('https://api.openai.com/v1/models',
        { headers: { Authorization: `Bearer ${v.openaiKey}` } })),
    probeKey('Gemini', v.apiKey,
      () => fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${v.apiKey}`)),
  ]);
  box.textContent = results.join('\n');
  for (const line of results) {
    toLog(line.replace(/^[✓✗?] /, ''), line.startsWith('✓') ? 'ok' : line.startsWith('✗') ? 'error' : 'warn');
  }
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.get(DEFAULTS, (prev) => {
    const out = {};
    for (const f of FIELDS) out[f] = document.getElementById(f).value.trim();
    // Пустое поле ключа не затирает сохранённый ключ: страховка от забытой старой
    // вкладки настроек и от менеджера паролей, который лезет в поля-пароли.
    for (const f of ['apiKey', 'openaiKey', 'elevenKey', 'fishKey', 'serverKey']) {
      if (!out[f] && prev[f]) out[f] = prev[f];
    }
    out.model = out.model || DEFAULT_MODEL;
    out.openaiModel = out.openaiModel || DEFAULT_OPENAI_MODEL;
    for (const [group, field] of [['male', 'fishMale'], ['female', 'fishFemale']]) {
      out[field] = [...document.querySelectorAll(`input[data-group="${group}"]:checked`)]
        .map((cb) => cb.dataset.id);
    }
    chrome.storage.local.set(out, () => {
      document.getElementById('saved').textContent = 'Сохранено';
      setTimeout(() => (document.getElementById('saved').textContent = ''), 1500);
    });
  });
});
