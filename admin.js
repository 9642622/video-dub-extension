// Отчёт по просмотрам. Два источника:
//   1) сервер (Supabase) — общая картина по всем сотрудникам, нужен вход админа;
//   2) этот компьютер — события, ещё не ушедшие на сервер, и всё, что собрано,
//      пока сервера не было. Показываем их всегда, даже без входа.
//
// Читать журнал с сервера публичным ключом расширения НЕЛЬЗЯ — так задумано в правах
// базы. Поэтому админ входит по своей почте и паролю (Supabase Auth), и база отдаёт
// строки, только если его адрес помечен ролью admin в таблице viewers.

let rows = [];        // то, что сейчас в таблице
let sortKey = 'created_at';
let sortDir = -1;

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };

async function server() {
  const cfg = await chrome.storage.local.get(['serverUrl', 'serverKey']);
  const bg = await chrome.runtime.sendMessage({ target: 'background', type: 'get_server' });
  return { url: cfg.serverUrl || bg.url, key: cfg.serverKey || bg.key };
}

// ---- вход ----

async function signIn() {
  const { url, key } = await server();
  const email = $('email').value.trim().toLowerCase();
  const password = $('password').value;
  if (!email || !password) { $('authMsg').textContent = 'Введите почту и пароль'; return; }
  $('authMsg').textContent = 'Вхожу…';
  try {
    const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json();
    if (!r.ok) {
      $('authMsg').textContent = j.error_description || j.msg || `Не вошли (HTTP ${r.status})`;
      return;
    }
    await chrome.storage.local.set({ adminToken: j.access_token, adminEmail: email });
    $('authMsg').textContent = '';
    $('password').value = '';
    await refreshAuthBox();
    load();
  } catch (e) {
    $('authMsg').textContent = 'Сеть не отвечает: ' + e.message;
  }
}

async function signOut() {
  await chrome.storage.local.remove(['adminToken', 'adminEmail']);
  await refreshAuthBox();
  load();
}

async function refreshAuthBox() {
  const { adminToken, adminEmail } = await chrome.storage.local.get(['adminToken', 'adminEmail']);
  const inside = !!adminToken;
  $('email').style.display = inside ? 'none' : '';
  $('password').style.display = inside ? 'none' : '';
  $('signin').style.display = inside ? 'none' : '';
  $('signout').style.display = inside ? '' : 'none';
  $('who').textContent = inside
    ? `Вход выполнен: ${adminEmail}. Показаны данные сервера и этого компьютера.`
    : 'Без входа видны только просмотры, собранные на этом компьютере.';
}

// ---- данные ----

async function fetchServerRows() {
  const { adminToken } = await chrome.storage.local.get('adminToken');
  if (!adminToken) return [];
  const { url, key } = await server();
  const params = new URLSearchParams({ select: '*', order: 'created_at.desc', limit: '5000' });
  const from = $('from').value, to = $('to').value;
  if (from) params.append('created_at', `gte.${from}T00:00:00Z`);
  if (to) params.append('created_at', `lte.${to}T23:59:59Z`);
  const r = await fetch(`${url}/rest/v1/views?${params}`, {
    headers: { apikey: key, Authorization: `Bearer ${adminToken}` },
  });
  if (r.status === 401 || r.status === 403) {
    await chrome.storage.local.remove('adminToken');
    await refreshAuthBox();
    msg('Сеанс истёк или у этого адреса нет прав администратора — войдите заново.');
    return [];
  }
  if (!r.ok) { msg(`Сервер ответил HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`); return []; }
  return (await r.json()).map((x) => ({ ...x, source: 'сервер' }));
}

async function fetchLocalRows() {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'get_views' });
  return (res?.rows || []).map((e) => ({
    created_at: new Date(e.at || Date.parse(e.endedAt) || Date.now()).toISOString(),
    email: e.email || '',
    storage_user: e.user || '',
    file: e.file,
    duration: e.duration,
    watched: e.watched,
    max_pos: e.maxPos,
    dubbed: !!e.dubbed,
    source: 'этот компьютер',
  }));
}

function clock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`
    : `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function load() {
  msg('Загружаю…');
  const [srv, loc] = await Promise.all([fetchServerRows(), fetchLocalRows()]);
  // Сервер — источник истины; локальные показываем как есть, они помечены источником.
  rows = [...srv, ...loc];
  applyFilters();
  msg(rows.length ? '' : 'Пока ни одного просмотра. Записи появятся, как только кто-то откроет видео.');
}

function filtered() {
  const who = $('fWho').value.trim().toLowerCase();
  const file = $('fFile').value.trim().toLowerCase();
  const from = $('from').value ? Date.parse($('from').value + 'T00:00:00') : -Infinity;
  const to = $('to').value ? Date.parse($('to').value + 'T23:59:59') : Infinity;
  return rows.filter((r) => {
    const t = Date.parse(r.created_at);
    if (!(t >= from && t <= to)) return false;
    if (who && !`${r.email} ${r.storage_user}`.toLowerCase().includes(who)) return false;
    if (file && !(r.file || '').toLowerCase().includes(file)) return false;
    return true;
  });
}

function applyFilters() {
  const list = filtered();
  const key = sortKey;
  list.sort((a, b) => {
    const va = key === 'who' ? `${a.email}${a.storage_user}`
      : key === 'share' ? (a.watched || 0) / (a.duration || 1) : a[key];
    const vb = key === 'who' ? `${b.email}${b.storage_user}`
      : key === 'share' ? (b.watched || 0) / (b.duration || 1) : b[key];
    return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
  });

  const tbody = $('tbl').querySelector('tbody');
  tbody.innerHTML = '';
  for (const r of list) {
    const tr = document.createElement('tr');
    const share = r.duration ? Math.min(100, Math.round((r.watched / r.duration) * 100)) : null;
    const cells = [
      new Date(r.created_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }),
      r.email || r.storage_user || '—',
      r.file || '—',
      clock(r.watched),
      share === null ? '—' : `${share}%`,
      clock(r.max_pos),
      r.dubbed ? 'да' : '',
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if (i === 2) td.className = 'file';
      if (i === 3 || i === 4 || i === 5) td.className = 'num';
      if (i === 1) td.title = r.source;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  const people = new Set(list.map((r) => r.email || r.storage_user).filter(Boolean)).size;
  const files = new Set(list.map((r) => r.file)).size;
  const total = list.reduce((n, r) => n + (r.watched || 0), 0);
  $('totals').textContent = list.length
    ? `Записей просмотра: ${list.length} · людей: ${people} · роликов: ${files} · всего просмотрено: ${clock(total)}`
    : '';
}

function toCsv() {
  const head = ['когда', 'кто', 'запись', 'смотрел_сек', 'длина_сек', 'дошёл_до_сек', 'перевод', 'источник'];
  const lines = [head.join(';')];
  for (const r of filtered()) {
    lines.push([
      new Date(r.created_at).toLocaleString('ru-RU'),
      (r.email || r.storage_user || '').replace(/;/g, ','),
      (r.file || '').replace(/;/g, ','),
      Math.round(r.watched || 0), r.duration || '', r.max_pos || '',
      r.dubbed ? 'да' : 'нет', r.source,
    ].join(';'));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `просмотры-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('signin').addEventListener('click', signIn);
$('signout').addEventListener('click', signOut);
$('apply').addEventListener('click', load);
$('csv').addEventListener('click', toCsv);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
for (const th of $('tbl').querySelectorAll('th')) {
  th.addEventListener('click', () => {
    const k = th.dataset.k;
    sortDir = sortKey === k ? -sortDir : -1;
    sortKey = k;
    applyFilters();
  });
}

refreshAuthBox().then(load);
