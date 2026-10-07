/**
 * اختبار ذاتي لمنطق إضافة rtl-toggle.
 *
 * يُشغّل rtl-content.js داخل متصفح مُحاكى (DOM مصغّر + chrome API + history)
 * ليتحقق من المسارات التي يصعب اختبارها يدوياً:
 *
 *   1. الوضع الكامل يفرض dir على <html> و<body>، ويستعيد القيم الأصلية عند الإطفاء.
 *   2. الوضع النصي (soft) **لا يلمس dir على الجذر** — وهذا أهم وعد فيه.
 *   3. الوضع النصي يعلّم عناصر النص العربية بـdir="auto" ويترك الإنجليزية.
 *   4. لا يُعلَّم أي عنصر حاوية تخطيط (flex/grid) حمايةً من قلب الأبناء.
 *   5. تدوير الحالات: إيقاف ← كامل ← نصي ← إيقاف، مع تنظيف آثار كل حالة.
 *   6. الاستثناء يُحفظ لكل موقع، والحالة المنطقية القديمة تُقرأ كما ينبغي.
 *
 * التشغيل: node test/selftest.mjs rtl-content.js
 */
import { readFileSync } from 'node:fs';

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error('usage: node test/selftest.mjs <path to rtl-content.js>');
  process.exit(2);
}
const source = readFileSync(scriptPath, 'utf8');

const labels = [];
const failures = [];
function check(label, condition, detail = '') {
  labels.push(label);
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/* --- DOM مصغّر ------------------------------------------------------------ */
const registry = [];
const attrObservers = [];
const childObservers = [];
let html;
let body;

class FakeElement {
  constructor(tag, options = {}) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.parentElement = null;
    this.ownText = options.text || '';
    this.display = options.display || 'block';
    this.isConnected = true;
    this.testId = options.id || '';
    this.style = {};
    registry.push(this);
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }
  querySelector(selector) {
    if (selector === ':scope > p' || selector === 'p') {
      return (
        this.children.find((child) => child.tagName === 'P') ||
        this.children.map((child) => child.querySelector('p')).find(Boolean) ||
        null
      );
    }
    if (selector.startsWith('[')) {
      const attribute = selector.slice(1, -1);
      return descendantsOf(this).find((element) => element.hasAttribute(attribute)) || null;
    }
    return null;
  }
  getBoundingClientRect() {
    return this.rect || { left: 0, top: 0, width: 10, height: 24 };
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
    for (const observer of childObservers) observer.record({ addedNodes: [child] });
    return child;
  }
  get textContent() {
    const own = this.ownText || '';
    const nested = this.children.map((child) => child.textContent).join(' ');
    return `${own} ${nested}`.trim();
  }
  set textContent(value) {
    this.ownText = value;
    this.children = [];
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  querySelectorAll(selector) {
    const all = [this, ...descendantsOf(this)];
    const byAttribute = /^\[([a-z-]+)\]$/.exec(selector);
    if (byAttribute) return all.filter((element) => element.hasAttribute(byAttribute[1]));
    if (selector === 'li') return all.filter((element) => element.tagName === 'LI');
    return [];
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  addEventListener() {
    /* لا حاجة */
  }
}

function descendantsOf(element) {
  const out = [];
  const queue = [...element.children];
  while (queue.length) {
    const node = queue.shift();
    out.push(node);
    queue.push(...node.children);
  }
  return out;
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.options = null;
  }
  observe(_target, options) {
    this.options = options || {};
    (this.options.childList ? childObservers : attrObservers).push(this);
  }
  record(record) {
    if (record.addedNodes && !this.options?.childList) return;
    this.callback([record]);
  }
  disconnect() {
    for (const list of [attrObservers, childObservers]) {
      const index = list.indexOf(this);
      if (index >= 0) list.splice(index, 1);
    }
  }
}

/* --- chrome API مصغّر ----------------------------------------------------- */
const storage = new Map();
const sentMessages = [];
let messageListener = null;

const chrome = {
  runtime: {
    id: 'test',
    sendMessage: (message) => {
      sentMessages.push(message);
      return Promise.resolve();
    },
    onMessage: {
      addListener: (fn) => {
        messageListener = fn;
      },
    },
  },
  storage: {
    local: {
      get: (keys) => {
        const wanted = keys === undefined ? [...storage.keys()] : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of wanted) if (storage.has(key)) out[key] = storage.get(key);
        return Promise.resolve(out);
      },
      set: (object) => {
        for (const [key, value] of Object.entries(object)) storage.set(key, value);
        return Promise.resolve();
      },
    },
  },
};

/* --- globals -------------------------------------------------------------- */
const listeners = new Map();
Object.assign(globalThis, {
  window: globalThis,
  chrome,
  MutationObserver: FakeMutationObserver,
  NodeFilter: { SHOW_ELEMENT: 1 },
  history: {
    pushState() {
      return undefined;
    },
    replaceState() {
      return undefined;
    },
  },
  location: { origin: 'https://example.com' },
  getComputedStyle: (element) => ({
    display: element?.display || 'block',
    listStyleType: element?.listStyleType || 'disc',
    position: element?.position || 'static',
    direction: element?.direction || 'ltr',
    textAlign: element?.textAlign || 'start',
  }),
  addEventListener: (type, fn) => listeners.set(type, fn),
});
globalThis.window = globalThis;

/* --- شجرة الصفحة ---------------------------------------------------------- */
html = new FakeElement('html', { display: 'block', id: 'html' });
body = new FakeElement('body', { display: 'block', id: 'body' });
html.append(body);

const arabicParagraph = body.append(new FakeElement('p', { text: 'مرحباً بالعالم', id: 'ar-p' }));
const englishParagraph = body.append(new FakeElement('p', { text: 'Hello world', id: 'en-p' }));
const flexArabic = body.append(new FakeElement('div', { text: 'مرحباً', display: 'flex', id: 'flex-ar' }));
const wrapper = body.append(new FakeElement('div', { display: 'block', id: 'wrapper' }));
const inlineSpan = wrapper.append(new FakeElement('span', { text: 'نص عربي', display: 'inline', id: 'ar-span' }));

/* حالات الوضع النصي التي أصلحها القياس في متصفح حقيقي:
 *  - سطر يبدأ بلفظ لاتيني وفيه عربية (كان يُترك لاتينياً في اليسار).
 *  - عنصر كتب الموقع عليه `dir="ltr"` صراحةً.
 *  - جملة عربية أراد المصمّم توسيطها.
 *  - جملة يفرض الموقع عليها `text-align: left`.
 *  - موقع عربي أصلاً (اتجاهه rtl) فلا داعي للتدخّل. */
const mixedParagraph = body.append(
  new FakeElement('p', { text: 'Cursor Pro: 20$ شهرياً (الوكيل الأكثر استقراراً).', id: 'mixed-p' }),
);
const declaredLtr = body.append(new FakeElement('p', { text: 'نصّ عربي واتجاهه معلن', id: 'ltr-p' }));
declaredLtr.setAttribute('dir', 'ltr');
const centeredArabic = body.append(new FakeElement('p', { text: 'جملة عربية في وسط السطر', id: 'center-p' }));
centeredArabic.textAlign = 'center';
const leftForced = body.append(new FakeElement('p', { text: 'جملة عربية يفرض الموقع يسارها', id: 'left-p' }));
leftForced.textAlign = 'left';
const nativeRtl = body.append(new FakeElement('p', { text: 'موقع عربي أصلاً', id: 'native-rtl-p' }));
nativeRtl.direction = 'rtl';

/* قوائم لاختبار علامة نهاية السطر: بند عادي، وبند بلا علامة، وبند بقائمة متداخلة. */
const list = body.append(new FakeElement('ul', { display: 'block', id: 'list' }));
const plainItem = list.append(new FakeElement('li', { text: 'بند له علامة', id: 'li-plain' }));
const markerlessItem = list.append(new FakeElement('li', { text: 'بند بلا علامة', id: 'li-none' }));
markerlessItem.listStyleType = 'none';
const nestedItem = list.append(new FakeElement('li', { display: 'block', id: 'li-nested' }));
nestedItem.append(new FakeElement('p', { text: 'بند فيه قائمة متداخلة', id: 'li-nested-p' }));
nestedItem.append(new FakeElement('ul', { display: 'block', id: 'list-inner' }));

globalThis.document = {
  documentElement: html,
  body,
  createElement(tag) {
    return new FakeElement(tag);
  },
  createRange() {
    return {
      selectNodeContents() {},
      getClientRects() {
        return [{ left: 120, top: 8, width: 200, height: 22 }];
      },
    };
  },
  createTreeWalker(scope) {
    const list = descendantsOf(scope);
    let index = 0;
    return { nextNode: () => (index < list.length ? list[index++] : null) };
  },
  querySelectorAll(selector) {
    return html.querySelectorAll(selector);
  },
};

/* --- تشغيل السكربت -------------------------------------------------------- */
function boot() {
  delete globalThis.window.__rtlToggleInstalled;
  new Function(source)();
}

const ask = (message) => {
  let reply = null;
  messageListener(message, {}, (value) => {
    reply = value;
  });
  return reply;
};
const tick = (ms = 12) => new Promise((resolve) => setTimeout(resolve, ms));

boot();
await tick();

const siteKey = 'mode:https://example.com';
const legacyKey = 'dir:https://example.com';
const marked = () => html.querySelectorAll('[data-rtl-toggle-text]');

/* 1) التهيئة بلا حالة محفوظة */
check('التهيئة لا تفرض شيئاً على html', html.getAttribute('dir') === null);
check('ولا علامة على html', html.getAttribute('data-rtl-toggle') === null);
check('ولا يُعلَّم أي عنصر نصي', marked().length === 0);
check('ويُبلَّغ عن الحالة', sentMessages.some((message) => message.type === 'state'));

/* 2) الوضع الكامل */
const full = ask({ type: 'cycle' });
check('التدوير الأول يعطي الوضع الكامل', full?.mode === 'full');
check('الكامل يفرض dir=rtl على html', html.getAttribute('dir') === 'rtl');
check('الكامل يفرض dir=rtl على body', body.getAttribute('dir') === 'rtl');
check('الكامل يكتب علامة on', html.getAttribute('data-rtl-toggle') === 'on');
/* ملاحظة: نقل علامة البند إلى نهاية السطر أُلغي نهائياً بعد أن قِيس في المتصفح
 * أن العلامة كانت تُلصق بنهاية آخر سطر (فتظهر في وسط الكتلة أو في غير موضعها).
 * فالاختبارات الآن تتأكد من **غياب** أي تدخّل في العلامة، لا من وجوده. */
check('الكامل لا يُنشئ أي نقطة بديلة', html.querySelectorAll('[data-rtl-toggle-dot]').length === 0);
check(
  'ولا يعلّم أي بند ولا يمسّ نمط علامته',
  html.querySelectorAll('[data-rtl-toggle-trailing]').length === 0 &&
    plainItem.style.listStyle === undefined &&
    nestedItem.style.listStyle === undefined,
);
check('ولا يقيّد علامة البند بلا علامة ظاهرة', markerlessItem.style.listStyle === undefined);
check('وتُحفظ الحالة', storage.get(siteKey) === 'full');

/* 3) الوضع النصي */
const soft = ask({ type: 'cycle' });
check('التدوير الثاني يعطي الوضع النصي', soft?.mode === 'soft', `mode=${soft?.mode}`);
check('النصي يُزيل dir عن html', html.getAttribute('dir') === null, `dir=${html.getAttribute('dir')}`);
check('النصي يُزيل dir عن body', body.getAttribute('dir') === null);
check('النصي يكتب علامة soft', html.getAttribute('data-rtl-toggle') === 'soft');
check(
  'النصي يضبط الفقرة العربية على rtl',
  arabicParagraph.getAttribute('dir') === 'rtl' && arabicParagraph.hasAttribute('data-rtl-toggle-text'),
  `dir=${arabicParagraph.getAttribute('dir')}`,
);
check(
  'ويضبط السطر الذي يبدأ بلفظ لاتيني وفيه عربية',
  mixedParagraph.getAttribute('dir') === 'rtl',
  `dir=${mixedParagraph.getAttribute('dir')}`,
);
check(
  'ويتجاوز ما كتب الموقع عليه dir=ltr صراحةً',
  declaredLtr.getAttribute('dir') === 'rtl' && declaredLtr.getAttribute('data-rtl-toggle-dir') === 'ltr',
);
check('النصي يترك الفقرة الإنجليزية', !englishParagraph.hasAttribute('data-rtl-toggle-text') && englishParagraph.getAttribute('dir') === null);
check('النصي لا يعلّم حاوية flex', !flexArabic.hasAttribute('data-rtl-toggle-text'));
check('النصي يعلّم ما داخل الحاوية العادية', inlineSpan.getAttribute('dir') === 'rtl');
check(
  'ولا يُزيل توسيط المصمّم',
  centeredArabic.getAttribute('dir') === 'rtl' && centeredArabic.style.textAlign === undefined,
);
check(
  'ويُصلح المحاذاة حين يفرض الموقع left',
  leftForced.style.textAlign === 'right' && leftForced.getAttribute('data-rtl-toggle-align') === '1',
);
check('ويترك الموقع العربي أصلاً كما هو', !nativeRtl.hasAttribute('data-rtl-toggle-text'));
check(
  'ويضع علامة البند داخل السطر كي تتبع جهة النصّ',
  plainItem.style.listStylePosition === 'inside' && plainItem.getAttribute('data-rtl-toggle-marker') === '1',
);
check('والحالة النصية محفوظة', storage.get(siteKey) === 'soft');

/* 4) الاستثناء */
ask({ type: 'exclude' });
await tick(20);
check('الاستثناء يوقف كل شيء', html.getAttribute('data-rtl-toggle') === null && marked().length === 0);
check(
  'ويُحفظ الموقع في قائمة الاستثناء',
  Array.isArray(storage.get('excluded')) && storage.get('excluded').includes('https://example.com'),
  JSON.stringify(storage.get('excluded')),
);

/* 5) العودة ثم الإطفاء */
ask({ type: 'set-mode', mode: 'full' });
check('اختيار الوضع الكامل بعد الاستثناء يعمل', html.getAttribute('dir') === 'rtl');
ask({ type: 'set-mode', mode: 'off' });
check(
  'الإطفاء يعيد الوضع الأصلي',
  html.getAttribute('dir') === null && body.getAttribute('dir') === null && html.getAttribute('data-rtl-toggle') === null,
);

/* 6) توافق مع الحالة المنطقية القديمة
 * بين كل تشغيلين نحاكي إعادة تحميل الصفحة: المتصفح يبني DOM جديداً، فلا تبقى
 * آثار الجلسة السابقة. (في المتصفح لا يمكن أن يعمل السكربت مرتين على الصفحة
 * نفسها لأن الحماية `__rtlToggleInstalled` تمنع ذلك.) */
function reloadDom() {
  for (const element of [html, body]) {
    element.removeAttribute('dir');
    element.removeAttribute('data-rtl-toggle');
  }
  for (const element of marked()) {
    element.removeAttribute('dir');
    element.removeAttribute('data-rtl-toggle-text');
  }
}

storage.clear();
storage.set(legacyKey, true);
reloadDom();
boot();
await tick();
check('القيمة القديمة (true) تُقرأ كوضع كامل', html.getAttribute('dir') === 'rtl');

storage.clear();
reloadDom();
boot();
await tick();
check('وبلا حالة محفوظة يعود الإيقاف', html.getAttribute('dir') === null);

/* --- التقرير -------------------------------------------------------------- */
for (const label of labels) {
  process.stdout.write(`${failures.some((item) => item.startsWith(label)) ? 'FAIL' : 'PASS'}  ${label}\n`);
}
process.stdout.write(`\n${labels.length - failures.length}/${labels.length} نجحت\n`);
if (failures.length) {
  process.stdout.write(`\nالإخفاقات:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
}
