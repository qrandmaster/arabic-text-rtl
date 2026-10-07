/**
 * rtl-toggle — منطق الاتجاه بثلاث حالات
 *
 * لكل موقع حالة واحدة محفوظة:
 *
 *   off   : لا نلمس شيئاً (الوضع الافتراضي للموقع)
 *   full  : نفرض الاتجاه على المستند كله (`dir="rtl"` على <html> و<body>)،
 *           فينقلب التخطيط مع النص — وهذا ما يريده من يطوّر موقعاً عربياً.
 *   soft  : **لا نلمس المستند**، بل نضبط اتجاه عناصر النص التي تحوي حرفاً عربياً
 *           على `rtl`. فيُقرأ النص من اليمين ويُحاذى يميناً، ويبقى تخطيط الموقع
 *           (flex وgrid والمواضع الفيزيائية) كما صمّمه صاحبه.
 *
 * الوضع النصي (soft) هو الحل لموقع مثل AI Studio، حيث قلب المستند يعبث بواجهات
 * لم تُختبر في RTL بينما النص نفسه يحتاج اتجاهاً عربياً.
 *
 * ويبقى فرض الوضع الكامل مراقَباً: بعض المواقع تعيد كتابة `dir` بعدنا، وبعضها
 * يتنقّل دون إعادة تحميل (SPA)، فيُعاد التطبيق في الحالتين.
 */
(() => {
  'use strict';

  if (window.__rtlToggleInstalled) return;
  window.__rtlToggleInstalled = true;

  const MARKER = 'data-rtl-toggle';
  const TEXT_FLAG = 'data-rtl-toggle-text';
  const FORCE_KEY = '__rtlToggleForceToggle';
  const MODE_PREFIX = 'mode:';
  const LEGACY_PREFIX = 'dir:';
  const EXCLUDED_KEY = 'excluded';
  const MAX_SCAN = 4000;

  /** القيم الأصلية للموقع، تُلتقط عند بداية كل دورة فرض وتُستهلك عند إنهائها. */
  const original = { html: undefined, body: undefined, bodyPending: false };
  let mode = 'off';
  let writing = false;
  let excluded = false;
  let scanTimer = null;
  let pendingNodes = [];

  const root = () => document.documentElement;
  const modeKey = () => MODE_PREFIX + location.origin;
  const legacyKey = () => LEGACY_PREFIX + location.origin;

  /* ---------------------------------------------------------------- الوضع الكامل */

  function effectiveDirection() {
    const value = (
      root().getAttribute('dir') ||
      (document.body && document.body.getAttribute('dir')) ||
      ''
    ).toLowerCase();
    return value === 'rtl' ? 'rtl' : 'ltr';
  }

  function documentSaysRtl() {
    return effectiveDirection() === 'rtl';
  }

  function writeFull() {
    const html = root();
    if (!html) return;
    if (original.bodyPending && document.body) {
      original.body = document.body.getAttribute('dir');
      original.bodyPending = false;
    }
    writing = true;
    try {
      html.setAttribute('dir', 'rtl');
      html.setAttribute(MARKER, 'on');
      const body = document.body;
      if (body) {
        if (body.getAttribute('dir') !== 'rtl') body.setAttribute('dir', 'rtl');
      }
    } finally {
      writing = false;
    }
  }

  function restoreSite() {
    const html = root();
    if (!html) return;
    writing = true;
    try {
      if (original.html === null || original.html === undefined) html.removeAttribute('dir');
      else html.setAttribute('dir', original.html);
      const body = document.body;
      if (body) {
        if (original.body === null || original.body === undefined) body.removeAttribute('dir');
        else body.setAttribute('dir', original.body);
      }
    } finally {
      writing = false;
    }
  }

  function enterFull() {
    original.html = root().getAttribute('dir');
    const body = document.body;
    original.body = body ? body.getAttribute('dir') : null;
    original.bodyPending = !body;
    writeFull();
  }

  function leaveFull() {
    if (original.html !== undefined) restoreSite();
    original.html = undefined;
    original.body = undefined;
    original.bodyPending = false;
  }

  /* ---------------------------------------------------------------- الوضع النصي */

  const TEXT_TAGS = new Set([
    'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH',
    'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'SUMMARY', 'LABEL', 'DIV', 'SPAN', 'A', 'BUTTON',
  ]);
  const BLOCKING_DISPLAY = new Set(['flex', 'inline-flex', 'grid', 'inline-grid']);
  /** هل يحوي النصّ حرفاً عربياً أو عبرياً؟ (لا يُشترط أن يبدأ به) */
  const HAS_RTL_TEXT = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
  /** ما كُتب على العنصر قبلنا، لِيُرَدّ عند الإزالة. */
  const DIR_FLAG = 'data-rtl-toggle-dir';
  const ALIGN_FLAG = 'data-rtl-toggle-align';
  const MARKER_FLAG = 'data-rtl-toggle-marker';

  function displayOf(element) {
    try {
      return getComputedStyle(element).display || '';
    } catch {
      return '';
    }
  }

  /**
   * هل العنصر حاوية تخطيط؟ قلب اتجاه حاوية flex أو grid يحرّك أبناءها، وهو
   * بالضبط ما جئنا لتفاديه، فنقف عند حدود النص.
   */
  function isLayoutContainer(element) {
    if (BLOCKING_DISPLAY.has(displayOf(element))) return true;
    for (const child of element.children) {
      const display = displayOf(child);
      if (display !== 'inline' && display !== 'inline-block' && display !== 'contents') return true;
    }
    return false;
  }

  function directionOf(element) {
    try {
      return getComputedStyle(element).direction || '';
    } catch {
      return '';
    }
  }

  function textAlignOf(element) {
    try {
      return getComputedStyle(element).textAlign || '';
    } catch {
      return '';
    }
  }

  /**
   * تعليم عنصر نصّي في الوضع النصي.
   *
   * ثلاثة قرارات مقيَّسة هنا، وكل واحد منها أصلح خللاً رآه صاحب المشروع:
   *
   *   1. الشرط أن النص **يحوي** حرفاً عربياً لا أن يبدأ به. فبند مثل
   *      «Cursor Pro: 20$ شهرياً …» يبدأ بحرف لاتيني، وكان يُترك لاتينياً على
   *      اليسار ونقطته تذهب إلى يمين السطر.
   *   2. الاتجاه الصريح `rtl` لا `auto`: فـ`auto` تتبع أول محرف قوي، فيبقى
   *      السطر لاتينياً في البند نفسه. و`rtl` تحسم القاعدة، فيمضي السطر من
   *      اليمين وتلتصق نقطة الختام بآخره الأيسر.
   *   3. لا نفرض `text-align: right` على كل معلَّم: نُصلح المحاذاة فقط حين
   *      يفرض الموقع `left` صراحةً. أما `center` فيبقى كما أراده المصمّم،
   *      وأما `start` فيصير يميناً وحده لأن الاتجاه صار `rtl`.
   */
  function markElement(element) {
    if (!element || element.nodeType !== 1) return;
    if (!TEXT_TAGS.has(element.tagName)) return;
    if (element.hasAttribute(TEXT_FLAG)) return;
    const text = (element.textContent || '').trim();
    if (!text || !HAS_RTL_TEXT.test(text)) return;
    if (isLayoutContainer(element)) return;
    // موقع عربي أصلاً: نصّه مضبوط باتجاهه، فلا داعي للتدخّل.
    if (directionOf(element) === 'rtl') return;

    const declared = element.getAttribute('dir');
    if (declared !== null) element.setAttribute(DIR_FLAG, declared);
    element.setAttribute('dir', 'rtl');
    element.setAttribute(TEXT_FLAG, '1');

    if (textAlignOf(element) === 'left') {
      element.style.textAlign = 'right';
      element.setAttribute(ALIGN_FLAG, '1');
    }

    // علامة البند: مساحة العلامة محجوزة في جهة البداية الفيزيائية للقائمة
    // (يساراً في تخطيط لاتيني)، فإذا صار البند من اليمين بقيت العلامة في
    // اليسار وتفرّق النصّ عنها. فنضع العلامة داخل السطر فتتبع جهة النصّ.
    if (element.tagName === 'LI') {
      element.style.listStylePosition = 'inside';
      element.setAttribute(MARKER_FLAG, '1');
    }
  }

  /* ---------------------------------------------------------------- علامة البند */

  /**
   * علامة البند (النقطة الكبيرة) **لا تُنقل ولا يُنشأ لها بديل**.
   *
   * جُرِّب ذلك بثلاث طرق: `::after` في ورقة الأنماط، ثم `::before` مطلق، ثم عنصر
   * `<span>` حقيقي يُلصق في نهاية النص. وكلها إما لم تُطبَّق في الصفحة المقصودة
   * فبقيت العلامة الأصلية مُلغاة بلا بديل، وإما ألصقت العلامة بنهاية **آخر سطر**
   * من البند: بند من سطرين تظهر نقطته في وسط الكتلة عند نهاية السطر الثاني،
   * وبنود القائمة تتفرّق نقاطها على أطوال مختلفة، فيرى القارئ النقطة الكبيرة
   * في غير موضعها. وهو بالضبط ما رآه صاحب المشروع.
   *
   * والصواب أن تُترك العلامة مكانها (أول السطر) وأن يُصلَح **اتجاه** السطر نفسه:
   * `li { direction: rtl }` في rtl.css تضبط جهة العلامة، وإسقاط `plaintext` عن
   * شجرة البند يجعل سطور البند كلها تمضي من اليمين. وحينئذٍ تذهب نقطة الختام
   * الصغيرة (`.` و`:` ونحوهما) إلى آخر السطر الأيسر من تلقاء قواعد الاتجاه
   * الثنائي نفسها، من غير أن نُنشئ عنصراً ولا نقيس مستطيلاً.
   */

  function scan(scope) {
    if (!scope || scope.nodeType !== 1) return;
    markElement(scope);
    let walker;
    try {
      walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    } catch {
      return;
    }
    let node = walker.nextNode();
    let visited = 0;
    while (node && visited < MAX_SCAN) {
      markElement(node);
      node = walker.nextNode();
      visited += 1;
    }
  }

  function unmarkAll() {
    for (const element of root().querySelectorAll(`[${TEXT_FLAG}]`)) {
      element.removeAttribute(TEXT_FLAG);
      const previous = element.getAttribute(DIR_FLAG);
      if (previous === null) element.removeAttribute('dir');
      else element.setAttribute('dir', previous);
      element.removeAttribute(DIR_FLAG);
      if (element.hasAttribute(ALIGN_FLAG)) {
        element.style.textAlign = '';
        element.removeAttribute(ALIGN_FLAG);
      }
      if (element.hasAttribute(MARKER_FLAG)) {
        element.style.listStylePosition = '';
        element.removeAttribute(MARKER_FLAG);
      }
    }
  }

  function scheduleScan(nodes) {
    if (mode !== 'soft') return;
    for (const node of nodes) if (node.nodeType === 1) pendingNodes.push(node);
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const queue = pendingNodes;
      pendingNodes = [];
      for (const node of queue) {
        if (!node.isConnected) continue;
        scan(node);
        if (pendingNodes.length + queue.length > MAX_SCAN) break;
      }
    }, 250);
  }

  /* ---------------------------------------------------------------- الحالة */

  function report() {
    try {
      chrome.runtime.sendMessage({
        type: 'state',
        mode,
        excluded,
        direction: mode === 'soft' ? 'rtl-soft' : effectiveDirection(),
      });
    } catch {
      /* لا مستقبل */
    }
  }

  function clearEffects() {
    if (mode === 'full') leaveFull();
    else if (mode === 'soft') unmarkAll();
    const html = root();
    if (html) html.removeAttribute(MARKER);
  }

  function applyMode(next, options = {}) {
    const target = next === 'full' || next === 'soft' ? next : 'off';
    if (target === mode && !options.force) {
      report();
      return;
    }
    clearEffects();
    mode = target;
    if (mode === 'full') enterFull();
    else if (mode === 'soft') {
      root().setAttribute(MARKER, 'soft');
      scan(document.body || root());
    }
    if (options.persist !== false) {
      chrome.storage.local.set({ [modeKey()]: mode }).catch(() => {});
    }
    report();
  }

  function cycle() {
    const order = ['off', 'full', 'soft'];
    const index = order.indexOf(mode);
    applyMode(order[(index + 1) % order.length]);
  }

  /* ---------------------------------------------------------------- المراقبة */

  function reassert() {
    if (mode === 'full') writeFull();
  }

  const observer = new MutationObserver((records) => {
    if (writing) return;
    if (mode === 'full') {
      // الوضع الكامل كله CSS (rtl.css) عدا `dir` على الجذر، فلا شيء نفحصه هنا
      // سوى أن الصفحة لم تُعِد كتابة الاتجاه بعدنا.
      const html = root();
      if (html.getAttribute('dir') !== 'rtl' || html.getAttribute(MARKER) !== 'on') reassert();
      return;
    }
    if (mode === 'soft') {
      const added = [];
      for (const record of records) for (const node of record.addedNodes) added.push(node);
      if (added.length) scheduleScan(added);
    }
  });

  function observe() {
    try {
      observer.observe(root(), {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['dir', MARKER],
      });
    } catch {
      /* لا شيء */
    }
  }

  observe();

  /* ---------------------------------------------------------------- التنقّل */

  for (const method of ['pushState', 'replaceState']) {
    const native = history[method];
    if (typeof native !== 'function') continue;
    history[method] = function patched(...args) {
      const result = native.apply(this, args);
      queueMicrotask(() => (mode === 'soft' ? scheduleScan([document.body]) : reassert()));
      return result;
    };
  }

  const revisit = () => (mode === 'soft' ? scheduleScan([document.body || root()]) : reassert());
  window.addEventListener('popstate', revisit);
  window.addEventListener('hashchange', revisit);
  window.addEventListener('pageshow', revisit);
  window.addEventListener('DOMContentLoaded', revisit);

  function state() {
    return { mode, excluded, direction: mode === 'soft' ? 'rtl-soft' : effectiveDirection(), site: location.origin };
  }

  /** إضافة الموقع إلى قائمة الاستثناء أو رفعه عنها. */
  async function setExcluded(value) {
    excluded = value;
    try {
      const data = await chrome.storage.local.get(EXCLUDED_KEY);
      const list = new Set(Array.isArray(data?.[EXCLUDED_KEY]) ? data[EXCLUDED_KEY] : []);
      if (value) list.add(location.origin);
      else list.delete(location.origin);
      await chrome.storage.local.set({ [EXCLUDED_KEY]: [...list] });
    } catch {
      /* التخزين غير متاح — يبقى الأثر في هذه الجلسة */
    }
    applyMode('off', { force: true });
  }

  /* ---------------------------------------------------------------- الرسائل */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    switch (message.type) {
      case 'cycle':
        if (excluded) applyMode('full', { force: true });
        else cycle();
        sendResponse(state());
        return true;
      case 'set-mode':
        if (excluded && message.mode !== 'off') excluded = false;
        applyMode(message.mode);
        sendResponse(state());
        return true;
      case 'exclude':
        void setExcluded(true).then(() => sendResponse(state()));
        return true;
      case 'include':
        void setExcluded(false).then(() => sendResponse(state()));
        return true;
      case 'status':
        sendResponse(state());
        return true;
      default:
        return undefined;
    }
  });

  /* ---------------------------------------------------------------- التهيئة */

  chrome.storage.local
    .get([modeKey(), legacyKey(), EXCLUDED_KEY])
    .then((data) => {
      const list = Array.isArray(data?.[EXCLUDED_KEY]) ? data[EXCLUDED_KEY] : [];
      excluded = list.includes(location.origin);

      let stored = data?.[modeKey()];
      if (stored !== 'off' && stored !== 'soft' && stored !== 'full') {
        // توافق مع النسخة السابقة التي كانت تحفظ قيمة منطقية واحدة.
        const legacy = data?.[legacyKey()];
        stored = legacy === true ? 'full' : 'off';
      }

      if (window[FORCE_KEY]) {
        delete window[FORCE_KEY];
        if (excluded) {
          applyMode('full', { force: true });
          return;
        }
        applyMode(stored === 'off' ? 'full' : stored === 'full' ? 'soft' : 'off', { force: true });
        return;
      }

      if (excluded) {
        mode = 'off';
        report();
        return;
      }
      applyMode(stored, { force: true, persist: false });
    })
    .catch(() => report());
})();
