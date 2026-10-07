/**
 * rtl-toggle — الخلفية (service worker)
 *
 * مسؤولياتها: النقر على الأيقونة (يدوّر الحالات)، واختصار لوحة المفاتيح، وقائمة
 * النقر بالزر الأيمن على الأيقونة (اختيار حالة محددة أو استثناء الموقع)، وتحديث
 * الشارة لتعرف الحالة بنظرة واحدة.
 *
 * والشيفرة هنا لا تلمس الصفحة إلا إذا لم يكن سكربت المحتوى جاهزاً (صفحات حُمّلت
 * قبل تمكين الإضافة أو تحديثها)، فتُحقن النسخة نفسها عند الطلب.
 */
'use strict';

/** مظهر الشارة لكل حالة: كامل (أصفر)، نصي (أخضر)، وموقع عربي أصلاً (رمادي). */
const LOOKS = {
  full: { text: 'RTL', color: '#ffe900' },
  soft: { text: 'نص', color: '#34a853' },
  native: { text: 'RTL', color: '#9aa0a6' },
};

const MENUS = [
  { id: 'rtl-mode-full', title: 'اتجاه كامل (يقلب التخطيط)' },
  { id: 'rtl-mode-soft', title: 'نص فقط (بلا قلب تخطيط)' },
  { id: 'rtl-mode-off', title: 'إيقاف' },
  { id: 'rtl-sep', type: 'separator' },
  { id: 'rtl-exclude', title: 'استثنِ هذا الموقع' },
  { id: 'rtl-include', title: 'أزل الاستثناء عن هذا الموقع' },
];

async function paint(tabId, state) {
  if (!tabId) return;
  try {
    if (state && state.mode === 'full') {
      await chrome.action.setBadgeText({ tabId, text: LOOKS.full.text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: LOOKS.full.color });
      return;
    }
    if (state && state.mode === 'soft') {
      await chrome.action.setBadgeText({ tabId, text: LOOKS.soft.text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: LOOKS.soft.color });
      return;
    }
    if (state && state.direction === 'rtl') {
      await chrome.action.setBadgeText({ tabId, text: LOOKS.native.text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: LOOKS.native.color });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    /* التبويب أُغلق أو تغيّر */
  }
}

async function send(tabId, message) {
  try {
    const state = await chrome.tabs.sendMessage(tabId, message);
    await paint(tabId, state);
    return state;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  if (await send(tabId, { type: 'status' })) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['rtl-content.js'] });
    return true;
  } catch (error) {
    console.warn('rtl-toggle: تعذّر الوصول إلى هذا التبويب —', error?.message ?? error);
    return false;
  }
}

async function cycle(tab) {
  if (!tab || tab.id === undefined) return;
  if (await send(tab.id, { type: 'cycle' })) return;

  // لا سكربت محتوى: نُعلِّم النافذة ثم نحقن النسخة نفسها، فتبدأ دوّارة الحالات.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        window.__rtlToggleForceToggle = true;
      },
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['rtl-content.js'] });
  } catch (error) {
    console.warn('rtl-toggle: تعذّر التبديل في هذا التبويب —', error?.message ?? error);
  }
}

async function choose(tab, message) {
  if (!tab || tab.id === undefined) return;
  if (!(await ensureContentScript(tab.id))) return;
  await send(tab.id, message);
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const item of MENUS) {
      chrome.contextMenus.create({ ...item, contexts: ['action'] });
    }
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.action.onClicked.addListener((tab) => {
  void cycle(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-rtl') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await cycle(tab);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const actions = {
    'rtl-mode-full': { type: 'set-mode', mode: 'full' },
    'rtl-mode-soft': { type: 'set-mode', mode: 'soft' },
    'rtl-mode-off': { type: 'set-mode', mode: 'off' },
    'rtl-exclude': { type: 'exclude' },
    'rtl-include': { type: 'include' },
  };
  const message = actions[info.menuItemId];
  if (message) await choose(tab, message);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'state' && sender.tab?.id !== undefined) {
    void paint(sender.tab.id, message);
  }
  return undefined;
});
