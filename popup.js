// Попап делает ровно одно: открывает панель перевода на текущей странице.
// Прежняя первая кнопка запускала старый режим прямого дубляжа через Gemini Live —
// он давно не используется, а при пустом счёте AI Studio отвечал «соединение
// отклонено (код 1011)», и это выглядело как поломка переводчика. Кнопка убрана.

const statusEl = document.getElementById('status');

document.getElementById('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('panel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'sync_toggle' });
    window.close();
    return;
  } catch {
    // Скрипт на странице осиротел после перезагрузки расширения — вставим заново.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["tracking.js", "content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: 'sync_toggle' });
    window.close();
  } catch {
    statusEl.textContent = 'Здесь панель не открывается. Обновите страницу с видео (⌘R) и попробуйте снова.';
  }
});
