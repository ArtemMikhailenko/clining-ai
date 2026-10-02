/* Админка клининговой службы: доска заявок, диалоги, сводка и настройки. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const waDlg = $('#wa-dlg');

let state = {}, convs = [], stats = null, current = null, detail = null;
// неделя по умолчанию: на молодой базе месячный график вырождается в пустое поле
let page = 'board', query = '', drawerOpen = false, statsDays = 7;
let notified = new Set(), dragging = false;
let jobs = [], weekOffset = 0, animStep = 0;
// два вида одних данных: список — работать, доска — видеть воронку целиком
let leadView = localStorage.getItem('leadView') || 'list';
// стадия, выбранная в воронке бокового меню; null — показываем все
let stageFilter = null;
// какие карточки уже показывали: иначе анимация проигрывалась бы
// на каждое входящее сообщение и доска дёргалась бы без повода
const seen = new Set();
const freshIds = new Set();

/** Пометить заявку новой на пару секунд — чтобы вспышка успела проиграться
 *  даже если за это время придёт ещё несколько событий и доска перерисуется. */
function markFresh(id) {
  freshIds.add(id);
  setTimeout(() => freshIds.delete(id), 1800);
}

const THEMES = { system: 'системная', light: 'светлая', dark: 'тёмная' };
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  document.querySelectorAll('#sf-theme button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
}

/** Простая иллюстрация вместо эмодзи: пустой экран тоже часть продукта. */
function emptyArt(kind) {
  const c = 'var(--muted)';
  const art = {
    board: `<rect x="6" y="14" width="26" height="52" rx="5" fill="none" stroke="${c}" stroke-width="2.5" opacity=".55"/>
      <rect x="37" y="14" width="26" height="52" rx="5" fill="none" stroke="${c}" stroke-width="2.5" opacity=".35"/>
      <rect x="68" y="14" width="26" height="52" rx="5" fill="none" stroke="${c}" stroke-width="2.5" opacity=".2"/>
      <rect x="11" y="21" width="16" height="9" rx="3" fill="var(--accent)" opacity=".55"/>`,
    chat: `<path d="M12 16h76a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H40L24 68V56h-12a6 6 0 0 1-6-6V22a6 6 0 0 1 6-6z"
        fill="none" stroke="${c}" stroke-width="2.5" opacity=".55"/>
      <circle cx="34" cy="36" r="3.5" fill="var(--accent)" opacity=".7"/>
      <circle cx="50" cy="36" r="3.5" fill="${c}" opacity=".45"/>
      <circle cx="66" cy="36" r="3.5" fill="${c}" opacity=".3"/>`
  }[kind] || '';
  return `<svg viewBox="0 0 100 80" fill="none">${art}</svg>`;
}

function toast(text, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/**
 * Уведомления в браузере есть не везде: в Safari на iPhone глобального
 * Notification просто нет, и `Notification?.permission` не спасает — это
 * ReferenceError, который валил всю страницу настроек.
 */
const hasNotifications = () => typeof Notification !== 'undefined';
const notifyReady = () => hasNotifications() && Notification.permission === 'granted';

const api = async (url, opts) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
    throw new Error('Нужно войти');
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error(j.error || r.statusText), { data: j });
  }
  return r.json();
};
// кто вошёл: владелец видит всё, менеджер — заявки без настроек и журналов
const me = () => state.me || { role: 'owner', name: '' };
const isOwner = () => me().role === 'owner';
const ROLE_T = { owner: 'владелец', manager: 'менеджер' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const dt = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const hhmm = (s) => dt(s).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const lead = (c) => { try { return JSON.parse(c.lead || '{}'); } catch { return {}; } };
const getSettingList = (k) => String(state[k] || '').split('\n').map((t) => t.trim()).filter(Boolean);

function ago(s) {
  const min = Math.floor((Date.now() - dt(s)) / 6e4);
  if (min < 1) return 'только что';
  if (min < 60) return min + ' мин';
  if (min < 1440) return Math.floor(min / 60) + ' ч';
  return dt(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}
function dayLabel(s) {
  const d = dt(s), n = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = (day(n) - day(d)) / 864e5;
  return diff === 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
// один нейтральный тон вместо шести случайных: цветные кружки у каждого клиента
// перетягивали внимание с того, что действительно требует реакции
const avaColor = () => '';
const initials = (n, p) => (n || '').trim() ? n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() : String(p).slice(-2);
const isMobile = () => matchMedia('(max-width:860px)').matches;
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10;
  return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };

/* ───── колонки доски: комбинация владельца диалога и стадии воронки ───── */
// Воронка по ТЗ §3: колонка — это этап сделки. Кто ведёт диалог (бот или
// менеджер) и «нужен менеджер» — признаки на карточке, а не колонки.
const COLUMNS = [
  { k:'new',     t:'Новая',                   c:'var(--muted)',  hint:'бот ещё не начал разговор' },
  { k:'clarify', t:'Уточнение',               c:'var(--accent)', hint:'собираем данные по заявке' },
  { k:'offer',   t:'Предложение отправлено',  c:'var(--s4)',     hint:'менеджер назвал окончательную цену' },
  { k:'agreed',  t:'Согласовано / назначено', c:'var(--s3)',     hint:'цена и дата подтверждены' },
  { k:'done',    t:'Выполнено',               c:'var(--s1)',     hint:'уборка сделана, ждём оплату' }
];
// Закрытые сделки — по подстатусам. «Неквалифицировано» разбито на две
// корзины, как просил менеджер; для отчёта это один подстатус.
const ARCHIVE = [
  { k:'paid',        t:'Оплачено',          c:'var(--s3)',    hint:'сделка оплачена' },
  { k:'lost',        t:'Проиграно',         c:'var(--muted)', hint:'клиент отказался — с причиной' },
  { k:'unq_regular', t:'Обычные уборки',    c:'var(--s4)',    hint:'неквалифицировано: бытовая уборка' },
  { k:'unq_staff',   t:'Сотрудники',        c:'var(--s1)',    hint:'неквалифицировано: ищут работу, свои' }
];
const ALL_COLS = [...COLUMNS, ...ARCHIVE];
const isArchive = (k) => ARCHIVE.some((x) => x.k === k);

function columnOf(c) {
  if (c.stage === 'closed' || c.status === 'closed') {
    return ARCHIVE.some((x) => x.k === c.close_reason) ? c.close_reason : 'lost';
  }
  return COLUMNS.some((x) => x.k === c.stage) ? c.stage : 'new';
}
const colTitle = (k) => (ALL_COLS.find((x) => x.k === k) || { t: k }).t;

let flagFilter = null;   // 'need' | 'review' | 'call' | 'late' — признаки, по которым смотрят очередь
// звонок по заявке (ТЗ §2.2): ждём — до срока, просрочен — после
const callState = (c) => (!c.call_due_at || c.status === 'closed' ? null : dt(c.call_due_at) <= Date.now() ? 'late' : 'call');
const dayTime = (s) => {
  const d = dt(s), today = new Date();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? t
    : d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'numeric' }) + ' ' + t;
};
const lateBy = (s) => {
  const m = Math.max(0, Math.round((Date.now() - dt(s)) / 6e4));
  return m < 60 ? m + ' мин' : m < 1440 ? Math.floor(m / 60) + ' ч' : Math.floor(m / 1440) + ' дн';
};
const mgrName = (id) => (state.managers || []).find((m) => m.id === id)?.name || '';
const matches = (c) => {
  // на доске чужие колонки только приглушаются, фильтрует лишь список
  if (stageFilter && leadView === 'list' && columnOf(c) !== stageFilter) return false;
  if (flagFilter === 'need' && !(c.needs_human && c.status !== 'closed')) return false;
  if (flagFilter === 'review' && !c.review) return false;
  if ((flagFilter === 'call' || flagFilter === 'late') && callState(c) !== flagFilter) return false;
  if (flagFilter === 'red' && !(c.stage !== 'closed' && (c.warn || []).some((w) => w.level === 'red'))) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (c.name || '').toLowerCase().includes(q) || String(c.phone).includes(q)
    || (c.summary || '').toLowerCase().includes(q) || (c.last_body || '').toLowerCase().includes(q);
};
/**
 * Перерисовка без прыжка к началу списка. Список обновляется сам каждые
 * полминуты и на каждое входящее сообщение: человек листал заявки, и его
 * возвращало наверх. Если разметка не изменилась — DOM не трогаем вовсе,
 * а если изменилась, возвращаем прокрутку на место.
 */
function paint(box, html) {
  if (box.innerHTML === html) return;
  const top = box.scrollTop, left = box.scrollLeft;
  const inner = new Map([...box.children].map((el) => [el.dataset.col ?? el.dataset.g, el.querySelector('.colm-body')?.scrollTop]));
  box.innerHTML = html;
  box.scrollTop = top;
  box.scrollLeft = left;
  for (const el of box.children) {
    const body = el.querySelector('.colm-body');
    const was = inner.get(el.dataset.col ?? el.dataset.g);
    if (body && was) body.scrollTop = was;
  }
}

function chipFor(c) {
  if (c.status === 'closed') return '<span class="chip closed">в архиве</span>';
  const chips = [];
  if (c.needs_human) chips.push('<span class="chip need">нужен менеджер</span>');
  else chips.push(c.ai_enabled ? '<span class="chip ai">ИИ ведёт</span>' : '<span class="chip human">менеджер</span>');
  const cs = callState(c);
  if (cs === 'late') chips.push(`<span class="chip late" title="срок был ${dayTime(c.call_due_at)}">звонок просрочен ${lateBy(c.call_due_at)}</span>`);
  if (cs === 'call') chips.push(`<span class="chip call">позвонить до ${dayTime(c.call_due_at)}</span>`);
  const red = (c.warn || []).find((w) => w.level === 'red' && w.code !== 'late');
  if (red) chips.push(`<span class="chip late">${esc(red.text)}</span>`);
  if (c.wait_media) chips.push('<span class="chip wait">ждём фото/видео</span>');
  if (c.stage === 'done' && !c.paid_sum) chips.push('<span class="chip wait">ожидается оплата</span>');
  if (c.review) chips.push(`<span class="chip review" title="${esc(c.review)}">проверить</span>`);
  return chips.join('');
}

/* ═══════════ страницы ═══════════ */
const PAGES = {
  dash:     { title: 'Сводка',    tpl: 'tpl-dash',  render: renderDash,  tools: dashTools },
  inbox:    { title: 'Заявки',
              get tpl() { return leadView === 'list' ? 'tpl-inbox' : 'tpl-board'; },
              render: () => (leadView === 'list' ? renderLeads() : renderBoard()),
              tools: leadsTools },
  cal:      { title: 'Расписание', tpl: 'tpl-cal',  render: renderCal,   tools: calTools },
  control:  { title: 'Контроль дня', tpl: null,     render: renderControl, tools: controlTools },
  report:   { title: 'Отчёт',        tpl: null,     render: renderReport, tools: reportTools },
  settings: { title: 'Настройки', tpl: null,        render: renderSettings, tools: () => '' }
};

function go(p) {
  page = p;
  $$('.side a[data-p], #tabbar a[data-p]').forEach((a) => a.classList.toggle('on', a.dataset.p === p));
  $('.app').classList.remove('menu-open');
  const def = PAGES[p];
  $('#pg-title').textContent = def.title;
  $('#hdr-tools').innerHTML = def.tools();
  const c = $('#content');
  c.innerHTML = '';
  c.classList.remove('page-anim', 'quiet');
  void c.offsetWidth;                 // перезапуск анимации при смене раздела
  c.classList.add('page-anim');
  if (def.tpl) c.appendChild($('#' + def.tpl).content.cloneNode(true));
  seen.clear();
  def.render();
  bindTools();
  if (p === 'inbox' && current) openConv(current, false);
}

// объявлениями, а не стрелками: на них ссылается PAGES выше по файлу
function searchTool() {
  return `<label class="search">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
    <input id="q" placeholder="Поиск по имени, номеру, тексту" value="${esc(query)}"></label>`;
}
function leadsTools() {
  return `<div class="seg" id="view-seg">
      <button data-v="list" class="${leadView === 'list' ? 'on' : ''}">Список</button>
      <button data-v="board" class="${leadView === 'board' ? 'on' : ''}">Доска</button>
      <button data-v="archive" class="${leadView === 'archive' ? 'on' : ''}">Архив</button>
    </div>
    <div class="hstat" id="hstat"></div>` + searchTool()
    + `<button class="btn" id="csv">CSV</button>`;
}
function calTools() {
  const chev = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return `<div class="seg">
    <button id="cal-prev" title="Предыдущая неделя">${chev('m15 18-6-6 6-6')}</button>
    <button id="cal-today" class="${weekOffset === 0 ? 'on' : ''}">Эта неделя</button>
    <button id="cal-next" title="Следующая неделя">${chev('m9 18 6-6-6-6')}</button></div>
    <button class="btn primary" id="cal-add">+ Уборка</button>`;
}
function dashTools() {
  return `<div class="seg" id="days">${[7, 30, 90]
    .map((d) => `<button data-d="${d}" class="${d === statsDays ? 'on' : ''}">${d} дней</button>`).join('')}</div>`;
}

function bindTools() {
  const q = $('#q');
  if (q) q.oninput = (e) => { query = e.target.value; PAGES[page].render(); };
  $$('#days button').forEach((b) => b.onclick = () => { statsDays = Number(b.dataset.d); loadStats(); });
  $('#csv') && ($('#csv').onclick = exportCsv);
  $$('#view-seg button').forEach((b) => b.onclick = () => {
    leadView = b.dataset.v;
    localStorage.setItem('leadView', leadView);
    go('inbox');
  });
  $('#cal-prev') && ($('#cal-prev').onclick = () => { weekOffset--; renderCal(); });
  $('#cal-next') && ($('#cal-next').onclick = () => { weekOffset++; renderCal(); });
  $('#cal-today') && ($('#cal-today').onclick = () => { weekOffset = 0; renderCal(); });
  $('#cal-add') && ($('#cal-add').onclick = () => openJob({ date: iso(new Date()) }));
}

function renderHeaderStats() {
  const el = $('#hstat');
  if (!el) return;
  const need = convs.filter((c) => c.needs_human && c.status !== 'closed').length;
  const active = convs.filter((c) => c.status !== 'closed').length;
  // в воронке считаем согласованные суммы, а где их нет — оценку бота:
  // иначе цифра в шапке живёт своей жизнью и ей перестают верить
  const inFunnel = convs.filter((c) => c.status !== 'closed')
    .reduce((a, c) => a + (Number(c.deal_sum) || money(lead(c).price_quote)), 0);
  el.innerHTML = `
    <span class="hchip ${need ? 'warn' : ''}"><b>${need}</b> ждут ответа</span>
    <span class="hchip"><b>${active}</b> в работе</span>
    <span class="hchip gold"><b>${inFunnel.toLocaleString('ru-RU')} ₪</b> в воронке</span>`;
}

/** Выгрузка заявок для бухгалтерии или переноса в другую систему. */
function exportCsv() {
  const rows = convs.filter(matches);
  const head = ['Клиент', 'Телефон', 'Уборка', 'м²', 'Комнат', 'Санузлов', 'Район', 'Хочет', 'Записан', 'Оценка', 'Согласовано', 'Оплачено', 'Источник', 'Стадия', 'Обновлена'];
  const esc2 = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((c) => {
    const l = lead(c);
    return [l.name || c.name || '', '+' + c.phone, l.service, l.area_m2, l.rooms_count, l.bathrooms,
      l.district, l.date, c.job_date, l.price_quote, c.deal_sum || '', c.paid_sum || '', c.source,
      colTitle(columnOf(c)), c.last_at].map(esc2).join(';');
  });
  // BOM, иначе Excel не понимает кириллицу в UTF-8
  const blob = new Blob(['\uFEFF' + [head.map(esc2).join(';'), ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `заявки-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Выгружено ${rows.length} ${plural(rows.length, 'заявка', 'заявки', 'заявок')}`);
}

/** Заглушки на время первой загрузки: пустой экран читается как поломка. */
function skelCards(n) {
  return Array.from({ length: n }, () => `<div class="skel-card">
    <div class="skel-row"><span class="skel" style="width:32px;height:32px;border-radius:50%"></span>
      <span class="skel" style="height:11px;flex:1"></span></div>
    <span class="skel" style="height:9px;width:70%"></span>
    <span class="skel" style="height:9px;width:45%"></span></div>`).join('');
}

/* ───── графики: рисуем SVG сами, лишняя библиотека тут не нужна ───── */

/* ───── графики: рисуем сами, лишняя библиотека тут не нужна ───── */
const ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 14.5h2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M16 2.5v3M8 2.5v3M3 10h18"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
/**
 * Сумма из строки цены — та же логика, что amountOf в src/stages.js.
 * Раньше выбрасывались все нецифры, и «от 20 ₪/м², минимум 1500 ₪»
 * превращалось в 201 500 ₪ в шапке и колонках.
 */
function money(v) {
  if (typeof v === 'number') return v > 0 ? Math.round(v) : 0;
  const s = String(v ?? '').replace(/[\u00a0\u202f\u2009]/g, ' ');
  const range = s.match(/(\d[\d ,.]*\d)\s*[–—-]\s*\d[\d ,.]*\d\s*(?:₪|шек\w*|ils|nis|ש"ח|שקל\w*)(?!\s*\/)/i);
  if (range) { const n = Number(range[1].replace(/[ ,]/g, '')); if (n > 0) return n; }
  const re = /(\d[\d ,.]*\d|\d)\s*(?:₪|шек\w*|ils|nis|ש"ח|שקל\w*)(?!\s*\/\s*(?:м|m|מ))/gi;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[1].replace(/ /g, '').replace(/,(?=\d{3}\b)/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    if (n > 0) return Math.round(n);
  }
  const bare = s.trim().match(/^\d[\d ]*$/);
  return bare ? Number(bare[0].replace(/ /g, '')) : 0;
}
const ddmm = (d) => `${d.slice(8)}.${d.slice(5, 7)}`;

/** Мини-столбики для карточки показателя: на редких данных линия
    вырождается в треугольный пик, столбики читаются честнее. */
function mini(values) {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  return `<div class="mini">${values.map((v, i) =>
    `<i class="${i === values.length - 1 ? 'last' : ''}" style="height:${Math.max(9, v / max * 100)}%"></i>`).join('')}</div>`;
}

/** Столбики по дням. HTML вместо SVG с preserveAspectRatio=none:
    тот растягивал подписи дат вместе с графиком. */
function barChart(series) {
  const peak = Math.max(...series.map((p) => p.n), 1);
  const max = peak <= 4 ? 4 : Math.ceil(peak / 2) * 2;
  const today = iso(new Date());
  const step = Math.ceil(series.length / 10);
  const gap = series.length > 40 ? 2 : series.length > 14 ? 4 : 10;
  const grid = [max, max / 2, 0].map((v) =>
    `<div class="vc-grid" style="top:${(1 - v / max) * 100}%"><span>${v}</span></div>`).join('');
  const cols = series.map((p, i) => `<div class="vc-col ${p.n ? '' : 'zero'}" style="--h:${p.n / max * 100}">
      <div class="tip"><b>${ddmm(p.d)}</b>${p.n} ${plural(p.n, 'заявка', 'заявки', 'заявок')} · договорились ${p.won}</div>
      <div class="vc-stack" style="height:${p.n / max * 100}%;animation-delay:${i * 25}ms">
        ${p.n - p.won > 0 ? `<i style="flex:${p.n - p.won};background:var(--s1)"></i>` : ''}
        ${p.won ? `<i style="flex:${p.won};background:var(--s3)"></i>` : ''}</div></div>`).join('');
  const ticks = series.map((p, i) =>
    `<span class="${p.d === today ? 'today' : ''}">${i % step && p.d !== today ? '' : ddmm(p.d)}</span>`).join('');
  return `<div class="vc" style="--gap:${gap}px"><div class="vc-plot">${grid}<div class="vc-cols">${cols}</div></div>
    <div class="vc-x">${ticks}</div></div>`;
}

/** Воронка продаж: сколько заявок дошло до цены и до согласия. */
function funnel(s) {
  const steps = [
    { t: 'Заявки', v: s.total, c: 'var(--accent)' },
    { t: 'Предложение', v: s.quoted, c: 'var(--s4)', why: 'получили предложение' },
    { t: 'Согласовано', v: s.agreed, c: 'var(--s3)', why: 'согласились' },
    { t: 'Оплачено', v: s.paid, c: 'var(--green)', why: 'оплатили' }
  ];
  const base = s.total || 1;
  const pct = (a, b) => Math.min(100, Math.round(a / (b || 1) * 100));
  return `<div class="fun">${steps.map((x, i) => `
    ${i ? `<div class="fun-step">${ico(ICONS.down)}${pct(x.v, steps[i - 1].v)}% ${x.why}</div>` : ''}
    <div class="fun-row"><div class="fl"><span>${x.t}</span><b>${x.v}<em>${pct(x.v, base)}%</em></b></div>
      <div class="fun-track"><i style="width:${pct(x.v, base)}%;--c:${x.c};animation-delay:${i * 80}ms"></i></div></div>`).join('')}
  </div>`;
}

// цвета стадий те же, что у колонок доски и воронки в меню
const STAGE_COLOR = { 'Новая': 'var(--s1)', 'Уточнение': 'var(--accent)', 'Предложение отправлено': 'var(--s4)',
  'Согласовано / назначено': 'var(--s3)', 'Выполнено': 'var(--green)', 'Закрыто · оплачено': 'var(--green)', 'Закрыто · проиграно': 'var(--muted)',
  'Закрыто · неквалифицировано · обычная уборка': 'var(--border)', 'Закрыто · неквалифицировано · сотрудник': 'var(--border)' };

const pempty = (text, icon) => `<div class="pempty">${icon ? ico(icon) : ''}${text}</div>`;

function hbars(rows, color) {
  if (!rows.length) return pempty('нет данных');
  const max = Math.max(...rows.map((r) => r[1]));
  return rows.map(([n, v], i) => `<div class="hb" style="--c:${color}"><span class="n" dir="auto">${esc(n)}</span>
    <span class="track"><span class="fill" style="width:${Math.round(v / max * 100)}%;animation-delay:${i * 50}ms"></span></span>
    <span class="v">${v}</span></div>`).join('');
}

function renderDash() {
  const el = $('#dash');
  if (!stats) {
    el.innerHTML = `<div class="kpis">${Array.from({ length: 6 }, () => `<div class="skel-kpi">
      <span class="skel" style="height:10px;width:55%"></span>
      <span class="skel" style="height:26px;width:42%"></span>
      <span class="skel" style="height:9px;width:64%"></span></div>`).join('')}</div>`;
    loadStats();          // иначе раздел навсегда останется в заглушках
    return;
  }
  const s = stats;
  const conv = s.total ? Math.round(s.agreed / s.total * 100) : 0;
  const secs = s.avg_reply_sec;
  $('#pg-sub').textContent = `за ${s.days} ${plural(s.days, 'день', 'дня', 'дней')}`;
  const recent = s.by_day.slice(-14);
  const prev = s.prev || {};
  /** Динамика к прошлому такому же периоду: число без сравнения мало о чём говорит. */
  const delta = (now, was) => {
    if (!was) return now ? '<span class="dl up">новое</span>' : '';
    const p = Math.round((now - was) / was * 100);
    if (!p) return '<span class="dl">0%</span>';
    return `<span class="dl ${p > 0 ? 'up' : 'down'}">${p > 0 ? '↑' : '↓'} ${Math.abs(p)}%</span>`;
  };
  const kpi = (k, icon, t, v, d, extra = '') => `<div class="kpi" style="--k:${k}">
    <div class="kpi-top"><span class="ico">${ico(ICONS[icon])}</span><span class="t">${t}</span></div>
    ${v}<div class="d">${d}</div>${extra}</div>`;

  el.innerHTML = `
    <div class="kpis">
      ${kpi('var(--s1)', 'inbox', 'Заявки', `<div class="v">${s.total}${delta(s.total, prev.total)}</div>`,
        `сегодня ${s.today}`, mini(recent.map((d) => d.n)))}
      ${kpi('var(--warn)', 'clock', 'Ждут ответа', `<div class="v ${s.need_human ? 'hot' : ''}">${s.need_human}</div>`,
        s.need_human ? 'передано человеку' : 'очередь пуста')}
      ${kpi('var(--s3)', 'check', 'Договорились', `<div class="v">${s.agreed}${delta(s.agreed, prev.agreed)}</div>`,
        `конверсия ${conv}%`, mini(recent.map((d) => d.won)))}
      ${kpi('var(--s4)', 'wallet', 'Средний чек',
        `<div class="v">${s.avg_check ? s.avg_check.toLocaleString('ru-RU') + '<small>₪</small>' : '—'}${delta(s.avg_check, prev.avg_check)}</div>`,
        s.money?.agreed?.n ? `по ${s.money.agreed.n} ${plural(s.money.agreed.n, 'согласованной', 'согласованным', 'согласованным')} ${plural(s.money.agreed.n, 'сумме', 'суммам', 'суммам')}` : 'согласованных сумм пока нет')}
      ${kpi('var(--accent)', 'bolt', 'Ответ бота',
        `<div class="v">${secs ? (secs < 120 ? secs + '<small>с</small>' : Math.round(secs / 60) + '<small>мин</small>') : '—'}</div>`,
        'медиана, рабочие часы')}
      ${kpi('var(--s5)', 'camera', 'Фото от клиентов', `<div class="v">${s.photos}</div>`, 'за период')}
    </div>
    <div class="panels top">
      <div class="panel">
        <div class="ph"><div><h3>Заявки по дням</h3><div class="s">${s.total} ${plural(s.total, 'заявка', 'заявки', 'заявок')} за период</div></div>
          <div class="r"><span><i style="background:var(--s1)"></i>заявки</span><span><i style="background:var(--s3)"></i>договорились</span></div></div>
        ${barChart(s.by_day)}</div>
      <div class="panel">
        <div class="ph"><div><h3>Воронка</h3><div class="s">конверсия в заказ ${conv}%</div></div></div>
        ${funnel(s)}
        <div class="panel-foot"><div class="stg">${s.by_stage.map(([n, v]) =>
          `<span><i style="background:${STAGE_COLOR[n] || 'var(--s1)'}"></i>${esc(n)} <b>${v}</b></span>`).join('')}
</div>
          ${s.money ? `<div class="info"><span>Оценки бота</span><b>${s.money.quoted.sum.toLocaleString('ru-RU')} ₪ · ${s.money.quoted.n}</b></div>
            <div class="info"><span>Согласовано</span><b>${s.money.agreed.sum.toLocaleString('ru-RU')} ₪ · ${s.money.agreed.n}</b></div>
            <div class="info"><span>Оплачено</span><b>${s.money.paid.sum.toLocaleString('ru-RU')} ₪ · ${s.money.paid.n}</b></div>` : ''}
          ${s.nudges ? `<div class="info"><span>Напоминания</span><b>${s.nudges.sent} → ${s.nudges.replied} ответили${s.nudges.sent ? ` · ${Math.round(s.nudges.replied / s.nudges.sent * 100)}%` : ''}</b></div>` : ''}</div>
      </div>
    </div>
    <div class="panels low">
      <div class="panel"><div class="ph"><div><h3>Ближайшие уборки</h3><div class="s">что в работе на этой неделе</div></div></div>
        <div id="dash-jobs" class="joblist"></div></div>
      <div class="panel"><div class="ph"><div><h3>Типы уборки</h3><div class="s">по всем заявкам периода</div></div></div>${hbars(s.by_service, 'var(--s1)')}</div>
      <div class="panel"><div class="ph"><div><h3>Районы</h3><div class="s">откуда пишут клиенты</div></div></div>${hbars(s.by_district, 'var(--accent)')}</div>
      <div class="panel"><div class="ph"><div><h3>Источники</h3><div class="s">с какой рекламы пришёл клиент</div></div></div>${hbars(s.by_source || [], 'var(--s4)')}</div>
    </div>`;

  // ближайшие заказы: сводка должна отвечать и на вопрос «что сегодня делать»
  api('/api/schedule').then((rows) => {
    const box = $('#dash-jobs');
    if (!box) return;
    const today = iso(new Date());
    const soon = rows.filter((j) => j.date >= today).slice(0, 5);
    box.innerHTML = soon.length ? soon.map((j) => {
      const d = new Date(j.date + 'T12:00:00');
      return `<div class="jrow" data-id="${j.id}">
        <span class="jdate ${j.date === today ? 'today' : ''}"><b>${d.getDate()}</b><span>${d.toLocaleDateString('ru-RU', { weekday: 'short' })}</span></span>
        <div class="jtxt"><div class="jn" dir="auto">${esc(j.name || '+' + j.phone)}</div>
          <div class="js" dir="auto">${esc([j.time, j.service, j.area && j.area + ' м²', j.district].filter(Boolean).join(' · '))}</div></div>
        ${j.price ? `<span class="jp">${esc(j.price)}</span>` : ''}
      </div>`;
    }).join('') : pempty('пока ничего не назначено', ICONS.cal);
    $$('.jrow', box).forEach((r) => r.onclick = () => openConv(Number(r.dataset.id), true));
  }).catch(() => {});
}

/* ───── доска ───── */
/** Сколько клиент ждёт ответа — считаем от его последнего сообщения. */


/** Сумма названных цен в колонке — видно, где лежат деньги. */

/* ───── расписание ─────
   Неделя начинается с воскресенья: в Израиле это первый рабочий день. */
const iso = (d) => new Intl.DateTimeFormat('sv-SE').format(d);

function weekDays(offset) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + offset * 7);
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

async function renderCal() {
  const el = $('#cal-week');
  if (!el) return;
  jobs = await api('/api/schedule');
  const days = weekDays(weekOffset);
  const hours = state.work_hours || {};
  const hol = Object.fromEntries((await api('/api/holidays')).map((h) => [h.date, h.name]));
  const today = iso(new Date());

  const from = days[0].toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const to = days[6].toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  $('#pg-sub').textContent = `${from} — ${to}`;
  $('#cal-today')?.classList.toggle('on', weekOffset === 0);

  const week = jobs.filter((j) => j.date >= iso(days[0]) && j.date <= iso(days[6]));
  const total = week.reduce((a, j) => a + money(j.price), 0);
  const pending = week.filter((j) => j.kind === 'wish').length;
  const free = days.filter((d) => Array.isArray(hours[d.getDay()]) && !hol[iso(d)] && iso(d) >= today
    && !jobs.some((j) => j.date === iso(d))).length;
  $('#cal-sum').innerHTML = `
    <div class="cs"><b>${week.length}</b>${plural(week.length, 'уборка', 'уборки', 'уборок')}</div>
    <div class="cs gold"><b>${total ? total.toLocaleString('ru-RU') + ' ₪' : '—'}</b>на неделе</div>
    <div class="cs ${pending ? 'warn' : ''}"><b>${pending}</b>${plural(pending, 'пожелание клиента', 'пожелания клиентов', 'пожеланий клиентов')}</div>
    <div class="cs"><b>${free}</b>${plural(free, 'свободный день', 'свободных дня', 'свободных дней')}</div>
    <div class="grow"></div>
    <div class="cal-legend"><span><i style="background:var(--s3)"></i>записана</span>
      <span><i style="background:var(--warn)"></i>хочет, но не записан</span><span><i class="hatch"></i>выходной</span></div>`;

  el.innerHTML = days.map((d, di) => {
    const key = iso(d), mine = jobs.filter((j) => j.date === key);
    const isHol = hol[key];
    const h = hours[d.getDay()];
    const working = Array.isArray(h) && !isHol;
    const sum = mine.reduce((a, j) => a + money(j.price), 0);
    const when = working ? h.join('–') : isHol ? 'праздник' : 'выходной';
    const cls = [!working && 'off', key === today && 'today', key < today && 'past'].filter(Boolean).join(' ');
    return `<div class="cday ${cls}" data-date="${key}" style="animation-delay:${di * 30}ms">
      <div class="cday-h"><span class="cday-num">${d.getDate()}</span>
        <div class="cday-wd"><b>${d.toLocaleDateString('ru-RU', { weekday: 'long' })}</b>
          <span>${esc(when)}</span></div>
        ${mine.length ? `<span class="n">${mine.length}</span>` : ''}</div>
      ${isHol ? `<div class="chol">${esc(isHol)}</div>` : ''}
      <div class="cday-b">${mine.map(jobHtml).join('')
        || `<div class="cal-empty">${working && key >= today ? 'свободно' : ''}</div>`}</div>
      ${sum ? `<div class="cday-f"><span>итого за день</span><b>${sum.toLocaleString('ru-RU')} ₪</b></div>` : ''}
    </div>`;
  }).join('');
  $$('.job', el).forEach((j) => j.onclick = () => (j.dataset.kind === 'manual'
    ? openJob(jobs.find((x) => x.kind === 'manual' && x.id === Number(j.dataset.id)))
    : openConv(Number(j.dataset.id), true)));
  // клик по пустому месту дня — завести уборку на этот день
  $$('.cday', el).forEach((d) => d.addEventListener('click', (e) => {
    if (e.target.closest('.job')) return;
    openJob({ date: d.dataset.date });
  }));

  const upcoming = jobs.filter((j) => j.date >= today).length;
  const badge = $('#nav-cal');
  badge.textContent = upcoming; badge.classList.toggle('hidden', !upcoming);
}

function jobHtml(j, i) {
  const tag = j.kind === 'wish' ? '<span class="st wish">хочет, не записан</span>'
    : j.kind === 'manual' ? '<span class="st hand">вручную</span>' : '';
  return `<div class="job ${j.kind === 'wish' ? 'unconfirmed wish' : ''}" data-id="${j.id}" data-kind="${j.kind}"
    style="animation-delay:${i * 40}ms">
    <div class="jt">${ico(ICONS.time)}${esc(j.time || 'время не назначено')}${tag}</div>
    <b dir="auto">${esc(j.name || '+' + j.phone)}</b>
    <div class="m">${esc([j.service, j.area && j.area + ' м²'].filter(Boolean).join(' · '))}</div>
    ${j.district ? `<div class="m" dir="auto">${ico(ICONS.pin)}${esc(j.district)}</div>` : ''}
    ${j.price ? `<span class="p">${esc(j.price)}</span>` : ''}
  </div>`;
}

/* ───── уборка, заведённая руками ─────
   В расписание попадает не только то, что прошло через бота: клиент звонит,
   приходит по сарафану или заказывает постоянно. Без ручной записи календарь
   показывает неправду, и им перестают пользоваться. */
const jobDlg = $('#job-dlg');
let jobEditing = null;

function openJob(job = {}) {
  jobEditing = job.kind === 'manual' ? job : null;
  const form = $('#job-form');
  form.reset();
  for (const [k, v] of Object.entries(job)) {
    const el = form.elements[k];
    if (el && v != null) el.value = v;
  }
  $('#job-ttl').textContent = jobEditing ? 'Уборка' : 'Новая уборка';
  $('#job-sub').textContent = jobEditing
    ? 'заведена вручную, без заявки в чате'
    : 'клиент позвонил или пришёл не из чата';
  $('#job-del').style.display = jobEditing ? '' : 'none';
  jobDlg.showModal();
  form.elements.name.focus();
}

jobDlg && (() => {
  const form = $('#job-form');
  const close = () => jobDlg.close();
  $('#job-x').onclick = close;
  $('#job-cancel').onclick = close;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      await api(jobEditing ? `/api/jobs/${jobEditing.id}` : '/api/jobs',
        { method: 'POST', body: JSON.stringify(body) });
      close();
      toast(jobEditing ? 'Уборка обновлена' : 'Уборка в расписании');
      renderCal();
    } catch (err) { toast(err.message, true); }
  };
  $('#job-del').onclick = async () => {
    if (!jobEditing || !confirm('Убрать эту уборку из расписания?')) return;
    try {
      await api(`/api/jobs/${jobEditing.id}`, { method: 'DELETE' });
      close();
      toast('Уборка удалена');
      renderCal();
    } catch (err) { toast(err.message, true); }
  };
})();

/* ───── доска: обзор воронки ─────
   Список отвечает на «кому ответить сейчас», доска — на «где что застряло
   и где деньги». Это разные вопросы, поэтому оба вида нужны. */
function waitHtml(c) {
  // в архиве «ждёт 15 ч» — вранье: заявку закрыли, никто её не ждёт
  if (!c.needs_human || !c.last_in_at || c.status === 'closed') return '';
  const min = Math.floor((Date.now() - dt(c.last_in_at)) / 6e4);
  return `<span class="wait ${min >= 10 ? 'hot' : ''}">ждёт ${min < 60 ? min + ' мин' : Math.floor(min / 60) + ' ч'}</span>`;
}

function cardHtml(c) {
  const l = lead(c);
  const facts = [l.service, l.area_m2 && l.area_m2 + ' м²', l.district, l.date]
    .filter(Boolean).map((f) => `<span class="fact">${esc(f)}</span>`).join('')
    + (l.price_quote ? `<span class="fact price">${esc(l.price_quote)}</span>` : '');
  const thumbs = (c.thumbs || []).map((it, i) => {
    const tag = it.kind === 'video'
      ? `<video src="/media/${esc(it.file)}" preload="metadata"></video>`
      : `<img src="/media/${esc(it.file)}" loading="lazy" alt="">`;
    return i === 2 && c.media_count > 3 ? `<span class="more" data-n="+${c.media_count - 2}">${tag}</span>` : tag;
  }).join('');

  return `<div class="card" draggable="true" data-id="${c.id}">
    <div class="card-top">
      <span class="ava">${esc(initials(l.name || c.name, c.phone))}</span>
      <div class="card-id"><b dir="auto">${esc(l.name || c.name || '+' + c.phone)}</b><span>+${esc(c.phone)}</span></div>
      ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
    </div>
    ${facts ? `<div class="facts">${facts}</div>` : ''}
    ${thumbs ? `<div class="card-thumbs">${thumbs}</div>` : ''}
    <div class="card-snip" dir="auto">${esc(c.summary || c.last_body || '')}</div>
    <div class="card-foot">${chipFor(c)}${waitHtml(c)}
      <span class="t">${c.needs_human && c.last_in_at ? '' : ago(c.last_at)}</span></div>
  </div>`;
}

function subLine(n) {
  const el = $('#pg-sub');
  const flagT = { need: 'нужен менеджер', review: 'проверить после переноса', call: 'позвонить', late: 'звонок просрочен', red: 'красные флаги' }[flagFilter];
  el.innerHTML = `${n} ${plural(n, 'заявка', 'заявки', 'заявок')}`
    + (stageFilter ? ` · ${esc(colTitle(stageFilter))}` : '')
    + (flagT ? ` · ${flagT}` : '')
    + (stageFilter || flagT ? '<span class="clr" id="clr-stage">сбросить</span>' : '');
  const x = $('#clr-stage');
  if (x) x.onclick = () => { flagFilter = null; setStage(null); };
}

/**
 * Перенос карточки. Проверяем результат, а не верим себе на слово: раньше тост
 * говорил «перенесено», сервер менял только стадию, флаг «нужен человек»
 * оставался — и карточка возвращалась на место. Теперь расхождение видно сразу.
 */
async function moveTo(id, key) {
  let reason = null;
  if (key === 'lost') {
    // ТЗ §13: проигранная сделка без причины не закрывается — иначе нечего анализировать
    reason = prompt('Почему сделка проиграна? Например: дорого, выбрал другую компанию, передумал');
    if (!reason || !reason.trim()) { toast('Без причины проигрыш не сохраняется', true); return false; }
  }
  const body = isArchive(key) ? { stage: 'closed', close: key, reason } : { stage: key };
  try {
    const updated = await api(`/api/conversations/${id}/stage`, { method: 'POST', body: JSON.stringify(body) });
    const landed = columnOf(updated);
    if (landed === key) toast('Перенесено в «' + colTitle(key) + '»');
    else toast(`Не удалось перенести: заявка осталась в «${colTitle(landed)}»`, true);
    const i = convs.findIndex((c) => c.id === id);
    if (i >= 0) convs[i] = { ...convs[i], ...updated };
    loadList();
    if (current === id) openConv(id, drawerOpen);
    return landed === key;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

function setStage(k) {
  stageFilter = k;
  $('.app').classList.remove('menu-open');
  renderFunnel();
  if (page !== 'inbox') go('inbox'); else PAGES.inbox.render();
}

/** Воронка в боковом меню: сколько заявок на каждой стадии, клик — фильтр. */
function renderFunnel() {
  const box = $('#funnel');
  if (!box) return;
  const by = Object.fromEntries(ALL_COLS.map((x) => [x.k, 0]));
  convs.forEach((c) => by[columnOf(c)]++);
  const bar = COLUMNS.filter((x) => by[x.k])
    .map((x) => `<i style="flex:${by[x.k]};background:${x.c}" title="${x.t}: ${by[x.k]}"></i>`).join('')
    || '<i style="flex:1;background:var(--border)"></i>';
  const archived = ARCHIVE.reduce((a, x) => a + by[x.k], 0);
  // очереди по признакам: ради «нужен менеджер» менеджер и открывает CRM
  const needN = convs.filter((c) => c.needs_human && c.status !== 'closed').length;
  const reviewN = convs.filter((c) => c.review).length;
  const lateN = convs.filter((c) => callState(c) === 'late').length;
  const redN = convs.filter((c) => c.stage !== 'closed' && (c.warn || []).some((w) => w.level === 'red')).length;
  const callN = convs.filter((c) => callState(c) === 'call').length;
  const wip = Number(state.wip_need) || 0;
  const flagRow = (k, t, n, c, alert, tone = '') => `<a class="frow flag ${tone} ${flagFilter === k ? 'on' : ''} ${n ? '' : 'zero'} ${alert ? 'alert' : ''}"
      data-flag="${k}"><span class="fdot" style="--c:${c}"></span><span class="lbl">${t}</span>
      <span class="fn">${n}${k === 'need' && wip && n > wip ? ' / ' + wip : ''}</span></a>`;
  box.innerHTML = `<div class="fbar">${bar}</div>`
  + flagRow('late', 'Звонок просрочен', lateN, 'var(--danger)', lateN > 0, 'danger')
  + flagRow('call', 'Позвонить', callN, 'var(--s1)', false)
  + flagRow('red', 'Красные флаги', redN, 'var(--danger)', false)
  + flagRow('need', 'Нужен менеджер', needN, 'var(--warn)', needN > 0)
  + (reviewN ? flagRow('review', 'Проверить после переноса', reviewN, 'var(--s5)', false) : '')
  + '<div class="fsep"></div>'
  + COLUMNS.map((x) => {
    const cls = [stageFilter === x.k && 'on', !by[x.k] && 'zero'].filter(Boolean).join(' ');
    return `<a class="frow ${cls}" data-k="${x.k}"><span class="fdot" style="--c:${x.c}"></span>
      <span class="lbl">${x.t}</span><span class="fn">${by[x.k]}</span></a>`;
  }).join('')
  // архив одной строкой: внутри него свои корзины, и ими не фильтруют воронку
  + `<a class="frow arch ${archived ? '' : 'zero'}" data-arch="1"><span class="fdot" style="--c:var(--muted)"></span>
      <span class="lbl">Архив</span><span class="fn">${archived}</span></a>`;
  $$('.frow[data-k]', box).forEach((r) => r.onclick = () => setStage(stageFilter === r.dataset.k ? null : r.dataset.k));
  $$('.frow[data-flag]', box).forEach((r) => r.onclick = () => {
    flagFilter = flagFilter === r.dataset.flag ? null : r.dataset.flag;
    if (flagFilter && leadView === 'archive') { leadView = 'list'; localStorage.setItem('leadView', leadView); }
    $('.app').classList.remove('menu-open');
    renderFunnel();
    if (page !== 'inbox') go('inbox'); else go('inbox');
  });
  const arch = box.querySelector('[data-arch]');
  if (arch) arch.onclick = () => {
    stageFilter = null;
    leadView = 'archive';
    localStorage.setItem('leadView', leadView);
    $('.app').classList.remove('menu-open');
    go('inbox');
  };
}

function renderBoard() {
  const board = $('#board');
  if (!board || dragging) return;
  const cols = leadView === 'archive' ? ARCHIVE : COLUMNS;
  const rows = convs.filter(matches).filter((c) => isArchive(columnOf(c)) === (leadView === 'archive'));
  const by = Object.fromEntries(ALL_COLS.map((x) => [x.k, []]));
  rows.forEach((c) => by[columnOf(c)].push(c));
  subLine(rows.length);
  renderHeaderStats();

  const wip = Number(state.wip_need) || 0;
  paint(board, cols.map((col) => {
    const items = by[col.k];
    const sum = items.reduce((a, c) => a + money(lead(c).price_quote), 0);
    const over = false;   // предел очереди «нужен менеджер» показывается в меню у флага
    const dim = stageFilter && stageFilter !== col.k ? 'dim' : '';
    return `<div class="colm ${over ? 'over-wip' : ''} ${dim}" data-col="${col.k}" style="--c:${col.c}">
      <div class="colm-head"><b>${col.t}</b>
        ${sum ? `<span class="sum">${sum.toLocaleString('ru-RU')} ₪</span>` : ''}
        <span class="cnt">${items.length}${over ? ' / ' + wip : ''}</span></div>
      ${over ? '<div class="wip-warn">Очередь переполнена — клиенты ждут слишком долго</div>' : ''}
      <div class="colm-body">${items.map(cardHtml).join('')
        || `<div class="colm-empty">${col.hint}</div>`}</div></div>`;
  }).join(''));

  if (stageFilter) board.querySelector(`[data-col="${stageFilter}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $$('.card', board).forEach((el) => {
    el.onclick = () => openConv(Number(el.dataset.id), true);
    el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', el.dataset.id); el.classList.add('dragging'); dragging = true; };
    el.ondragend = () => { el.classList.remove('dragging'); dragging = false; };
  });
  $$('.colm', board).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = async (e) => {
      e.preventDefault(); col.classList.remove('over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const conv = convs.find((c) => c.id === id);
      if (!conv || columnOf(conv) === col.dataset.col) return;
      await moveTo(id, col.dataset.col);
    };
  });
}

/* ───── список заявок ─────
   Плотные строки с выровненными колонками вместо карточек: за один экран
   помещается втрое больше, и заявки читаются сканированием, а не разглядыванием. */
const COLLAPSED = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));

function rowHtml(c) {
  const l = lead(c);
  const col = ALL_COLS.find((x) => x.k === columnOf(c));
  // В строке только то, что нужно для выбора: кто, о чём и на сколько.
  // Тип уборки, площадь, район и дата целиком показаны в карточке справа —
  // их дублирование в узкой колонке раздувало строку до 150 пикселей.
  return `<div class="lrow ${c.id === current ? 'sel' : ''}" data-id="${c.id}">
    <span class="ava">${esc(initials(l.name || c.name, c.phone))}</span>
    <div class="txt">
      <div class="lname" dir="auto">
        <span class="lflag" style="background:${col.c}" title="${col.t}"></span>
        ${esc(l.name || c.name || '+' + c.phone)}
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}
        ${l.price_quote ? `<span class="lp">${esc(l.price_quote)}</span>` : ''}
        <span class="t">${ago(c.last_at)}</span>
      </div>
      <div class="lsum" dir="auto">${esc(c.summary || c.last_body || '')}</div>
    </div>
  </div>`;
}

function renderLeads() {
  const box = $('#list');
  if (!box) return;
  const rows = convs.filter(matches);
  const by = Object.fromEntries(ALL_COLS.map((x) => [x.k, []]));
  rows.forEach((c) => by[columnOf(c)].push(c));
  subLine(rows.length);
  renderHeaderStats();

  const wip = Number(state.wip_need) || 0;
  paint(box, ALL_COLS.map((col) => {
    const items = by[col.k];
    // пустые группы не показываем: они занимали место и подсказка в строке
    // читалась как содержимое. Исключение — очередь «Нужен человек»:
    // её ноль сам по себе новость
    if (!items.length && col.k !== 'clarify') return '';
    const sum = items.reduce((a, c) => a + money(lead(c).price_quote), 0);
    const closed = COLLAPSED.has(col.k);
    const over = false;
    return `<div class="grp ${closed ? 'closed' : ''}" data-g="${col.k}">
        <span class="caret">▾</span><span class="dot" style="background:${col.c}"></span>
        <b>${col.t}</b><span class="n">${items.length}${over ? ' / ' + wip : ''}</span>
        ${sum ? `<span class="sum">${sum.toLocaleString('ru-RU')} ₪</span>` : ''}
      </div>
      ${closed ? '' : items.map(rowHtml).join('')}`;
  }).join(''));

  $$('.grp', box).forEach((g) => g.onclick = () => {
    const k = g.dataset.g;
    COLLAPSED.has(k) ? COLLAPSED.delete(k) : COLLAPSED.add(k);
    localStorage.setItem('collapsed', JSON.stringify([...COLLAPSED]));
    renderLeads();
  });
  // открываем прямо в средней панели: главная работа не должна прятаться за overlay
  $$('.lrow', box).forEach((r) => r.onclick = () => openConv(Number(r.dataset.id), isMobile()));
}

/** Перемещение по списку с клавиатуры, как в почтовых клиентах. */
function moveSel(step) {
  const rows = $$('.lrow');
  if (!rows.length) return;
  const i = rows.findIndex((r) => Number(r.dataset.id) === current);
  const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + step)))];
  next.scrollIntoView({ block: 'nearest' });
  openConv(Number(next.dataset.id), false);
}

/* ───── чат ───── */
function mediaHtml(m) {
  const items = m.media ? JSON.parse(m.media) : [];
  if (!items.length) return '';
  return `<div class="imgs ${items.length === 1 ? 'one' : ''}">` + items.map((it) => it.kind === 'video'
    ? `<video src="/media/${esc(it.file)}" controls preload="metadata"></video>`
    : it.kind === 'audio'
      ? `<audio src="/media/${esc(it.file)}" controls preload="metadata"></audio>`
      : `<img src="/media/${esc(it.file)}" loading="lazy" alt="фото">`).join('') + '</div>';
}
function chatHtml(c) {
  return `<div class="chat-head">
      <div class="ava lg">${esc(initials(c.name, c.phone))}</div>
      <div class="t"><b dir="auto">${esc(c.name || 'Без имени')}</b><span>+${esc(c.phone)}</span></div>
      ${chipFor(c)}<div class="grow"></div>
      ${c.ai_enabled ? '<button class="btn warn" data-a="takeover">Перехватить</button>'
                     : '<button class="btn primary" data-a="giveback">Вернуть ИИ</button>'}
      <button class="btn" data-a="card">Карточка</button>
      <button class="btn ghost" data-a="close">${c.status === 'closed' ? 'Открыть' : 'Закрыть'}</button>
    </div>
    ${c.needs_human ? `<div class="alert">⚠ ${esc(c.handoff_reason || 'ИИ просит подключиться')}</div>` : ''}
    <div class="scroll" data-r="wrap"><div class="thread" data-r="thread"></div></div>
    <div class="composer"><div class="composer-box">
      <textarea data-r="inp" dir="auto" rows="1" placeholder="Написать клиенту…"></textarea>
      <div class="composer-side">
        <label class="switch"><input type="checkbox" data-r="keep"><span>не выключать ИИ</span></label>
        <div style="display:flex;gap:7px">
          <button class="btn" data-a="qr" title="Заготовки ответов — клавиша /">Шаблоны</button>
          <button class="btn" data-a="suggest" title="ИИ напишет черновик, отправите сами">Подсказать</button>
          <button class="btn primary" data-a="send">Отправить</button>
        </div>
      </div></div></div>`;
}
function threadHtml(c) {
  let html = '', lastDay = '', prev = null;
  for (const m of c.messages) {
    const d = dayLabel(m.created_at);
    if (d !== lastDay) { html += `<div class="daysep">${d}</div>`; lastDay = d; prev = null; }
    if (m.author === 'system') { html += `<div class="sys">${esc(m.body)}</div>`; prev = null; continue; }
    const grouped = prev && prev.author === m.author && (dt(m.created_at) - dt(prev.created_at)) < 12e4;
    const who = m.author === 'human' ? (m.author_name || 'менеджер') : { customer:'клиент', ai:'ИИ' }[m.author];
    html += `<div class="row ${m.direction === 'out' ? 'out' : 'in'} ${m.author === 'human' ? 'byhuman' : ''} ${grouped ? 'grouped' : ''}">
      <div class="bub ${m.error ? 'err' : ''}" dir="auto">${mediaHtml(m)}${esc(m.body)}
        <div class="meta">${who} · ${hhmm(m.created_at)}${m.error ? ' · не доставлено' : ''}</div></div></div>`;
    prev = m;
  }
  return html;
}
function bindChat(root) {
  const c = detail, q = (s) => root.querySelector(s);
  q('[data-r="thread"]').innerHTML = threadHtml(c);
  const wrap = q('[data-r="wrap"]'); wrap.scrollTop = wrap.scrollHeight;
  $$('img', root).forEach((i) => i.onclick = () => window.open(i.src, '_blank'));
  q('[data-a="takeover"]') && (q('[data-a="takeover"]').onclick = () => setMode(false));
  q('[data-a="giveback"]') && (q('[data-a="giveback"]').onclick = () => setMode(true));
  // В архиве три корзины, и выбирать её должен человек: свои сотрудники,
  // живой лид «не сейчас» и настоящий отказ — это разные вещи.
  q('[data-a="close"]').onclick = (e) => {
    if (c.status === 'closed') return moveTo(c.id, 'clarify');
    const old = root.querySelector('.pickmenu');
    if (old) return old.remove();
    const menu = document.createElement('div');
    menu.className = 'pickmenu';
    menu.innerHTML = '<div class="hint">Закрыть сделку как…</div>'
      + ARCHIVE.filter((x) => x.k !== 'paid')   // оплаченной сделка становится, когда внесена сумма оплаты
        .map((x) => `<div data-k="${x.k}"><b>${x.t}</b><span>${x.hint}</span></div>`).join('');
    e.currentTarget.parentElement.appendChild(menu);
    $$('div[data-k]', menu).forEach((d) => d.onclick = () => { menu.remove(); moveTo(c.id, d.dataset.k); });
    setTimeout(() => document.addEventListener('click', function off(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); }
    }), 0);
  };
  const inp = q('[data-r="inp"]');
  inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px'; };
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(root); } };
  q('[data-a="send"]').onclick = () => send(root);

  /* Заготовки: менеджер пишет одно и то же по десять раз в день.
     Открываются кнопкой или «/» в пустом поле, выбираются стрелками. */
  const quick = (getSettingList('quick_replies'));
  const closeQr = () => root.querySelector('.qr')?.remove();
  function openQr(filter = '') {
    closeQr();
    const items = quick.filter((t) => t.toLowerCase().includes(filter.toLowerCase()));
    if (!items.length) return;
    const el = document.createElement('div');
    el.className = 'qr';
    el.innerHTML = '<div class="hint">Заготовки — ↑↓ и Enter, Esc закрыть</div>'
      + items.map((t, i) => `<div class="${i ? '' : 'on'}" data-t="${esc(t)}">${esc(t)}</div>`).join('');
    root.querySelector('.composer').appendChild(el);
    $$('div[data-t]', el).forEach((d) => d.onclick = () => { inp.value = d.dataset.t; closeQr(); inp.focus(); });
  }
  q('[data-a="qr"]').onclick = () => (root.querySelector('.qr') ? closeQr() : openQr());
  inp.addEventListener('keydown', (e) => {
    const box = root.querySelector('.qr');
    if (e.key === '/' && !inp.value) { e.preventDefault(); openQr(); return; }
    if (!box) return;
    const opts = $$('div[data-t]', box);
    const cur = opts.findIndex((o) => o.classList.contains('on'));
    if (e.key === 'Escape') { e.preventDefault(); closeQr(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = Math.max(0, Math.min(opts.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o, i) => o.classList.toggle('on', i === n));
      opts[n].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && cur >= 0) {
      e.preventDefault(); e.stopPropagation();
      inp.value = opts[cur].dataset.t; closeQr();
      inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
    }
  }, true);
  q('[data-a="suggest"]').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Думаю…';
    try {
      const { text } = await api(`/api/conversations/${c.id}/suggest`, { method: 'POST' });
      inp.value = text;
      inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
      inp.focus();
      toast('Черновик готов — проверьте и отправьте');
    } catch (err) { toast('Не вышло: ' + err.message, true); }
    b.disabled = false; b.textContent = 'Подсказать';
  };
  inp.focus();
}
async function setMode(ai) {
  await api(`/api/conversations/${current}/mode`, { method: 'POST', body: JSON.stringify({ ai_enabled: ai }) });
  openConv(current, drawerOpen);
}
async function send(root) {
  const inp = root.querySelector('[data-r="inp"]'), btn = root.querySelector('[data-a="send"]');
  const t = inp.value.trim();
  if (!t) return;
  btn.disabled = true;
  try {
    await api(`/api/conversations/${current}/send`, { method: 'POST',
      body: JSON.stringify({ text: t, keep_ai: root.querySelector('[data-r="keep"]').checked }) });
    inp.value = '';
  } catch (e) { toast('Не отправилось: ' + e.message, true); }
  btn.disabled = false;
  openConv(current, drawerOpen);
}

/* ───── карточка заявки ───── */
const MEDIA_SERVICES = ['после ремонта', 'перед въездом', 'после выезда', 'генеральная', 'поддерживающая'];
const LABELS = { service:'Тип уборки', object_type:'Объект', area_m2:'Площадь, м²', rooms_count:'Комнат',
  bathrooms:'Санузлов', district:'Район', address:'Адрес', works:'Что сделать', date:'Хочет убрать',
  windows:'Мыть окна', condition:'Загрязнение', price_quote:'Оценка бота', stage:'Стадия по оценке бота' };

// поля диалога, а не карточки: запись подтверждает человек, источник приходит с рекламы
const CONV_KEYS = new Set(['job_date', 'job_time', 'source', 'deal_sum', 'paid_sum', 'paid_at',
  'followup_at', 'followup_note']);

// что можно править руками и чем: ИИ ошибается, а по телефону он не слышит
const EDITABLE = [
  ['name', 'Имя', 'text'],
  ['service', 'Тип уборки', 'select', ['', 'после ремонта', 'перед въездом', 'после выезда', 'генеральная', 'поддерживающая']],
  ['object_type', 'Объект', 'text'],
  ['area_m2', 'Площадь, м²', 'text'],
  ['rooms_count', 'Комнат', 'text'],
  ['bathrooms', 'Санузлов', 'text'],
  ['district', 'Район', 'text'],
  ['address', 'Адрес', 'text'],
  ['works', 'Что сделать', 'text'],
  ['date_iso', 'Желаемая дата', 'date'],
  ['time', 'Желаемое время', 'text'],
  ['job_date', 'Записан на', 'date'],
  ['job_time', 'Время записи', 'text'],
  ['source', 'Источник', 'text'],
  ['followup_at', 'Напомнить о себе', 'date'],
  ['followup_note', 'О чём напомнить', 'text'],
  ['windows', 'Мыть окна', 'select', ['', 'да', 'нет']],
  ['condition', 'Загрязнение', 'select', ['', 'лёгкое', 'среднее', 'сильное', 'после ремонта']],
  ['price_quote', 'Оценка бота, ₪', 'text'],
  ['deal_sum', 'Согласовано, ₪', 'text'],
  ['paid_sum', 'Оплачено, ₪', 'text'],
  ['paid_at', 'Дата оплаты', 'date'],
  ['stage', 'Стадия', 'select', ['', 'новый', 'уточняем', 'ждём видео', 'заявка готова', 'назвали цену', 'готов к заказу', 'дата согласована', 'отказ']]
];

function leadFormHtml(c) {
  const l = lead(c);
  const val = (k) => (CONV_KEYS.has(k) ? c[k] : l[k]) || '';
  return `<div class="lead"><form class="leadform" data-r="leadform">
    ${EDITABLE.map(([k, t, type, opts]) => `<label class="lf"><span>${t}</span>
      ${type === 'select'
        ? `<select name="${k}">${opts.map((o) => `<option value="${esc(o)}" ${l[k] === o ? 'selected' : ''}>${o || '—'}</option>`).join('')}</select>`
        : `<input name="${k}" type="${type}" dir="auto" value="${esc(val(k))}">`}</label>`).join('')}
    <div class="lf-foot">
      <button type="button" class="btn" data-a="lead-cancel">Отмена</button>
      <button type="submit" class="btn primary">Сохранить</button>
    </div>
  </form></div>`;
}
/** Заявка «остыла»: цену назвали, а клиент молчит больше суток. */
function isCold(c) {
  return lead(c).price_quote && c.status !== 'closed' && !c.needs_human
    && (Date.now() - dt(c.last_at)) > 864e5;
}

/** Следующее действие (ТЗ §4.1): что, кто, срок. Одно на карточку — новое заменяет старое. */
const NEXT_PRESETS = ['Позвонить', 'Отправить предложение', 'Подтвердить дату', 'Получить оплату', 'Проверить фото/видео', 'Написать клиенту'];
function nextHtml(c) {
  if (c.stage === 'closed') return '';
  const ms = state.managers || [];
  // звонок по сроку идёт первым, но заданное менеджером действие тоже видно
  const items = [];
  if (c.call_due_at) items.push({ kind: 'call', what: 'позвонить', at: c.call_due_at, who: mgrName(c.manager_id) });
  if (c.next_action) items.push({ kind: 'task', what: c.next_action, at: c.next_action_at, who: mgrName(c.next_action_mgr || c.manager_id) });
  else if (c.followup_at) items.push({ kind: 'bot', what: c.followup_note || 'бот напишет клиенту', at: c.followup_at, who: 'бот' });
  if (!items.length && c.next) items.push(c.next);
  const botSet = !c.next_action && c.followup_at;
  const whoSel = c.next_action_mgr || c.manager_id;
  const cur = (n) => {
    const when = !n.at ? '' : n.kind === 'task' || n.kind === 'call' ? dayTime(n.at) : esc(n.at);
    const late = (n.kind === 'task' || n.kind === 'call') && n.at && dt(n.at) <= Date.now();
    const own = n.kind === 'task' || (n.kind === 'bot' && c.followup_at);
    return `<div class="na-cur ${late ? 'late' : ''} ${n.kind}"><div><b dir="auto">${esc(n.what)}</b>
        <span>${[when, n.who].filter(Boolean).join(' · ')}${late ? ' · просрочено' : ''}${n.kind === 'call' ? ' · закроется, когда запишете звонок' : ''}</span></div>
        ${own ? `<div class="na-acts"><button class="btn sm" data-a="next-done">Сделано</button>
          <button class="btn ghost sm" data-a="next-clear" title="Убрать">✕</button></div>` : ''}</div>`;
  };
  return `<div class="sect note nextbox"><h4>Следующее действие</h4>
    ${items.length ? items.map(cur).join('')
      : '<div class="na-cur none">Не задано. У каждой заявки в работе должно быть следующее действие.</div>'}
    <form class="na-form" data-r="nextf">
      <input type="text" name="what" list="next-presets" dir="auto" placeholder="что сделать" value="${esc(c.next_action || '')}">
      <datalist id="next-presets">${NEXT_PRESETS.map((t) => `<option value="${t}">`).join('')}</datalist>
      <div class="na-row">
        <select name="who">${ms.map((m) => `<option value="${m.id}" ${!botSet && whoSel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          ${!ms.length ? '<option value="">менеджер</option>' : ''}
          <option value="bot" ${botSet ? 'selected' : ''}>бот напишет клиенту</option></select>
        <input type="date" name="date"><input type="time" name="time" value="10:00">
      </div>
      <div class="fu-quick">
        <button type="button" class="btn ghost sm" data-nq="0">сегодня</button>
        <button type="button" class="btn ghost sm" data-nq="1">завтра</button>
        <button type="button" class="btn ghost sm" data-nq="7">через неделю</button>
        <button type="button" class="btn ghost sm" data-nq="30">через месяц</button>
        <button type="submit" class="btn primary sm">Сохранить</button>
      </div>
    </form></div>`;
}

function bindNext(root, convId) {
  const f = root.querySelector('[data-r="nextf"]');
  const post = async (body, msg) => {
    try {
      await api(`/api/conversations/${convId}/next`, { method: 'POST', body: JSON.stringify(body) });
      toast(msg);
      loadList();
      openConv(convId, drawerOpen);
    } catch (e) { toast(e.message, true); }
  };
  const done = root.querySelector('[data-a="next-done"]');
  if (done) done.onclick = () => post({ done: true }, 'Отмечено. Задайте следующее действие');
  const clr = root.querySelector('[data-a="next-clear"]');
  if (clr) clr.onclick = () => post({ clear: true }, 'Действие убрано');
  if (!f) return;
  const iso = (d) => new Intl.DateTimeFormat('sv-SE').format(d);
  const sync = () => { f.time.hidden = f.who.value === 'bot'; };
  f.who.onchange = sync; sync();
  $$('[data-nq]', f).forEach((b) => b.onclick = () => {
    const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.nq));
    f.date.value = iso(d);
  });
  f.onsubmit = (e) => {
    e.preventDefault();
    if (!f.date.value) return toast('Выберите дату', true);
    const bot = f.who.value === 'bot';
    const at = bot ? f.date.value : new Date(`${f.date.value}T${f.time.value || '10:00'}`).toISOString();
    post({ who: bot ? 'bot' : f.who.value, what: f.what.value, at },
      bot ? 'Бот напишет клиенту ' + f.date.value : 'Действие сохранено');
  };
}

/* Единая история (ТЗ §4.2): что поменялось, кто и когда */
const FIELD_T = { stage: 'Этап', deal_sum: 'Окончательная цена', paid_sum: 'Оплата', paid_at: 'Дата оплаты',
  job_date: 'Дата работ', manager_id: 'Ответственный', call_due_at: 'Срок звонка', next_action: 'Следующее действие',
  needs_human: 'Нужен менеджер', review: 'Пометка «проверить»', call: 'Звонок', source: 'Источник', deleted: 'Удаление',
  recording: 'Запись разговора' };
const LEAD_T = { service: 'Тип уборки', object_type: 'Объект', area_m2: 'Площадь', district: 'Район', address: 'Адрес',
  date: 'Желаемая дата', name: 'Имя', price_quote: 'Оценка', works: 'Что сделать' };
function histValue(field, v) {
  if (v == null || v === '') return '—';
  if (field === 'stage') {
    const [st, cl] = String(v).split(':');
    return cl ? 'Закрыто · ' + colTitle(cl) : colTitle(st) !== st ? colTitle(st) : v;
  }
  if (field === 'needs_human') return v === '1' ? 'да' : 'нет';
  if (field === 'call_due_at' && /^\d{4}-\d{2}-\d{2} /.test(v)) return dayTime(v);
  return v;
}
function timelineHtml(items) {
  if (!items.length) return '<span class="muted">изменений пока не было</span>';
  const when = (s) => dt(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return items.map((it) => {
    let what = '';
    if (it.type === 'change') {
      const f = it.field.startsWith('lead.') ? LEAD_T[it.field.slice(5)] || it.field.slice(5) : FIELD_T[it.field] || it.field;
      what = it.field === 'call' ? `<b>${esc(f)}: ${esc(it.new)}</b>`
        : it.field === 'stage' && it.who === 'перенос' ? `перенос в новую воронку → <b>${esc(histValue('stage', it.new))}</b>`
        : `${esc(f)}: ${esc(histValue(it.field, it.old))} → <b>${esc(histValue(it.field, it.new))}</b>`;
    } else if (it.type === 'call') {
      what = `<b>Звонок: ${esc(it.status)}</b>${it.duration ? ` · ${Math.round(it.duration / 60)} мин` : ''}${it.outcome ? ` — ${esc(it.outcome)}` : ''}`
        + (it.rec_url ? `<audio controls preload="none" src="${esc(it.rec_url)}"></audio>` : it.rec_deleted ? `<em>${esc(it.rec_deleted)}</em>` : '');
    } else if (it.type === 'event') {
      what = esc(it.text);
    } else {
      what = `<span class="hist-msg ${it.dir}" dir="auto">${esc(String(it.text || '').slice(0, 240))}</span>`;
    }
    return `<div class="hist-row ${it.type}"><span class="hist-when">${when(it.at)}</span>
      <span class="hist-what">${what}<small>${esc(it.who || '')}${it.reason ? ' · ' + esc(it.reason) : ''}</small></span></div>`;
  }).join('');
}

/** Предупреждения карточки (ТЗ §7, §8.3): что нарушено и что посмотреть. */
function warnHtml(c) {
  const list = (c.warn || []).filter((w) => w.code !== 'late');
  return list.length ? `<div class="warns">${list.map((w) => `<span class="warn-i ${w.level}">${esc(w.text)}</span>`).join('')}</div>` : '';
}

/** Источник (ТЗ §4.1, §5): цепочка до объявления, статус атрибуции, ссылка в Ads Manager. */
function sourceHtml(c) {
  if (!c.source && !c.attr_status) return '';
  const st = c.attr_status || 'organic';
  const chain = [c.campaign_name, c.adset_name, c.ad_name || c.source_title].filter(Boolean);
  const acc = state.meta_account;
  const am = c.ad_id && acc ? `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${encodeURIComponent(acc)}&selected_ad_ids=${encodeURIComponent(c.ad_id)}` : '';
  return `<div class="kv src"><dt>Источник</dt><dd dir="auto">
      <span>${esc((state.platform_title || {})[c.platform] || c.source || '—')}</span>
      <span class="attr ${st}" title="${esc(c.attr_reason || '')}">${esc((state.attr_title || {})[st] || st)}</span>
      ${chain.length ? `<div class="src-chain">${chain.map(esc).join(' › ')}</div>` : ''}
      ${c.creative_name ? `<div class="src-sub">креатив: ${esc(c.creative_name)}</div>` : ''}
      ${c.ad_id ? `<div class="src-sub">объявление № ${esc(c.ad_id)}${am ? ` · <a href="${esc(am)}" target="_blank" rel="noopener">открыть в Ads Manager</a>` : ''}</div>` : ''}
      ${c.attr_reason && st !== 'exact' ? `<div class="src-sub">${esc(c.attr_reason)}</div>` : ''}
    </dd></div>`;
}

/** Чужая или ничья заявка: менеджер сначала берёт её себе — это видно в журнале. */
function takeHtml(c) {
  const u = me();
  if (u.role !== 'manager' || !u.id || c.manager_id === u.id || c.stage === 'closed') return '';
  const foreign = Boolean(c.manager_id);
  return `<div class="take-note ${foreign ? 'foreign' : ''}"><span>${foreign
    ? `Заявку ведёт <b>${esc(mgrName(c.manager_id) || 'другой менеджер')}</b>. Менять её может он или владелец.`
    : 'У заявки нет ответственного.'}</span><button class="btn sm primary" data-a="take">Взять себе</button></div>`;
}

/** Ответственный и звонки (ТЗ §4.1, §6): первый экран карточки, а не вкладка. */
function callHtml(c) {
  const cs = callState(c);
  const ms = state.managers || [];
  const st = state.call_status || {};
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(10, 0, 0, 0);
  return `${warnHtml(c)}<div class="callbox ${cs || ''}">
    <div class="kv"><dt>Ответственный</dt><dd><select data-r="mgr"><option value="">не назначен</option>${ms.map((m) =>
      `<option value="${m.id}" ${c.manager_id === m.id ? 'selected' : ''}>${esc(m.name)}${m.active ? '' : ' (не принимает)'}</option>`).join('')}
      ${c.manager_id && !ms.some((m) => m.id === c.manager_id) ? '<option selected>удалён</option>' : ''}</select></dd></div>
    ${c.assigned_at ? `<div class="kv"><dt>Передано</dt><dd>${dayTime(c.assigned_at)}</dd></div>` : ''}
    ${cs ? `<div class="kv due"><dt>Позвонить до</dt><dd>${dayTime(c.call_due_at)}${cs === 'late' ? ` <span class="late-tag">просрочено ${lateBy(c.call_due_at)}</span>` : ''}</dd></div>` : ''}
    <div class="call-acts"><button class="btn sm ${cs ? 'primary' : ''}" data-a="call">Записать звонок</button></div>
    <form class="callf" data-r="callf" hidden>
      <div class="cf-row"><label>Итог</label><select name="status">${Object.entries(st).map(([k, t]) =>
        `<option value="${k}">${esc(t)}</option>`).join('')}</select></div>
      <div class="cf-row"><label>Длительность</label><div class="unit"><input type="number" name="duration_min" min="0" max="300" step="1"><span>мин</span></div></div>
      <div class="cf-row"><label>О чём договорились</label><textarea name="outcome" rows="2" dir="auto"></textarea></div>
      <div class="cf-row"><label>Следующий звонок</label><input type="datetime-local" name="next_call_at" data-default="${local(tomorrow)}"></div>
      <div class="cf-row" data-only="answered"><label>Запись разговора</label><input type="file" name="rec" accept=".mp3,.m4a,.wav,.ogg,audio/*"></div>
      <div class="cf-row" data-only="answered"><label>Нет записи, потому что</label><input type="text" name="no_record_reason" placeholder="например, звонил с личного номера"></div>
      <div class="cf-hint" data-r="cfhint"></div>
      <div class="cf-acts"><button type="button" class="btn ghost sm" data-a="callcancel">Отмена</button>
        <button type="submit" class="btn primary sm">Сохранить звонок</button></div>
    </form>
    <div class="calls" data-r="calls"></div>
  </div>`;
}

function callsListHtml(rows) {
  const st = state.call_status || {};
  if (!rows.length) return '<span class="muted">звонков ещё не было</span>';
  return rows.map((k) => `<div class="call-item ${k.status}">
    <div class="call-h"><b>${esc(st[k.status] || k.status)}</b><span>${dayTime(k.at)}${k.manager_name ? ' · ' + esc(k.manager_name) : ''}${
      k.duration_sec ? ' · ' + Math.round(k.duration_sec / 60) + ' мин' : ''}</span></div>
    ${k.outcome ? `<div class="call-o" dir="auto">${esc(k.outcome)}</div>` : ''}
    ${k.next_call_at ? `<div class="call-n">следующий звонок: ${dayTime(k.next_call_at)}</div>` : ''}
    ${k.rec_url ? `<audio controls preload="none" src="${esc(k.rec_url)}"></audio>${isOwner()
        ? `<button class="linkbtn" data-recdel="${k.id}">удалить запись</button>` : ''}`
      : k.rec_deleted_at ? `<div class="call-n">запись удалена · ${esc(k.rec_deleted_by || '')}${isOwner()
        ? ` <button class="linkbtn" data-recback="${k.id}">вернуть</button>` : ''}</div>`
      : k.no_record_reason ? `<div class="call-n">без записи: ${esc(k.no_record_reason)}</div>` : ''}
  </div>`).join('');
}

const REC_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg' };

function bindCalls(root, convId) {
  const take = root.querySelector('[data-a="take"]');
  if (take) take.onclick = async () => {
    try {
      await api(`/api/conversations/${convId}/manager`, { method: 'POST', body: JSON.stringify({ manager_id: me().id }) });
      toast('Заявка ваша');
      loadList();
      openConv(convId, drawerOpen);
    } catch (e) { toast(e.message, true); }
  };
  const mgr = root.querySelector('[data-r="mgr"]');
  if (mgr) mgr.onchange = async () => {
    try {
      await api(`/api/conversations/${convId}/manager`, { method: 'POST', body: JSON.stringify({ manager_id: Number(mgr.value) || null }) });
      toast(mgr.value ? 'Ответственный: ' + mgrName(Number(mgr.value)) : 'Ответственный снят');
      loadList();
    } catch (e) { toast(e.message); }
  };
  const list = root.querySelector('[data-r="calls"]');
  const draw = (rows) => {
    if (!list) return;
    list.innerHTML = callsListHtml(rows);
    $$('[data-recdel]', list).forEach((b) => b.onclick = async () => {
      const reason = prompt('Почему удаляете запись? Файл можно вернуть в течение 30 дней');
      if (!reason) return;
      try {
        await api(`/api/calls/${b.dataset.recdel}/recording`, { method: 'DELETE', body: JSON.stringify({ reason }) });
        toast('Запись удалена');
        api(`/api/conversations/${convId}/calls`).then(draw);
      } catch (e) { toast(e.message, true); }
    });
    $$('[data-recback]', list).forEach((b) => b.onclick = async () => {
      try {
        await api(`/api/calls/${b.dataset.recback}/recording/restore`, { method: 'POST', body: '{}' });
        toast('Запись возвращена');
        api(`/api/conversations/${convId}/calls`).then(draw);
      } catch (e) { toast(e.message, true); }
    });
  };
  if (list) api(`/api/conversations/${convId}/calls`).then(draw).catch(() => {});

  const form = root.querySelector('[data-r="callf"]');
  const btn = root.querySelector('[data-a="call"]');
  if (!form || !btn) return;
  const hint = form.querySelector('[data-r="cfhint"]');
  const sync = () => {
    const v = form.status.value;
    form.querySelectorAll('[data-only]').forEach((x) => { x.hidden = x.dataset.only !== v; });
    const needNext = ['no_answer', 'busy', 'callback'].includes(v);
    if (needNext && !form.next_call_at.value) form.next_call_at.value = form.next_call_at.dataset.default;
    hint.textContent = needNext ? 'Без даты следующего звонка не сохранится — иначе заявка потеряется.'
      : v === 'answered' ? 'Прикрепите запись или напишите, почему её нет.' : '';
  };
  form.status.onchange = sync;
  btn.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) { sync(); form.status.focus(); } };
  root.querySelector('[data-a="callcancel"]').onclick = () => { form.reset(); form.hidden = true; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const save = form.querySelector('[type=submit]');
    save.disabled = true;
    try {
      let recording = null;
      const file = form.status.value === 'answered' ? form.rec.files[0] : null;
      if (file) {
        save.textContent = 'Загружаем запись…';
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const r = await fetch('/api/recordings', { method: 'POST',
          headers: { 'content-type': REC_MIME[ext] || file.type || 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Запись не загрузилась');
        recording = j.file;
      }
      const next = form.next_call_at.value ? new Date(form.next_call_at.value).toISOString() : null;
      const out = await api(`/api/conversations/${convId}/calls`, { method: 'POST', body: JSON.stringify({
        status: form.status.value, duration_min: form.duration_min.value, outcome: form.outcome.value,
        next_call_at: next, recording, no_record_reason: form.status.value === 'answered' ? form.no_record_reason.value : '',
        manager_id: Number(mgr?.value) || null }) });
      toast('Звонок записан');
      draw(out.calls);
      form.reset(); form.hidden = true;
      loadList();
      openConv(convId, drawerOpen);
    } catch (err) {
      toast(err.message);
    } finally {
      save.disabled = false; save.textContent = 'Сохранить звонок';
    }
  };
}

// ТЗ §4.1: без этих полей менеджеру нечего обсуждать по телефону — пропуски видны сразу
const MUST = { district: 'Город / район', object_type: 'Объект', area_m2: 'Площадь, м²', service: 'Тип уборки', date: 'Желаемая дата' };
function gapsHtml(c) {
  if (c.stage === 'closed') return '';
  const l = lead(c);
  const miss = Object.entries(MUST).filter(([k]) => !String(l[k] ?? '').trim()).map(([, t]) => t);
  return miss.length ? `<div class="kv gap"><dt>Не хватает</dt><dd>${miss.map(esc).join(', ')}</dd></div>` : '';
}

function leadHtml(c) {
  const l = lead(c);
  const q = c.quote;
  const rows = Object.entries(LABELS).filter(([k]) => l[k])
    .map(([k, t]) => `<div class="kv"><dt>${t}</dt><dd dir="auto">${esc(l[k])}</dd></div>`).join('');
  const rooms = (l.rooms || []).filter((r) => r.room)
    .map((r) => `<div class="room"><b dir="auto">${esc(r.room)}</b><span dir="auto">${esc(r.notes || '')}</span></div>`).join('');
  const photos = (c.messages || []).flatMap((m) => (m.media ? JSON.parse(m.media) : [])).filter((it) => it.kind !== 'audio');
  const thumbs = photos.map((it) => it.kind === 'video'
    ? `<video src="/media/${esc(it.file)}" preload="metadata"></video>`
    : `<img src="/media/${esc(it.file)}" loading="lazy" alt="">`).join('');
  return `<div class="lead">
    <div class="lead-head"><h4>Заявка</h4><button class="btn ghost sm" data-a="lead-edit">Изменить</button></div>
    <div class="lead-acts">
      <a class="btn" href="tel:+${esc(c.phone)}">${ico('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>')}Позвонить</a>
      <a class="btn" href="https://wa.me/${esc(c.phone)}" target="_blank" rel="noopener">${ico('<path d="M3 21l1.6-4.7A8.5 8.5 0 1 1 8 19.6z"/>')}WhatsApp</a>
    </div>
    ${takeHtml(c)}
    <div class="sect note top"><h4>Заметка менеджера<button class="btn ghost sm" data-a="note-add">+ запись</button></h4>
      <textarea data-r="note" dir="auto" rows="4" placeholder="О чём договорились, что обещали, чем закончилось. Видна только вам">${esc(c.note || '')}</textarea></div>
    ${nextHtml(c)}
    ${c.review ? `<div class="review-note"><b>Проверить после переноса:</b> ${esc(c.review)}
      <button class="btn sm" data-a="reviewed">Проверено</button></div>` : ''}
    <div class="kv"><dt>Этап</dt><dd><select data-r="col">
      <optgroup label="В работе">${COLUMNS.map((x) =>
        `<option value="${x.k}" ${columnOf(c) === x.k ? 'selected' : ''}>${x.t}</option>`).join('')}</optgroup>
      <optgroup label="Закрыто">${ARCHIVE.map((x) =>
        `<option value="${x.k}" ${columnOf(c) === x.k ? 'selected' : ''}>${x.t}</option>`).join('')}</optgroup>
    </select></dd></div>
    ${c.close_reason === 'lost' && c.lost_reason ? `<div class="kv"><dt>Причина</dt><dd dir="auto">${esc(c.lost_reason)}</dd></div>` : ''}
    ${c.status !== 'closed' ? `<div class="kv"><dt>Нужен менеджер</dt><dd>
      <label class="switch"><input type="checkbox" data-r="need" ${c.needs_human ? 'checked' : ''}></label></dd></div>` : ''}
    ${callHtml(c)}
    <div class="kv"><dt>Телефон</dt><dd>+${esc(c.phone)}</dd></div>
    <div class="kv"><dt>Имя</dt><dd dir="auto">${esc(l.name || c.name || '—')}</dd></div>
    <div class="kv"><dt>Записан на</dt><dd>${c.job_date
      ? esc(c.job_date + (c.job_time ? ', ' + c.job_time : '')) + ' <span class="ok-tag">подтверждено</span>'
      : '<span class="muted">не записан — дату подтверждает менеджер</span>'}</dd></div>
    ${sourceHtml(c)}
    ${c.nudges ? `<div class="kv"><dt>Напоминаний</dt><dd>${c.nudges}</dd></div>` : ''}
    ${c.wait_media ? `<div class="kv gap"><dt>Фото/видео</dt><dd>нужны для этого вида уборки — ещё не получены</dd></div>` : ''}
    ${gapsHtml(c)}
    <div class="kv"><dt>Создана</dt><dd>${dt(c.created_at).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}</dd></div>
    ${rows || '<div class="empty" style="padding:24px 0">ИИ ещё не собрал данные</div>'}
    ${q ? `<div class="sect"><h4>Расчёт по прайсу</h4><div class="calc">
        ${q.lines.map((x) => `<div class="l"><span>${esc(x.label)}</span><span>${x.sum.toLocaleString('ru-RU')}</span></div>`).join('')}
        <div class="tot"><span>Итого</span><span>${q.total.toLocaleString('ru-RU')} ${esc(q.currency)}</span></div>
      </div></div>` : ''}
    ${(c.deal_sum || c.paid_sum) ? `<div class="sect"><h4>Деньги</h4><div class="calc">
        ${lead(c).price_quote ? `<div class="l"><span>оценка бота</span><span>${esc(lead(c).price_quote)}</span></div>` : ''}
        ${c.deal_sum ? `<div class="l"><span>согласовано</span><span>${c.deal_sum.toLocaleString('ru-RU')} ₪</span></div>` : ''}
        ${c.paid_sum ? `<div class="tot"><span>оплачено${c.paid_at ? ' · ' + esc(c.paid_at) : ''}</span><span>${c.paid_sum.toLocaleString('ru-RU')} ₪</span></div>` : ''}
      </div></div>` : ''}
    ${thumbs ? `<div class="sect"><h4>Фото от клиента (${photos.length})</h4><div class="thumbs">${thumbs}</div></div>` : ''}
    ${rooms ? `<div class="sect"><h4>Что видно на фото</h4>${rooms}</div>` : ''}
    ${c.summary ? `<div class="sect"><h4>Суть</h4><div class="quote" dir="auto">${esc(c.summary)}</div></div>` : ''}
    <div class="sect"><h4>История<label class="hist-msgs"><input type="checkbox" data-r="hist-msgs"> с перепиской</label></h4>
      <div class="hist" data-r="hist">загружаем…</div></div>
    ${isOwner() ? '<div class="danger-zone"><button class="linkbtn danger" data-a="lead-delete">Удалить заявку</button></div>' : ''}
  </div>`;
}

function bindLead(root, convId) {
  bindCalls(root, convId);
  const col = root.querySelector('[data-r="col"]');
  if (col) col.onchange = async () => {
    if (!(await moveTo(convId, col.value))) col.value = columnOf(convs.find((x) => x.id === convId) || {});
  };
  const need = root.querySelector('[data-r="need"]');
  if (need) need.onchange = async () => {
    await api(`/api/conversations/${convId}/flag`, { method: 'POST', body: JSON.stringify({ needs_human: need.checked }) });
    toast(need.checked ? 'Отмечено: нужен менеджер' : 'Флаг снят');
    loadList();
  };
  const rv = root.querySelector('[data-a="reviewed"]');
  if (rv) rv.onclick = async () => {
    await api(`/api/conversations/${convId}/reviewed`, { method: 'POST', body: '{}' });
    toast('Отмечено как проверенное');
    loadList();
    openConv(convId, drawerOpen);
  };
  const hist = root.querySelector('[data-r="hist"]');
  const histMsgs = root.querySelector('[data-r="hist-msgs"]');
  const loadHist = () => hist && api(`/api/conversations/${convId}/timeline${histMsgs?.checked ? '?messages=1' : ''}`)
    .then((items) => { hist.innerHTML = timelineHtml(items); })
    .catch(() => { hist.textContent = ''; });
  if (histMsgs) histMsgs.onchange = loadHist;
  loadHist();
  const del = root.querySelector('[data-a="lead-delete"]');
  if (del) del.onclick = async () => {
    const reason = prompt('Почему удаляете заявку? Она пропадёт из работы, но останется в журнале — её можно вернуть в Настройки → Журнал');
    if (!reason) return;
    try {
      await api(`/api/conversations/${convId}/delete`, { method: 'POST', body: JSON.stringify({ reason }) });
      toast('Заявка удалена');
      current = null;
      closeDrawer();
      loadList();
      if (page === 'inbox') PAGES.inbox.render();
    } catch (e) { toast(e.message, true); }
  };
  const ta = root.querySelector('[data-r="note"]');
  if (ta) ta.onblur = async () => {
    await api(`/api/conversations/${convId}/note`, { method: 'POST', body: JSON.stringify({ note: ta.value }) });
    toast('Заметка сохранена');
  };
  // заметка — это история разговора, а не одна фраза: новая запись ложится сверху с датой
  const addNote = root.querySelector('[data-a="note-add"]');
  if (addNote) addNote.onclick = () => {
    const d = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    ta.value = `${d} — \n` + (ta.value ? ta.value : '');
    ta.focus();
    ta.setSelectionRange(d.length + 3, d.length + 3);
  };

  bindNext(root, convId);
  $$('img', root).forEach((i) => i.onclick = () => window.open(i.src, '_blank'));

  const edit = root.querySelector('[data-a="lead-edit"]');
  if (edit) edit.onclick = () => {
    root.innerHTML = leadFormHtml(detail);
    bindLead(root, convId);
  };
  const cancel = root.querySelector('[data-a="lead-cancel"]');
  if (cancel) cancel.onclick = () => { root.innerHTML = leadHtml(detail); bindLead(root, convId); };

  const form = root.querySelector('[data-r="leadform"]');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    // источник — атрибуция рекламы: без причины сервер правку не примет
    if ('source' in body && body.source.trim() !== String(detail.source || '')) {
      const why = prompt('Почему меняете источник? Прежнее значение останется в истории');
      if (!why) return;
      body.source_reason = why;
    }
    try {
      detail = { ...detail, ...(await api(`/api/conversations/${convId}/lead`, { method: 'POST', body: JSON.stringify(body) })) };
      detail.messages = detail.messages || [];
      root.innerHTML = leadHtml(detail);
      bindLead(root, convId);
      toast('Заявка обновлена');
      loadList();
    } catch (err) { toast(err.message, true); }
  };
}

async function openConv(id, inDrawer) {
  // сообщения приходят потоком и перерисовывают чат: набранный текст
  // и позицию прокрутки нужно вернуть, иначе печатать невозможно
  const root0 = inDrawer ? $('#drawer-chat') : $('#inbox-chat');
  const draft = root0?.querySelector('[data-r="inp"]')?.value ?? '';
  const keep = root0?.querySelector('[data-r="keep"]')?.checked ?? false;
  const wrap0 = root0?.querySelector('[data-r="wrap"]');
  const atBottom = !wrap0 || wrap0.scrollHeight - wrap0.scrollTop - wrap0.clientHeight < 60;
  const prevTop = wrap0?.scrollTop ?? 0;

  current = id;
  detail = await api('/api/conversations/' + id);
  api('/api/conversations/' + id + '/read', { method: 'POST' }).catch(() => {});
  if (inDrawer) {
    $('#drawer-chat').innerHTML = chatHtml(detail);
    $('#drawer-lead').innerHTML = leadHtml(detail);
    bindChat($('#drawer-chat'));
    bindLead($('#drawer-lead'), id);
    drawerOpen = true;
    $('#m-title').innerHTML = `<b dir="auto">${esc(detail.name || 'Без имени')}</b><span>+${esc(detail.phone)}</span>`;
    $('#drawer').classList.add('on'); $('#scrim').classList.add('on');
  } else if ($('#inbox-chat')) {
    $('#inbox-chat').innerHTML = `<div class="chat">${chatHtml(detail)}</div>`;
    $('#inbox-lead').innerHTML = leadHtml(detail);
    bindChat($('#inbox-chat'));
    bindLead($('#inbox-lead'), id);
    $('#inbox-chat [data-a="card"]')?.addEventListener('click', () => openConv(id, true));
  }
  const root = inDrawer ? $('#drawer-chat') : $('#inbox-chat');
  const inp = root?.querySelector('[data-r="inp"]');
  if (inp && draft) { inp.value = draft; inp.style.height = Math.min(inp.scrollHeight, 140) + 'px'; }
  if (root?.querySelector('[data-r="keep"]')) root.querySelector('[data-r="keep"]').checked = keep;
  const wrap = root?.querySelector('[data-r="wrap"]');
  if (wrap && !atBottom) wrap.scrollTop = prevTop;      // не дёргаем вверх, если человек читает историю

  PAGES[page].render();
}
function closeDrawer() {
  drawerOpen = false;
  showLead(false);
  $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on');
}

/* ───── контроль дня (ТЗ §8) ───── */
let ctrlDate = null;          // null — сегодня по часам компании
let ctrl = null;
let ctrlTab = 'handed';       // handed | flagged

function controlTools() {
  const chev = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return `<div class="seg">
    <button id="ctl-prev" title="Предыдущий день">${chev('m15 18-6-6 6-6')}</button>
    <button id="ctl-today" class="${ctrlDate ? '' : 'on'}">Сегодня</button>
    <button id="ctl-next" title="Следующий день">${chev('m9 18 6-6-6-6')}</button></div>
    <input type="date" id="ctl-date" class="ctl-date" value="${ctrlDate || ''}">`;
}

function bindControlTools() {
  const shift = (n) => {
    const base = ctrlDate || ctrl?.date || new Intl.DateTimeFormat('sv-SE').format(new Date());
    const d = new Date(base + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    ctrlDate = d.toISOString().slice(0, 10);
    go('control');
  };
  $('#ctl-prev') && ($('#ctl-prev').onclick = () => shift(-1));
  $('#ctl-next') && ($('#ctl-next').onclick = () => shift(1));
  $('#ctl-today') && ($('#ctl-today').onclick = () => { ctrlDate = null; go('control'); });
  $('#ctl-date') && ($('#ctl-date').onchange = (e) => { ctrlDate = e.target.value || null; go('control'); });
}

async function renderControl() {
  const el = $('#content');
  if (!$('#ctl')) el.innerHTML = '<div class="ctl" id="ctl"><div class="empty">загружаем…</div></div>';
  bindControlTools();
  try { ctrl = await api('/api/control' + (ctrlDate ? '?date=' + ctrlDate : '')); }
  catch (e) { $('#ctl').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (page !== 'control') return;
  const d = ctrl, k = d.kpi;
  if (!ctrlDate && $('#ctl-date')) $('#ctl-date').value = d.date;
  const day = new Date(d.date + 'T12:00:00Z').toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#pg-sub').textContent = day;

  const tile = (t, parts, tone = '') => `<div class="ctl-k ${tone}"><span>${t}</span><b>${parts}</b></div>`;
  const sep = '<i>/</i>';
  const status = !k.handed
    ? `<div class="ctl-status idle">За этот день менеджерам ничего не передавали.</div>`
    : d.closed
      ? `<div class="ctl-status ok"><b>День закрыт.</b> Каждой переданной заявке звонили, у разговоров есть записи или причины, у заявок в работе есть следующее действие.</div>`
      : `<div class="ctl-status bad"><b>День не закрыт: ${d.exceptions.length} ${plural(d.exceptions.length, 'исключение', 'исключения', 'исключений')}.</b>
          <ul>${d.exceptions.map((x) => `<li><a data-open="${x.id}">${esc(x.who)}</a> — ${esc(x.text)}</li>`).join('')}</ul></div>`;

  const rows = ctrlTab === 'handed' ? d.rows : d.flagged;
  $('#ctl').innerHTML = `${status}
    <div class="ctl-kpis">
      ${tile('Передано менеджерам', k.handed)}
      ${tile('Обзвонено / не обзвонено / с просрочкой', `${k.called}${sep}<em class="${k.not_called ? 'bad' : ''}">${k.not_called}</em>${sep}<em class="${k.late ? 'bad' : ''}">${k.late}</em>`)}
      ${tile('Ответили / нет ответа / повторный звонок', `${k.answered}${sep}${k.no_answer}${sep}${k.repeat}`)}
      ${tile('Предложений / согласовано / оплачено', `${k.offers}${sep}${k.agreed}${sep}${k.paid}`)}
      ${tile('Разговоры без записи и причины', `<em class="${k.norec ? 'bad' : ''}">${k.norec}</em>`)}
    </div>
    <div class="ctl-tabs seg">
      <button data-t="handed" class="${ctrlTab === 'handed' ? 'on' : ''}">Переданы за день · ${d.rows.length}</button>
      <button data-t="flagged" class="${ctrlTab === 'flagged' ? 'on' : ''}">Остальные с красными флагами · ${d.flagged.length}</button>
    </div>
    ${rows.length ? `<div class="ctl-wrap"><table class="ctl-t">
      <thead><tr><th>Клиент</th><th>Менеджер</th><th>Передано</th><th>Срок</th><th>Первый звонок</th><th>SLA</th>
        <th>Источник</th><th>Звонок</th><th>Этап</th><th>Цена</th><th>Дата работ</th><th>Следующее действие</th><th>Предупреждения</th></tr></thead>
      <tbody>${rows.map(ctlRow).join('')}</tbody></table></div>`
      : `<div class="empty">${ctrlTab === 'handed' ? 'Нет заявок, переданных в этот день' : 'Красных флагов нет'}</div>`}`;

  $$('#ctl [data-t]').forEach((b) => b.onclick = () => { ctrlTab = b.dataset.t; renderControl(); });
  $$('#ctl [data-open]').forEach((a) => a.onclick = (e) => {
    if (e.target.closest('audio, a[href]')) return;
    current = Number(a.dataset.open);
    go('inbox');
  });
}

function ctlRow(r) {
  const t = (s) => (s ? dayTime(s) : '—');
  const due = r.due_at ? dt(r.due_at) : null;
  const first = r.first_call_at ? dt(r.first_call_at) : null;
  const late = due && (first ? first > due : due <= Date.now());
  const n = r.next;
  const nWhen = !n?.at ? '' : n.kind === 'task' || n.kind === 'call' ? dayTime(n.at) : esc(n.at);
  return `<tr data-open="${r.id}">
    <td><b dir="auto">${esc(r.name || '+' + r.phone)}</b><small>${r.name ? '+' + esc(r.phone) + ' · ' : ''}${esc(r.lang || '')}${r.service ? ' · ' + esc(r.service) : ''}</small></td>
    <td>${esc(r.manager || '—')}</td>
    <td class="num">${t(r.assigned_at)}</td>
    <td class="num ${late ? 'bad' : ''}">${t(r.due_at)}</td>
    <td class="num">${first ? t(r.first_call_at) : '<span class="bad">нет</span>'}</td>
    <td class="num ${late ? 'bad' : ''}">${r.sla_min != null ? r.sla_min + ' мин' : '—'}</td>
    <td>${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source || 'реклама')}</a>` : esc(r.source || '—')}${r.campaign ? `<small dir="auto">${esc(r.campaign)}</small>` : ''}</td>
    <td>${esc(r.call_status || '—')}${r.calls > 1 ? `<small>попыток: ${r.calls}</small>` : ''}${r.rec_url
      ? `<audio controls preload="none" src="${esc(r.rec_url)}"></audio>` : ''}</td>
    <td>${esc(r.stage)}</td>
    <td class="num">${r.price ? r.price.toLocaleString('ru-RU') + ' ₪' + (r.price_final ? '' : '<small>оценка бота</small>') : '—'}</td>
    <td class="num">${esc(r.job_date || '—')}</td>
    <td>${n ? `${esc(n.what)}<small>${[nWhen, n.who].filter(Boolean).join(' · ')}</small>` : '<span class="bad">нет</span>'}</td>
    <td>${(r.warn || []).map((w) => `<span class="warn-i ${w.level}">${esc(w.text)}</span>`).join('') || '<span class="ok-tag">в порядке</span>'}</td>
  </tr>`;
}

/* ───── отчёт по рекламе и продажам (ТЗ §9) ───── */
let rep = null;
const repQ = { days: 30, from: '', to: '', group: 'ad' };
const REP_COLS = [
  ['leads', 'Заявки'], ['qualified', 'Квалиф.'], ['called', 'Обзвонено'], ['answered', 'Дозвонились'],
  ['quoted', 'Предложение'], ['agreed', 'Согласовано'], ['paid', 'Оплачено']
];
const REP_DEF = {
  leads: 'Уникальные заявки, созданные за период',
  qualified: 'Не отсеяна как обычная уборка или сотрудник, известны город, объект и площадь',
  called: 'Есть хотя бы одна попытка звонка',
  answered: 'Есть разговор с клиентом',
  quoted: 'Менеджер сохранил окончательную цену',
  agreed: 'Клиент подтвердил цену и дату',
  paid: 'Внесена оплата'
};
const fmtMoney = (v, cur = '₪') => (v == null ? '—' : `${Math.round(v).toLocaleString('ru-RU')} ${cur === 'ILS' ? '₪' : cur}`);

function reportTools() {
  return `<div class="seg" id="rep-days">${[[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [0, 'период']]
    .map(([d, t]) => `<button data-d="${d}" class="${repQ.days === d ? 'on' : ''}">${t}</button>`).join('')}</div>
    <span class="rep-range" ${repQ.days ? 'hidden' : ''}><input type="date" id="rep-from" value="${repQ.from}">–<input type="date" id="rep-to" value="${repQ.to}"></span>`;
}

function bindReportTools() {
  $$('#rep-days button').forEach((b) => b.onclick = () => {
    repQ.days = Number(b.dataset.d);
    if (!repQ.days && !repQ.from) {
      const t = new Date(); repQ.to = new Intl.DateTimeFormat('sv-SE').format(t);
      t.setDate(t.getDate() - 29); repQ.from = new Intl.DateTimeFormat('sv-SE').format(t);
    }
    go('report');
  });
  $('#rep-from') && ($('#rep-from').onchange = (e) => { repQ.from = e.target.value; renderReport(); });
  $('#rep-to') && ($('#rep-to').onchange = (e) => { repQ.to = e.target.value; renderReport(); });
}

async function renderReport() {
  if (!$('#rep')) $('#content').innerHTML = '<div class="rep" id="rep"><div class="empty">считаем…</div></div>';
  bindReportTools();
  const p = new URLSearchParams();
  if (repQ.days) {
    const t = new Date(); p.set('to', new Intl.DateTimeFormat('sv-SE').format(t));
    t.setDate(t.getDate() - (repQ.days - 1)); p.set('from', new Intl.DateTimeFormat('sv-SE').format(t));
  } else { if (repQ.from) p.set('from', repQ.from); if (repQ.to) p.set('to', repQ.to); }
  p.set('group', repQ.group);
  for (const k of ['campaign', 'adset', 'ad', 'platform', 'attr', 'manager', 'lang', 'service', 'city']) if (repQ[k]) p.set(k, repQ[k]);
  try { rep = await api('/api/report?' + p); } catch (e) { $('#rep').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (page !== 'report') return;
  const r = rep, t = r.totals, cur = r.currency;
  const d1 = new Date(r.from + 'T12:00:00Z'), d2 = new Date(r.to + 'T12:00:00Z');
  const f = (d) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  $('#pg-sub').textContent = `${f(d1)} — ${f(d2)}`;

  const filt = Object.entries(r.dims).map(([k, title]) => {
    const opts = r.options[k] || [];
    if (!opts.length && !repQ[k]) return '';
    return `<label class="rep-f ${repQ[k] ? 'on' : ''}"><span>${esc(title)}</span><select data-f="${k}"><option value="">все</option>${
      opts.map((o) => `<option value="${esc(o.value)}" ${repQ[k] === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  }).join('');
  const num = (ids, v, cls = '') => `<button class="rep-n ${cls}" data-ids="${ids.join(',')}" ${ids.length ? '' : 'disabled'}>${v}</button>`;
  const tile = (k, title) => `<div class="rep-k" title="${esc(REP_DEF[k])}"><span>${title}</span>${num(t.ids[k], t[k])}
    ${k !== 'leads' && t.leads ? `<small>${Math.round(t[k] / t.leads * 100)}%</small>` : '<small>&nbsp;</small>'}</div>`;
  const money = (title, v, hint = '') => `<div class="rep-k money" title="${esc(hint)}"><span>${title}</span><b>${v}</b><small>${esc(hint) || '&nbsp;'}</small></div>`;

  $('#rep').innerHTML = `
    <div class="rep-filters">${filt}${Object.keys(r.dims).some((k) => repQ[k]) ? '<button class="btn ghost sm" id="rep-clear">Сбросить фильтры</button>' : ''}</div>
    <div class="rep-kpis">${REP_COLS.map(([k, tt]) => tile(k, tt)).join('')}</div>
    <div class="rep-kpis money">
      ${money('Выручка', fmtMoney(t.revenue, '₪'), t.revenue && t.revenue_net !== t.revenue ? `без НДС ${fmtMoney(t.revenue_net, '₪')}` : '')}
      ${money('Расход на рекламу', fmtMoney(t.spend, cur), t.spend == null ? 'не делится по этому фильтру' : !t.spend ? 'нет данных о расходе' : '')}
      ${money('CPL · цена заявки', fmtMoney(t.cpl, cur))}
      ${money('CAC · цена клиента', fmtMoney(t.cac, cur))}
      ${money('ROAS', t.roas == null ? '—' : t.roas.toLocaleString('ru-RU') + '×', 'выручка на 1 ₪ рекламы')}
    </div>
    ${[r.spend_note, r.vat_note].filter(Boolean).map((n) => `<div class="rep-note">${esc(n)}</div>`).join('')}
    <div class="rep-head"><h3>Разбивка</h3><div class="seg" id="rep-group">${Object.entries(r.dims).map(([k, tt]) =>
      `<button data-g="${k}" class="${r.group === k ? 'on' : ''}">${esc(tt)}</button>`).join('')}</div></div>
    ${r.breakdown.length ? `<div class="ctl-wrap"><table class="ctl-t rep-t"><thead><tr><th>${esc(r.group_title)}</th>
      ${REP_COLS.map(([, tt]) => `<th class="num">${tt}</th>`).join('')}<th class="num">Выручка</th><th class="num">Расход</th>
      <th class="num">CPL</th><th class="num">CAC</th><th class="num">ROAS</th></tr></thead>
      <tbody>${r.breakdown.map((b) => `<tr><td dir="auto"><b>${esc(b.label)}</b>${b.key && b.key !== b.label && /^\\d{6,}$/.test(b.key) ? `<small>№ ${esc(b.key)}</small>` : ''}</td>
        ${REP_COLS.map(([k]) => `<td class="num">${num(b.ids[k], b[k], 'sm')}</td>`).join('')}
        <td class="num">${b.revenue ? fmtMoney(b.revenue, '₪') : '—'}</td><td class="num">${fmtMoney(b.spend, cur)}</td>
        <td class="num">${fmtMoney(b.cpl, cur)}</td><td class="num">${fmtMoney(b.cac, cur)}</td>
        <td class="num">${b.roas == null ? '—' : b.roas.toLocaleString('ru-RU') + '×'}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">За период заявок нет</div>'}
    <div class="rep-list" id="rep-list" hidden></div>`;

  $$('#rep [data-f]').forEach((s) => s.onchange = () => { repQ[s.dataset.f] = s.value; renderReport(); });
  $('#rep-clear') && ($('#rep-clear').onclick = () => { for (const k of Object.keys(r.dims)) repQ[k] = ''; renderReport(); });
  $$('#rep-group button').forEach((b) => b.onclick = () => { repQ.group = b.dataset.g; renderReport(); });
  $$('#rep .rep-n').forEach((b) => b.onclick = () => showRepList(b.dataset.ids.split(',').filter(Boolean), b));
}

/** Из чего сложилось число: те самые заявки, клик открывает карточку. */
async function showRepList(ids, btn) {
  const box = $('#rep-list');
  if (!ids.length) return;
  $$('#rep .rep-n.on').forEach((x) => x.classList.remove('on'));
  btn.classList.add('on');
  box.hidden = false;
  box.innerHTML = '<div class="empty">загружаем…</div>';
  const rows = await api('/api/report/leads', { method: 'POST', body: JSON.stringify({ ids }) });
  const stage = (c) => (c.stage === 'closed' ? 'Закрыто · ' + colTitle(c.close_reason) : colTitle(c.stage));
  box.innerHTML = `<div class="rep-list-h"><b>${rows.length} ${plural(rows.length, 'заявка', 'заявки', 'заявок')}</b>
      <button class="btn ghost sm" id="rep-list-x">Скрыть</button></div>
    <table class="log-t"><tbody>${rows.map((c) => `<tr data-conv="${c.id}"><td class="num">${dt(c.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</td>
      <td dir="auto"><b>${esc(c.lead_name || c.name || '+' + c.phone)}</b><small>+${esc(c.phone)}</small></td>
      <td>${esc(stage(c))}</td><td>${esc([c.service, c.city].filter(Boolean).join(' · '))}</td>
      <td dir="auto">${esc(c.ad_name || c.campaign_name || '')}</td>
      <td class="num">${c.paid_sum ? fmtMoney(c.paid_sum) : c.deal_sum ? fmtMoney(c.deal_sum) + '<small>предложение</small>' : ''}</td></tr>`).join('')}</tbody></table>`;
  $('#rep-list-x').onclick = () => { box.hidden = true; btn.classList.remove('on'); };
  $$('tr[data-conv]', box).forEach((tr) => tr.onclick = () => { current = Number(tr.dataset.conv); go('inbox'); });
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ───── настройки ───── */
const SET_SECTIONS = [
  { k:'company', t:'Компания', d:'название и часовой пояс',
    i:'<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-5h6v5M9.5 10h.01M14.5 10h.01"/>' },
  { k:'prices', t:'Услуги и цены', d:'прайс и условия',
    i:'<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>' },
  { k:'bot', t:'Бот', d:'приветствие, пауза, промпт',
    i:'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>' },
  { k:'replies', t:'Заготовки ответов', d:'фразы для менеджера',
    i:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>' },
  { k:'hours', t:'Расписание', d:'часы, выходные, праздники',
    i:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { k:'access', t:'Доступ', d:'чёрный список, уведомления',
    i:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>' },
  { k:'team', t:'Менеджеры', d:'кто звонит и в какой срок',
    i:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.6 3 5.2"/>' },
  { k:'ads', t:'Реклама', d:'кампании и метки',
    i:'<path d="M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>' },
  { k:'logs', t:'Журнал', d:'изменения, входы, сбои',
    i:'<path d="M8 4h11a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8"/><path d="M4 4h4v16H4z"/><path d="M12 9h5M12 13h5M12 17h3"/>' },
  { k:'data', t:'Данные', d:'сброс перед рекламой',
    i:'<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>' },
  { k:'conn', t:'Подключения', d:'WhatsApp, модель, QR',
    i:'<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>' }
];
let setSection = 'company';
let logTab = 'audit';

const ACCESS_T = { login: 'вход', login_failed: 'неудачный вход', logout: 'выход', recording_listen: 'прослушал запись',
  recording_delete: 'удалил запись', recording_restore: 'вернул запись', lead_delete: 'удалил заявку', lead_restore: 'вернул заявку',
  backup_export: 'скачал резервную копию', data_reset: 'стёр данные', password_set: 'задал пароль' };
const KIND_T = { notify: 'уведомление команде', whatsapp: 'сообщение клиенту', ai: 'модель ИИ', stt: 'расшифровка голоса' };
const STATUS_T = { retry: 'повторяем', done: 'доставлено повторно', failed: 'не удалось' };

async function loadMetaBox() {
  const box = $('#f-meta');
  try {
    const m = await api('/api/meta/status');
    const when = (s) => (s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
    box.innerHTML = `<div class="meta-st ${m.configured ? (m.last_error ? 'bad' : 'ok') : 'off'}">
        <b>${m.configured ? (m.last_error ? 'Ошибка обмена с Meta' : 'Подключено') : !m.has_token ? 'Не подключено: на сервере нет токена' : 'Не подключено: укажите рекламный аккаунт'}</b>
        <span>${m.configured ? `последняя загрузка: ${when(m.last_sync)} · объявлений в справочнике: ${m.ads_known} · дней с расходом: ${m.spend_days}` : 'Пока без доступа: в отчёте объявления видны по заголовку, расход можно внести вручную ниже.'}</span>
        ${m.last_error ? `<span class="err">${esc(m.last_error)}</span>` : ''}
      </div>${m.configured ? '<button class="btn sm" id="f-metasync">Загрузить сейчас</button>' : ''}`;
    $('#f-metasync') && ($('#f-metasync').onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Загружаем…';
      try { const r = await api('/api/meta/sync', { method: 'POST', body: '{}' }); toast(`Загружено строк расхода: ${r.rows ?? 0}`); }
      catch (err) { toast(err.message, true); }
      loadMetaBox();
    });
  } catch (e) { box.textContent = e.message; }
}

async function loadSpendBox() {
  const box = $('#f-spend');
  const rows = await api('/api/spend').catch(() => []);
  const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
  box.innerHTML = `<div class="spend-add"><input type="date" id="sp-date" value="${today}">
      <input type="text" id="sp-camp" placeholder="кампания" list="sp-camps"><datalist id="sp-camps">${[...new Set(rows.map((r) => r.campaign_name))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="unit"><input type="number" id="sp-sum" min="0" step="0.01" placeholder="0"><span>₪</span></div>
      <button class="btn sm" id="sp-add">Добавить</button></div>
    ${rows.length ? `<table class="log-t"><tbody>${rows.map((r) => `<tr><td class="num">${esc(r.date)}</td><td dir="auto">${esc(r.campaign_name)}</td>
      <td class="num">${fmtMoney(r.spend)}</td><td class="muted">${esc(r.created_by || '')}</td>
      <td><button class="linkbtn" data-spdel="${r.id}">удалить</button></td></tr>`).join('')}</tbody></table>` : ''}`;
  $('#sp-add').onclick = async () => {
    try {
      await api('/api/spend', { method: 'POST', body: JSON.stringify({ date: $('#sp-date').value, campaign_name: $('#sp-camp').value, amount: $('#sp-sum').value }) });
      toast('Расход добавлен'); loadSpendBox();
    } catch (e) { toast(e.message, true); }
  };
  $$('[data-spdel]', box).forEach((b) => b.onclick = async () => {
    try { await api(`/api/spend/${b.dataset.spdel}`, { method: 'DELETE' }); loadSpendBox(); } catch (e) { toast(e.message, true); }
  });
  // поля расхода не относятся к общей кнопке «Сохранить»
  box.addEventListener('input', (e) => e.stopPropagation());
}

async function loadLogs(q = '') {
  const box = $('#f-logs');
  if (!box) return;
  const when = (s) => dt(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const who = (name, phone) => esc(name || (phone ? '+' + phone : ''));
  try {
    if (logTab === 'audit') {
      const rows = await api('/api/logs/audit' + (q ? '?q=' + encodeURIComponent(q) : ''));
      box.innerHTML = rows.length ? `<table class="log-t"><tbody>${rows.map((a) => {
        const f = a.field.startsWith('lead.') ? LEAD_T[a.field.slice(5)] || a.field.slice(5) : FIELD_T[a.field] || a.field;
        return `<tr data-conv="${a.entity === 'lead' ? a.entity_id : ''}"><td class="num">${when(a.at)}</td><td>${esc(a.actor)}</td>
          <td>${a.entity === 'lead' ? who(a.conv_name, a.conv_phone) || '#' + a.entity_id : 'менеджер #' + a.entity_id}</td>
          <td>${esc(f)}: ${esc(histValue(a.field, a.old_value))} → <b>${esc(histValue(a.field, a.new_value))}</b>${a.reason ? `<small>${esc(a.reason)}</small>` : ''}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="empty">Ничего не найдено</div>';
      $$('tr[data-conv]', box).forEach((tr) => tr.dataset.conv && (tr.onclick = () => { current = Number(tr.dataset.conv); go('inbox'); }));
    } else if (logTab === 'access') {
      const rows = await api('/api/logs/access');
      box.innerHTML = rows.length ? `<table class="log-t"><tbody>${rows.map((a) => `<tr class="${a.action === 'login_failed' ? 'bad' : ''}">
        <td class="num">${when(a.at)}</td><td>${esc(a.user_name || '—')}</td><td>${esc(ACCESS_T[a.action] || a.action)}</td>
        <td>${a.object === 'call' ? 'звонок #' + a.object_id : a.object === 'lead' ? 'заявка #' + a.object_id : ''}${a.detail ? ` <small>${esc(a.detail)}</small>` : ''}</td>
        <td class="num muted">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Записей нет</div>';
    } else if (logTab === 'failures') {
      const rows = await api('/api/logs/failures');
      box.innerHTML = rows.length ? `<table class="log-t"><tbody>${rows.map((a) => `<tr class="${a.status === 'failed' ? 'bad' : ''}">
        <td class="num">${when(a.at)}</td><td>${esc(KIND_T[a.kind] || a.kind)}${a.target ? `<small>+${esc(a.target)}</small>` : ''}</td>
        <td>${a.conv_id ? who(a.conv_name, a.conv_phone) : ''}</td><td>${esc(a.error)}<small>попыток: ${a.attempts}</small></td>
        <td>${esc(STATUS_T[a.status] || a.status)}${a.kind === 'notify' && a.status === 'failed' ? ` <button class="btn ghost sm" data-retry="${a.id}">Повторить</button>` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Сбоев не было</div>';
      $$('[data-retry]', box).forEach((b) => b.onclick = async () => {
        try { await api(`/api/logs/failures/${b.dataset.retry}/retry`, { method: 'POST', body: '{}' }); toast('Повторим в течение минуты'); loadLogs(); }
        catch (e) { toast(e.message, true); }
      });
    } else {
      const rows = await api('/api/conversations/deleted');
      box.innerHTML = rows.length ? `<table class="log-t"><tbody>${rows.map((c) => `<tr>
        <td class="num">${when(c.deleted_at)}</td><td>${who(lead(c).name || c.name, c.phone)}</td><td>${esc(c.deleted_by || '')}</td>
        <td>${esc(c.delete_reason || '')}</td><td><button class="btn ghost sm" data-restore="${c.id}">Вернуть</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Удалённых заявок нет</div>';
      $$('[data-restore]', box).forEach((b) => b.onclick = async () => {
        try { await api(`/api/conversations/${b.dataset.restore}/restore`, { method: 'POST', body: '{}' }); toast('Заявка возвращена'); loadList(); loadLogs(); }
        catch (e) { toast(e.message, true); }
      });
    }
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
let setDirtyFlag = false;
const DAY_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const OFF_MODES = [
  ['always', 'Отвечать как обычно', 'бот ведёт диалог, будто менеджер на месте'],
  ['notice', 'Отвечать и предупреждать', 'бот отвечает и говорит, что заказ подтвердят в рабочие часы'],
  ['silent', 'Молчать', 'заявка ждёт менеджера до начала рабочего дня']
];
const TZ = ['Asia/Jerusalem', 'Europe/Kyiv', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/Moscow', 'UTC'];

/* разметка настроек: группа — карточка, строка — подпись слева, поле справа */
const grp = (title, desc, body) => `<section class="sgroup">
  ${title ? `<div class="sg-h"><h3>${title}</h3>${desc ? `<p>${desc}</p>` : ''}</div>` : ''}<div class="sg-b">${body}</div></section>`;
const srow = (label, help, control) => `<div class="srow"><div class="sl"><label>${label}</label>${help ? `<p>${help}</p>` : ''}</div>
  <div class="sc">${control}</div></div>`;
const swide = (control) => `<div class="srow wide"><div class="sc">${control}</div></div>`;
const unit = (id, val, suffix, min, max) =>
  `<div class="unit"><input type="number" id="${id}" min="${min}" max="${max}" value="${esc(String(val))}"><span>${suffix}</span></div>`;

const mgrRow = (m) => `<div class="mgr-row" data-id="${m.id || ''}">
  <input type="text" class="m-name" value="${esc(m.name || '')}" placeholder="Имя">
  <input type="tel" class="m-phone mono" value="${m.phone ? '+' + esc(m.phone) : ''}" placeholder="+972 50 123 4567">
  <input type="text" class="m-login mono" value="${esc(m.login || '')}" placeholder="логин" autocapitalize="none" spellcheck="false">
  <input type="password" class="m-pass" placeholder="${m.can_login ? 'новый пароль' : 'задать пароль'}" autocomplete="new-password">
  <select class="m-role"><option value="manager" ${m.role !== 'owner' ? 'selected' : ''}>менеджер</option>
    <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>владелец</option></select>
  <label class="switch" title="принимает заявки"><input type="checkbox" class="m-active" ${m.active === 0 ? '' : 'checked'}><span>принимает заявки</span></label>
  <button class="btn ghost sm m-del" title="Удалить">✕</button>
  <small class="m-seen">${m.can_login ? `вход есть${m.last_login_at ? ' · последний ' + dayTime(m.last_login_at) : ' · ещё не входил'}` : m.id ? 'входа нет: задайте логин и пароль' : ''}</small></div>`;
let mgrGone = new Set();

function setDirty(v) {
  setDirtyFlag = v;
  $('#save-bar')?.classList.toggle('on', v);
}

function renderSettings() {
  if (!isOwner()) {
    $('#pg-sub').textContent = '';
    $('#content').innerHTML = '<div class="empty" style="padding:60px 20px">Настройки доступны владельцу</div>';
    return;
  }
  $('#pg-sub').textContent = 'применяются сразу, без перезапуска';
  const s = state;
  const cur = SET_SECTIONS.find((x) => x.k === setSection);
  const off = s.off_hours || 'always';
  const quick = getSettingList('quick_replies').length;

  const sec = {
    company: {
      lead: 'Название видно в боковом меню. Город, зона выезда и условия — на вкладке «Услуги и цены»: их читает бот.',
      body: grp('', '',
        srow('Название компании', 'Показывается в меню админки.',
          `<input type="text" id="f-company" value="${esc(s.company || '')}" placeholder="Клининг">`)
        + srow('Часовой пояс', 'По нему считаются рабочие часы и «сегодня» в расписании.',
          `<input type="text" id="f-tz" list="tz-list" value="${esc(s.timezone || '')}" placeholder="Asia/Jerusalem">
           <datalist id="tz-list">${TZ.map((t) => `<option value="${t}">`).join('')}</datalist>`))
    },
    prices: {
      lead: 'Цену по этой таблице считает код, а не модель: арифметика в языковой модели ненадёжна, а цена — это деньги. Бот получает готовую сумму и называет её.',
      body: grp('Прайс', 'Ставка за квадратный метр и минимальный заказ. Строки без названия или ставки не сохраняются.',
          swide(`<div class="ptable"><div class="phead"><span>Услуга</span><span class="r">₪ за м²</span><span class="r">Минимум, ₪</span><span></span></div>
            <div id="f-prices"></div></div>
            <div class="pfoot"><button class="btn sm" id="f-addrow">+ Добавить услугу</button><span class="pex" id="f-pex"></span></div>`))
        + grp('Условия и оговорки', 'Зона выезда, что входит в цену, оплата, гарантии — всё, что не ложится в таблицу. Бот опирается только на это и на прайс.',
          swide(`<textarea id="f-facts" dir="auto" rows="11">${esc(s.business_facts || '')}</textarea>`))
    },
    bot: {
      lead: 'Как бот здоровается, как разговаривает и как быстро отвечает.',
      body: grp('Приветствие', 'Первое сообщение в каждом новом диалоге. По строке на язык в формате <code>uk: текст</code> — нужная выбирается по языку клиента, <code>{company}</code> заменится названием компании. Сказать, что отвечает ИИ, требуют правила WhatsApp и Anthropic — хотя бы в начале диалога.',
          swide(`<textarea id="f-greeting" dir="auto" rows="5">${esc(s.greeting || '')}</textarea>`))
        + grp('', '', srow('Пауза перед ответом', 'Бот ждёт, пока клиент допишет очередь сообщений, и отвечает один раз на всю пачку.',
          unit('f-delay', Math.round((Number(s.reply_delay) || 4000) / 1000), 'секунд', 1, 60)))
        + grp('Напоминания и дожим', 'Бот сам пишет первым в двух случаях: наступил день, о котором договорился с клиентом («напишите после ремонта»), или клиент замолчал после названной цены. Пишет только в рабочие часы.',
          srow('Дожимать молчунов', 'Выключите — останутся только напоминания по договорённости с клиентом.',
            `<label class="switch"><input type="checkbox" id="f-nudgeon" ${s.nudge_on ? 'checked' : ''}></label>`)
          + srow('Первое напоминание', 'Через сколько часов тишины после последнего сообщения бота.',
            unit('f-nudgeh', s.nudge_hours ?? 20, 'часов', 1, 240))
          + srow('Второе напоминание', 'Через сколько часов после первого.',
            unit('f-nudgerep', s.nudge_repeat_hours ?? 72, 'часов', 1, 720))
          + srow('Сколько раз максимум', 'Дальше бот молчит: клиент либо ответит, либо заявка закроется сама.',
            unit('f-nudgemax', s.nudge_max ?? 2, 'раза', 0, 5))
          + srow('Не напоминать, если молчит дольше', 'Старые диалоги не трогаем: писать через месяц тишины — это спам, а не дожим.',
            unit('f-nudgestale', s.nudge_stale_hours ?? 336, 'часов', 24, 2000))
          + srow('Ритм, когда вопрос без ответа', 'Часы от последнего сообщения бота, через запятую. Вопрос остывает быстро, поэтому первое напоминание — в тот же день.',
            `<input type="text" id="f-stepsask" value="${esc(s.nudge_steps_ask || '3,24,72')}">`)
          + srow('Ритм, когда цена названа', '«Подумаю» живёт дольше: день, три дня, неделя.',
            `<input type="text" id="f-stepsquoted" value="${esc(s.nudge_steps_quoted || '24,72,168')}">`)
          + srow('Стоп-слова', 'Если клиент так написал, бот навсегда перестаёт напоминать ему. По одному на строку.',
            `<textarea id="f-stopwords" class="mono" rows="4">${esc(s.stop_words || '')}</textarea>`))
        + grp('Подтверждение заказа', 'Накануне вечером и утром в день уборки бот напомнит клиенту о визите — меньше сорванных выездов. Если диалог ведёт менеджер, напоминание придёт ему, а не клиенту.',
          srow('Подтверждать заказы', '', `<label class="switch"><input type="checkbox" id="f-confirmon" ${s.confirm_on ? 'checked' : ''}></label>`)
          + srow('Накануне, в котором часу', '', unit('f-confirmeve', s.confirm_eve_hour ?? 18, 'часов', 8, 22))
          + srow('В день уборки, в котором часу', '', unit('f-confirmmorning', s.confirm_morning_hour ?? 8, 'часов', 6, 12))
          + srow('Напомнить менеджеру о тихом диалоге', 'Диалоги, которые ведёт человек, бот не дожимает — вместо этого пишет менеджеру.',
            unit('f-mgrping', s.manager_ping_hours ?? 48, 'часов', 2, 336)))
        + grp('Фото и видео', 'Для каких видов уборки материал обязателен. Пока клиент не прислал ни фото, ни видео, заявка помечается «Ждём фото/видео».',
          MEDIA_SERVICES.map((v, i) => srow(v, '', `<label class="switch"><input type="checkbox" class="f-media" data-v="${esc(v)}" ${
            String(s.media_required || '').split(',').map((x) => x.trim()).includes(v) ? 'checked' : ''}></label>`)).join(''))
        + grp('Промпт', 'Роль, стиль речи, что собирать по заявке, когда звать человека. Цены сюда не вписывайте — они в прайсе.',
          swide(`<textarea id="f-prompt" class="mono" dir="auto" rows="16">${esc(s.system_prompt || '')}</textarea>`))
    },
    replies: {
      lead: 'Готовые фразы для менеджера. В чате — кнопка «Шаблоны» или клавиша «/» в пустом поле ответа.',
      body: grp('Заготовки', `${quick} ${plural(quick, 'заготовка', 'заготовки', 'заготовок')} · по строке на каждую`,
        swide(`<textarea id="f-quick" dir="auto" rows="12">${esc(s.quick_replies || '')}</textarea>`))
    },
    hours: {
      lead: `Бот работает круглосуточно, живой менеджер — нет. Этот график бот называет клиентам.
        <span class="nowpill ${s.working_now ? 'ok' : 'bad'}"><i></i>${s.working_now ? 'сейчас рабочее время' : 'сейчас нерабочее время'}</span>`,
      body: grp('Часы по дням', 'Выключите день — он станет выходным. Пятница в Израиле обычно короткая, поэтому часы задаются для каждого дня.',
          '<div class="hours" id="f-hours"></div>')
        + grp('Праздники и разовые выходные', 'По строке на дату. В эти дни бот не назначает уборку, даже если по графику день рабочий.',
          swide(`<textarea id="f-holidays" class="mono" rows="5" placeholder="2026-09-23 Рош ха-Шана">${esc(s.holidays || '')}</textarea>`))
        + grp('Нерабочее время', '',
          srow('Что делает бот', 'Когда менеджера нет на месте.',
            `<input type="hidden" id="f-off" value="${off}"><div class="opts">${OFF_MODES.map(([v, t, d]) =>
              `<button type="button" class="opt ${off === v ? 'on' : ''}" data-v="${v}"><span class="rd"></span><span><b>${t}</b><small>${d}</small></span></button>`).join('')}</div>`)
          + srow('Текст предупреждения', 'Бот вставит эту мысль в ответ своими словами и на языке клиента.',
            `<input type="text" id="f-offnote" value="${esc(s.off_hours_note || '')}">`))
        + grp('Очередь и автозакрытие', '',
          srow('Предел очереди «Нужен человек»', 'Больше — колонка на доске подсветится. 0 — не следить.',
            unit('f-wip', s.wip_need ?? 5, 'заявок', 0, 50))
          + srow('Закрывать без движения', 'Заявки, где никто не писал столько дней, закрываются сами. 0 — не закрывать.',
            unit('f-autoclose', s.autoclose_days || 0, 'дней', 0, 365)))
    },
    access: {
      lead: 'Кому бот отвечает автоматически и как админка зовёт менеджера.',
      body: grp('', '',
        srow('Чёрный список', 'Номера, которым бот не отвечает и которые не попадают в заявки: личные контакты, сотрудники, спам. По одному на строку или через запятую, в любом формате — «050-123-4567» или «+972 50 123 4567». Всем остальным бот отвечает.',
          `<textarea id="f-blocked" class="mono" rows="4" placeholder="+972 50 123 4567">${esc(s.blocked_numbers || '')}</textarea>`)
        + srow('Уведомления в браузере', 'Всплывающее уведомление, когда бот передаёт диалог человеку.',
          `<button class="btn" id="f-notify">${notifyReady() ? 'Уведомления включены'
            : hasNotifications() ? 'Включить уведомления' : 'Браузер не поддерживает'}</button>`))
      + grp('Уведомления менеджеру в WhatsApp', 'Когда бот передаёт заявку человеку, ответственному менеджеру придёт сообщение: кто написал, что за объект, причина и до какого времени позвонить. Список менеджеров и их номера — на вкладке «Менеджеры».',
        srow('Слать уведомления', 'Можно временно выключить, не стирая номера.',
          `<label class="switch"><input type="checkbox" id="f-notifyon" ${s.notify_on ? 'checked' : ''}></label>`)
        + srow('Адрес админки', 'Для ссылки на диалог в уведомлении. На Render подставляется сам.',
          `<input type="text" id="f-adminurl" value="${esc(s.admin_url || '')}" placeholder="https://clining-ai.onrender.com">`))
    },
    team: {
      lead: 'Заявку, которую бот передал человеку, получает менеджер из этого списка — тот, у кого сейчас меньше ждущих звонка. Ему же уходят уведомления. Владельцу приходят просрочки и вечерний отчёт.',
      body: grp('Список', 'Номер — с кодом страны, на него придут уведомления в WhatsApp. Логин и пароль — для входа в CRM под своим именем; пароль хранится зашифрованным, посмотреть его нельзя, только задать новый. «Владелец» видит настройки и журналы, «менеджер» — только заявки. «Принимает заявки» выключите на время отпуска.',
          `<div id="f-team" class="team">${(s.managers || []).map(mgrRow).join('')}</div>
           <div class="team-add"><button class="btn ghost sm" id="f-addmgr">+ Добавить</button></div>`)
        + grp('Срок первого звонка', 'После передачи у заявки появляется срок «позвонить до». Ночью и в выходные отсчёт начинается с открытия рабочего дня. Просрочка подсвечивается красным, и о ней пишут ответственному и владельцу.',
          srow('Позвонить в течение', '', unit('f-sla', s.call_sla_min ?? 5, 'минут', 1, 240)))
        + grp('Записи разговоров', 'Запись прикрепляют к звонку в карточке: MP3, M4A, WAV или OGG. Слушать могут только те, кто входит в админку.',
          srow('Размер файла до', '', unit('f-recmax', s.rec_max_mb ?? 50, 'МБ', 1, 200))
          + srow('Хранить', '0 — хранить всегда. Старые записи удаляются, сам звонок в истории остаётся.', unit('f-reckeep', s.rec_keep_days ?? 0, 'дней', 0, 3650)))
        + grp('Контроль', 'Когда заявка получает предупреждение и что приходит владельцу. Все флаги видны на экране «Контроль дня».',
          srow('Предложение без ответа', 'Клиент молчит после предложения дольше этого — заявка помечается.', unit('f-offerwait', s.offer_wait_hours ?? 48, 'часов', 1, 720))
          + srow('Ждём фото/видео', 'Сколько ждать материал, прежде чем пометить заявку.', unit('f-mediawait', s.media_wait_hours ?? 24, 'часов', 1, 720))
          + srow('Вечерний отчёт владельцу', 'За 15 минут до конца рабочего дня: сколько передано, обзвонено, что не закрыто. Приходит тем, у кого в списке выше роль «владелец».',
            `<label class="switch"><input type="checkbox" id="f-evening" ${s.evening_report ? 'checked' : ''}></label>`))
    },
    logs: {
      lead: 'Кто что менял, кто входил и слушал записи, какие сообщения не ушли. Удалённые заявки возвращаются отсюда.',
      body: `<div class="seg logs-seg">${[['audit', 'Изменения'], ['access', 'Доступ'], ['failures', 'Сбои'], ['deleted', 'Удалённые']]
        .map(([k, t]) => `<button data-log="${k}" class="${logTab === k ? 'on' : ''}">${t}</button>`).join('')}</div>
        ${logTab === 'audit' ? '<input type="search" id="log-q" class="log-q" placeholder="поиск: имя, телефон, поле, значение">' : ''}
        <div id="f-logs" class="logs">загружаем…</div>`
    },
    ads: {
      lead: 'Клик по рекламе в Facebook или Instagram приносит с первым сообщением номер объявления. По нему CRM берёт из кабинета Meta названия кампании, группы и объявления и расходы по дням — для отчёта.',
      body: grp('Кабинет Meta', 'Доступ только на чтение: токен системного пользователя с правом ads_read. Токен — секрет, он задаётся на сервере в переменной META_ADS_TOKEN, а не здесь.',
          '<div id="f-meta" class="metabox">проверяем…</div>'
          + srow('Рекламный аккаунт', 'Номер вида act_1234567890 из Ads Manager.',
            `<input type="text" id="f-metaacc" class="mono" value="${esc(s.meta_ad_account || '')}" placeholder="act_1234567890">`)
          + srow('Загружать расходы с', 'С какого дня брать историю. Пусто — за последние 90 дней.',
            `<input type="date" id="f-metasince" value="${esc(s.meta_spend_since || '')}">`))
        + grp('Выручка и НДС', 'Расход в Meta указан без НДС. Чтобы ROAS был честным, выручку для него считаем без НДС.',
          srow('Суммы в CRM вносятся с НДС', 'Окончательная цена и оплата в карточках.',
            `<label class="switch"><input type="checkbox" id="f-vatwith" ${s.amounts_with_vat !== false ? 'checked' : ''}></label>`)
          + srow('Ставка НДС', '', unit('f-vatrate', s.vat_rate ?? 18, '%', 0, 30)))
        + grp('Расход вручную', 'Пока кабинет не подключён или для другой площадки: день, кампания, сумма. В отчёте сложится с расходом из Meta.',
          '<div id="f-spend" class="spendbox">загружаем…</div>')
        + grp('Справочник кампаний', 'По строке на кампанию: <code>ключ = Название</code>. Ключ ищется в заголовке объявления, в ссылке, в id клика, в метке и в первом сообщении клиента — подойдёт любой кусок текста, который есть только у этого объявления. Совпало — в заявке будет название кампании. Первая подходящая строка выигрывает.',
          swide(`<textarea id="f-sourcemap" class="mono" rows="7" placeholder="ашдод после ремонта = Ашдод · после ремонта&#10;#ig1 = Instagram · сторис&#10;utm_campaign=win = Окна, сентябрь">${esc(s.source_map || '')}</textarea>`))
        + grp('Что реально приходило', 'Последние объявления и метки, с которых писали клиенты. Отсюда удобно взять ключ для справочника.',
          swide('<div id="f-srclist" class="srclist">загружаем…</div>'))
    },
    data: {
      lead: 'Резервная копия данных и сброс тестовых диалогов. Настройки, прайс, расписание и привязка WhatsApp при сбросе остаются на месте.',
      body: grp('Резервная копия', 'База и все присланные файлы одним архивом. Диск сервера на этом тарифе не копируется, поэтому скачивайте архив хотя бы раз в неделю и перед любыми большими изменениями. Ключи WhatsApp в архив не входят.',
          srow('Скачать архив', 'Внутри app.db и папка media. Видео делают архив тяжёлым — это нормально.',
            '<a class="btn" href="/api/maintenance/export">Скачать резервную копию</a>'))
        + grp('Сброс переписки', 'Удаляются все диалоги, сообщения, заявки и присланные файлы. Отменить нельзя, копии не остаётся.',
        srow('Стереть данные', 'Спросим подтверждение: нужно будет набрать слово СТЕРЕТЬ.',
          '<button class="btn danger" id="f-wipe">Стереть все диалоги</button>'))
    },
    conn: {
      lead: 'Канал и модель задаются в файле <code>.env</code> и требуют перезапуска сервера.',
      body: grp('', '', `<div class="ctiles">
          <div class="ctile"><span>WhatsApp</span><b><i class="led" id="i-led"></i><em id="i-wa">—</em></b></div>
          <div class="ctile"><span>Номер бота</span><b id="i-me">—</b></div>
          <div class="ctile"><span>Канал</span><b>${esc(s.channel || '—')}</b></div>
          <div class="ctile"><span>Модель</span><b>${esc(s.ai_label || '—')}</b></div>
          <div class="ctile"><span>Голосовые</span><b>${esc(s.stt_label || 'не настроено')}</b></div></div>`
        + srow('Привязка WhatsApp', 'QR-код или код по номеру телефона, отвязка и переподключение.',
          '<button class="btn primary" id="f-qr">Управлять подключением</button>'))
      + grp('Глубина обдумывания', 'Сколько модель думает над каждым ответом. Выше — реже теряет нить в длинной переписке, но отвечает медленнее и дороже. Применяется сразу, перезапуск не нужен.',
        srow('Уровень', 'Обычному диалогу хватает среднего. Высокий имеет смысл, когда бот путается в условиях или повторяется.',
          `<select id="f-effort">${[['low', 'Низкая - быстро и дёшево'], ['medium', 'Средняя - по умолчанию'], ['high', 'Высокая - думает дольше']]
            .map(([v, t]) => `<option value="${v}" ${(s.ai_effort || 'low') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`))
    }
  }[setSection];

  $('#content').innerHTML = `<div class="settings">
    <nav class="set-nav">${SET_SECTIONS.map((x) => `<button data-s="${x.k}" class="${x.k === setSection ? 'on' : ''}">
      <span class="si">${ico(x.i)}</span><span><b>${x.t}</b><small>${x.d}</small></span></button>`).join('')}</nav>
    <div class="set-body">
      <div class="set-sec">
        <div class="set-hero"><span class="si">${ico(cur.i)}</span><div><h2>${cur.t}</h2><p>${sec.lead}</p></div></div>
        ${sec.body}
      </div>
      <div class="save-bar" id="save-bar"><span class="dot"></span>Есть несохранённые изменения
        <button class="btn ghost sm" id="f-reset">Отменить</button>
        <button class="btn primary sm" id="f-save">Сохранить</button></div>
    </div></div>`;
  setDirty(false);

  $$('.set-nav button').forEach((b) => b.onclick = () => {
    if (setDirtyFlag && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) return;
    setSection = b.dataset.s;
    renderSettings();
  });
  $('.set-body').addEventListener('input', () => setDirty(true));
  if ($('#f-prices')) {
    let pl;
    try { pl = JSON.parse(state.price_list); } catch { pl = { services: [] }; }
    renderPriceRows(pl.services || []);
    $('#f-addrow').onclick = () => { addPriceRow({ name: '', rate: '', min: '' }); setDirty(true); };
    $('#f-prices').addEventListener('input', priceExample);
    priceExample();
  }
  if ($('#f-hours')) renderHourRows(state.work_hours || {});
  if ($('#f-meta')) loadMetaBox();
  if ($('#f-spend')) loadSpendBox();
  if ($('#f-logs')) {
    $$('[data-log]').forEach((b) => b.onclick = () => { logTab = b.dataset.log; renderSettings(); });
    let t;
    $('#log-q') && ($('#log-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => loadLogs(e.target.value), 300); });
    loadLogs();
  }
  $$('.opt').forEach((o) => o.onclick = () => {
    $$('.opt').forEach((x) => x.classList.toggle('on', x === o));
    $('#f-off').value = o.dataset.v;
    setDirty(true);
  });
  $('#f-notify') && ($('#f-notify').onclick = async () => {
    if (!hasNotifications()) return;
    const p = await Notification.requestPermission();
    $('#f-notify').textContent = p === 'granted' ? 'Уведомления включены' : 'Браузер отказал';
  });
  $('#f-qr') && ($('#f-qr').onclick = () => showQr(waState));
  if ($('#f-srclist')) {
    api('/api/sources').then((rows) => {
      const box = $('#f-srclist');
      if (!box) return;
      box.innerHTML = rows.length ? rows.map((r) => {
        const keys = [r.source_title, r.raw?.sourceId, r.source_ref, r.source_url].filter(Boolean);
        return `<div class="srcrow"><div><b dir="auto">${esc(r.source)}</b>
          ${keys.length ? `<small dir="auto">${esc(keys.join(' · '))}</small>` : ''}</div>
          <span class="n">${r.n}</span></div>`;
      }).join('') : '<div class="empty" style="padding:18px 0">пока никто не писал с рекламы</div>';
    }).catch(() => {});
  }
  $('#f-wipe') && ($('#f-wipe').onclick = async () => {
    const n = (await api('/api/conversations')).length;
    if (!confirm(`Стереть ${n} ${plural(n, 'диалог', 'диалога', 'диалогов')} со всей перепиской и файлами?\n\nНастройки, прайс и подключение WhatsApp останутся.`)) return;
    if (prompt('Наберите СТЕРЕТЬ, чтобы подтвердить') !== 'СТЕРЕТЬ') return toast('Отменено');
    try {
      const gone = await api('/api/maintenance/reset', { method: 'POST', body: JSON.stringify({ confirm: 'СТЕРЕТЬ' }) });
      toast(`Стёрто: ${gone.conversations} ${plural(gone.conversations, 'диалог', 'диалога', 'диалогов')}, ${gone.messages} ${plural(gone.messages, 'сообщение', 'сообщения', 'сообщений')}`);
      convs = [];
      loadList();
    } catch (e) { toast(e.message, true); }
  });
  if ($('#i-wa')) {
    const [t, cls] = WA[waState.state] || ['—', ''];
    $('#i-wa').textContent = t;
    $('#i-led').className = 'led ' + cls;
    $('#i-me').textContent = waState.me ? '+' + waState.me : '—';
  }
  mgrGone = new Set();
  const bindMgr = (row) => { row.querySelector('.m-del').onclick = () => {
    if (row.dataset.id) mgrGone.add(Number(row.dataset.id));
    row.remove(); setDirty(true);
  }; };
  $$('.mgr-row').forEach(bindMgr);
  $('#f-addmgr') && ($('#f-addmgr').onclick = () => {
    $('#f-team').insertAdjacentHTML('beforeend', mgrRow({ role: 'manager', active: 1 }));
    const row = $('#f-team').lastElementChild;
    bindMgr(row); row.querySelector('.m-name').focus(); setDirty(true);
  });
  $('#f-reset').onclick = () => renderSettings();
  $('#f-save').onclick = saveSettings;
}

/** Живой пример расчёта под прайсом: видно, что именно назовёт бот. */
function priceExample() {
  const el = $('#f-pex');
  if (!el) return;
  const r = $$('#f-prices .prow').map((p) => ({
    n: p.querySelector('.nm').value.trim(),
    rate: Number(p.querySelector('.rate').value) || 0,
    min: Number(p.querySelector('.min').value) || 0
  })).find((x) => x.n && x.rate);
  if (!r) { el.textContent = ''; return; }
  const raw = r.rate * 80, sum = Math.max(raw, r.min);
  el.innerHTML = `Пример: ${esc(r.n)}, 80 м² × ${r.rate} ₪ = <b>${sum.toLocaleString('ru-RU')} ₪</b>`
    + (sum > raw ? ' — сработал минимум' : '');
}

function renderHourRows(h) {
  $('#f-hours').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const w = Array.isArray(h[d]) ? h[d] : null;
    return `<div class="hrow ${w ? '' : 'off'}" data-d="${d}">
      <span class="hname">${DAY_FULL[d]}</span>
      <label class="switch"><input type="checkbox" ${w ? 'checked' : ''}></label>
      <div class="htimes"><input type="time" class="from" value="${w ? w[0] : '08:00'}" ${w ? '' : 'disabled'}>
        <span class="hsep">—</span><input type="time" class="to" value="${w ? w[1] : '20:00'}" ${w ? '' : 'disabled'}>
        <span class="hl"></span></div>
      <span class="hoff">выходной</span></div>`;
  }).join('');
  const mins = (t) => { const [a, b] = String(t).split(':').map(Number); return a * 60 + (b || 0); };
  const dur = (row) => {
    const m = mins(row.querySelector('.to').value) - mins(row.querySelector('.from').value);
    row.querySelector('.hl').textContent = m > 0 ? (m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`) : '';
  };
  $$('#f-hours .hrow').forEach((row) => {
    const cb = row.querySelector('input[type=checkbox]');
    dur(row);
    row.querySelectorAll('input[type=time]').forEach((i) => i.addEventListener('input', () => dur(row)));
    cb.onchange = () => {
      row.classList.toggle('off', !cb.checked);
      row.querySelectorAll('input[type=time]').forEach((i) => i.disabled = !cb.checked);
    };
  });
}

function addPriceRow(r) {
  const div = document.createElement('div');
  div.className = 'prow';
  div.innerHTML = `<input class="nm" dir="auto" placeholder="например: после ремонта" value="${esc(r.name || '')}">
    <input class="num rate" type="number" min="0" step="0.5" placeholder="25" value="${esc(r.rate ?? '')}">
    <input class="num min" type="number" min="0" step="10" placeholder="400" value="${esc(r.min ?? '')}">
    <button type="button" title="Удалить">${ico('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>')}</button>`;
  div.querySelector('button').onclick = () => { div.remove(); setDirty(true); priceExample(); };
  $('#f-prices').appendChild(div);
}
function renderPriceRows(rows) {
  $('#f-prices').innerHTML = '';
  (rows.length ? rows : [{ name: '', rate: '', min: '' }]).forEach(addPriceRow);
}

async function saveSettings() {
  const body = {};
  const put = (id, key, tr = (v) => v) => { const el = $(id); if (el) body[key] = tr(el.value); };
  put('#f-company', 'company'); put('#f-tz', 'timezone');
  put('#f-facts', 'business_facts'); put('#f-greeting', 'greeting');
  put('#f-stepsask', 'nudge_steps_ask'); put('#f-stepsquoted', 'nudge_steps_quoted'); put('#f-stopwords', 'stop_words');
  put('#f-confirmeve', 'confirm_eve_hour'); put('#f-confirmmorning', 'confirm_morning_hour'); put('#f-mgrping', 'manager_ping_hours');
  if ($('#f-confirmon')) body.confirm_on = $('#f-confirmon').checked;
  put('#f-nudgestale', 'nudge_stale_hours'); put('#f-nudgeh', 'nudge_hours'); put('#f-nudgerep', 'nudge_repeat_hours'); put('#f-nudgemax', 'nudge_max');
  if ($('#f-nudgeon')) body.nudge_on = $('#f-nudgeon').checked;
  if ($$('.f-media').length) body.media_required = $$('.f-media').filter((x) => x.checked).map((x) => x.dataset.v).join(', ');
  put('#f-adminurl', 'admin_url'); put('#f-sourcemap', 'source_map');
  put('#f-metaacc', 'meta_ad_account'); put('#f-metasince', 'meta_spend_since'); put('#f-vatrate', 'vat_rate');
  if ($('#f-vatwith')) body.amounts_with_vat = $('#f-vatwith').checked;
  put('#f-effort', 'ai_effort');
  if ($('#f-notifyon')) body.notify_on = $('#f-notifyon').checked;
  put('#f-prompt', 'system_prompt'); put('#f-blocked', 'blocked_numbers'); put('#f-quick', 'quick_replies');
  put('#f-delay', 'reply_delay', (v) => Number(v) * 1000);
  put('#f-off', 'off_hours'); put('#f-offnote', 'off_hours_note');
  put('#f-holidays', 'holidays'); put('#f-autoclose', 'autoclose_days'); put('#f-wip', 'wip_need');

  if ($('#f-hours')) {
    body.work_hours = Object.fromEntries($$('#f-hours .hrow').map((row) => [
      row.dataset.d,
      row.querySelector('input[type=checkbox]').checked
        ? [row.querySelector('.from').value, row.querySelector('.to').value]
        : null
    ]));
  }

  if ($('#f-prices')) {
    let pl;
    try { pl = JSON.parse(state.price_list); } catch { pl = {}; }
    pl.currency = pl.currency || '₪';
    pl.services = $$('#f-prices .prow').map((r) => ({
      name: r.querySelector('.nm').value.trim(),
      rate: Number(r.querySelector('.rate').value) || 0,
      min: Number(r.querySelector('.min').value) || 0
    })).filter((x) => x.name && x.rate);
    body.price_list = JSON.stringify(pl, null, 2);
  }
  put('#f-offerwait', 'offer_wait_hours'); put('#f-mediawait', 'media_wait_hours');
  if ($('#f-evening')) body.evening_report = $('#f-evening').checked;
  put('#f-sla', 'call_sla_min'); put('#f-recmax', 'rec_max_mb'); put('#f-reckeep', 'rec_keep_days');
  // менеджеры — отдельные записи: сначала проверяем все, потом сохраняем
  const rows = $$('.mgr-row').map((r) => ({ id: Number(r.dataset.id) || undefined, name: r.querySelector('.m-name').value.trim(),
    phone: r.querySelector('.m-phone').value, role: r.querySelector('.m-role').value, active: r.querySelector('.m-active').checked,
    login: r.querySelector('.m-login').value.trim(), password: r.querySelector('.m-pass').value }));
  if (rows.some((m) => !m.name && m.phone)) return toast('У менеджера нужно имя');
  for (const id of mgrGone) await api(`/api/managers/${id}`, { method: 'DELETE' });
  try {
    for (const m of rows.filter((x) => x.name)) await api('/api/managers', { method: 'POST', body: JSON.stringify(m) });
  } catch (e) { return toast(e.message); }
  await api('/api/state', { method: 'POST', body: JSON.stringify(body) });
  await loadState();
  if (setSection === 'team') renderSettings();
  setDirty(false);
  toast('Настройки сохранены');
}

/* ───── состояние ───── */
async function loadList() {
  const prev = new Map(convs.map((c) => [c.id, c.needs_human]));
  const known = new Set(convs.map((c) => c.id));
  convs = await api('/api/conversations');
  // впервые увиденная заявка подсветится вспышкой, а не просто появится
  if (known.size) for (const c of convs) if (!known.has(c.id)) markFresh(c.id);
  // уведомляем только о новых передачах человеку, а не о каждом обновлении
  for (const c of convs) {
    if (c.needs_human && !prev.get(c.id) && !notified.has(c.id)) {
      notified.add(c.id);
      if (notifyReady()) {
        new Notification('Нужен менеджер', { body: `${c.name || '+' + c.phone}: ${c.handoff_reason || ''}`, tag: 'conv' + c.id });
      }
    }
    if (!c.needs_human) notified.delete(c.id);
  }
  const need = convs.filter((c) => c.needs_human).length;
  const redN = convs.filter((c) => c.stage !== 'closed' && (c.warn || []).some((w) => w.level === 'red')).length;
  const rb = $('#nav-red');
  if (rb) { rb.textContent = redN; rb.classList.toggle('hidden', !redN); }
  const badge = $('#nav-need');
  badge.textContent = need; badge.classList.toggle('hidden', !need);
  $('#tab-need').textContent = need; $('#tab-need').classList.toggle('hidden', !need);
  renderFunnel();
  if (page === 'inbox') return PAGES.inbox.render();
  if (page === 'settings') return;
  // сводку и расписание обновляем тихо: без повтора анимаций на каждое
  // входящее сообщение, иначе экран «моргал» бы при живом WhatsApp
  $('#content').classList.add('quiet');
  page === 'dash' ? loadStats() : PAGES[page].render();
}
async function loadStats() { stats = await api('/api/stats?days=' + statsDays); if (page === 'dash') { $('#hdr-tools').innerHTML = dashTools(); bindTools(); renderDash(); } }

async function loadState() {
  state = await api('/api/state');
  renderAiAlert();
  $('#brand-name').textContent = state.company || 'Клининг';
  $('#sf-ai').checked = state.ai_global;
  const h = $('#tb-hours');
  h.className = 'sf-row ' + (state.working_now ? 'ok' : 'bad');
  h.querySelector('span:last-child').textContent = state.working_now ? 'Рабочее время' : 'Нерабочее время';
  applyRole();
}

/** Что видно по роли (ТЗ §4.3): менеджеру не показываем настройки и тестовый симулятор. */
function applyRole() {
  const owner = isOwner();
  $$('a[data-p="settings"], a[data-p="report"], #nav-sim').forEach((a) => { a.hidden = !owner; });
  const box = $('#sf-me');
  if (!box) return;
  const u = me();
  box.hidden = !u.name;
  box.innerHTML = `<div class="me-row"><span class="ava">${esc((u.name || '?').slice(0, 1))}</span>
      <span class="me-n"><b>${esc(u.name)}</b><small>${ROLE_T[u.role] || ''}</small></span></div>
    <div class="me-acts">${u.id ? '<button class="btn ghost sm" id="me-pass">Пароль</button>' : ''}
      ${state.me_auth !== false ? '<button class="btn ghost sm" id="me-out">Выйти</button>' : ''}</div>`;
  $('#me-out') && ($('#me-out').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login.html';
  });
  $('#me-pass') && ($('#me-pass').onclick = async () => {
    const old = prompt('Текущий пароль');
    if (old == null) return;
    const pw = prompt('Новый пароль, минимум 6 символов');
    if (!pw) return;
    try {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ old, password: pw }) });
      toast('Пароль изменён. На других устройствах нужно войти заново');
    } catch (e) { toast(e.message, true); }
  });
}

/** Автоматика не должна отваливаться молча — это главная претензия
 *  к чужим системам: лимит кончился, бот замолчал, никто не заметил. */
function renderAiAlert() {
  let el = $('#ai-alert');
  const err = state.ai_error;
  if (!err) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'ai-alert';
    document.querySelector('.main').insertBefore(el, $('.content'));
  }
  el.className = 'ai-alert';
  el.innerHTML = `<b>Бот не отвечает.</b> ${esc(err.message)}
    <span style="opacity:.75">— заявки помечены «нужен человек»</span>
    <button class="btn sm" id="ai-alert-x">Скрыть</button>`;
  $('#ai-alert-x').onclick = () => el.remove();
}

const WA = { online:['WhatsApp на связи','ok'], qr:['Ждёт привязки','bad'], reconnecting:['Переподключение…','bad'],
  logged_out:['Номер отвязан','bad'], offline:['WhatsApp не подключён','bad'], not_configured:['Канал не настроен','bad'] };
let waState = {}, waTab = null, waKey = '', waPrev = null, waBannerT = null;

function renderWa(st) {
  if (!st || !st.state) return;
  waState = st;
  const [t, cls] = WA[st.state] || [st.state, 'bad'];
  const el = $('#tb-wa');
  el.className = 'sf-row click ' + cls;
  el.querySelector('span:last-child').textContent = t;
  el.onclick = openWa;
  // сами открываем окно, когда нужна привязка, — но один раз, а не на каждый новый QR
  const needLink = (x) => x === 'qr' || x === 'logged_out';
  if (needLink(st.state) && !needLink(waPrev)) openWa();
  waPrev = st.state;
  if (waDlg.open) renderWaDlg();
  waBanner();
  if (page === 'settings' && setSection === 'conn') renderSettings();
}

/** Окно подключения: QR для компьютера, код по номеру для телефона, отвязка и переподключение. */
function openWa() {
  if (!waDlg.open) { waTab = null; waDlg.showModal(); }
  renderWaDlg(true);
}
const showQr = openWa;     // старое имя: на него ссылаются настройки

function renderWaDlg(force = false) {
  const st = waState;
  const [t, cls] = WA[st.state] || [st.state || '—', 'bad'];
  $('#wa-state').innerHTML = `<i class="led ${cls}"></i>${esc(t)}${st.me ? ' · +' + esc(st.me) : ''}`;
  const tab = waTab || (isMobile() ? 'code' : 'qr');
  const key = [st.state, tab, st.pairCode, Boolean(st.qr)].join('|');
  if (!force && key === waKey) {            // пришёл только свежий QR — подменяем картинку, поле ввода не трогаем
    if (st.qr && $('#wa-qr')) $('#wa-qr').src = st.qr;
    return;
  }
  waKey = key;
  const phone = $('#wa-phone')?.value ?? (localStorage.getItem('waPhone') || '');
  const body = $('#wa-body');

  if (st.state === 'not_configured') {
    body.innerHTML = `<p class="wa-hint">Сейчас подключён другой канал. Привязка номера по QR нужна только при <code>CHANNEL=baileys</code> в файле <code>.env</code>.</p>`;
    return;
  }
  if (st.state === 'online') {
    body.innerHTML = `
      <div class="wa-ok"><span class="big">${ico('<path d="M20 6 9 17l-5-5"/>')}</span>
        <div><b>${st.me ? '+' + esc(st.me) : 'Номер'} подключён</b><span>Бот получает сообщения и отвечает от имени этого номера</span></div></div>
      <div class="wa-acts"><button class="btn" data-w="restart">Переподключить</button>
        <button class="btn danger" data-w="logout">Отвязать номер</button></div>
      <p class="wa-hint">«Переподключить» — если сообщения перестали приходить. «Отвязать» — чтобы подключить другой номер:
        устройство пропадёт из «Связанных устройств», появится новый QR.</p>`;
  } else {
    const qr = `<div class="wa-grid">
        <ol class="steps"><li>Откройте <b>WhatsApp</b> на телефоне с номером бота</li>
          <li><b>Настройки → Связанные устройства</b></li><li>Нажмите <b>Привязка устройства</b></li>
          <li>Наведите камеру на код</li></ol>
        <div class="qrbox">${st.qr ? `<img id="wa-qr" src="${st.qr}" alt="QR-код">`
          : `<div class="qrwait"><div class="spin"></div>${st.state === 'reconnecting' ? 'Подключаемся…' : 'Готовим код…'}</div>`}</div></div>
      <p class="wa-hint">Код обновляется сам. Админка открыта на том же телефоне? Тогда — вкладка «Код по номеру».</p>`;
    const code = st.pairCode ? `
        <div class="pcode"><b>${esc(st.pairCode)}</b><button class="btn sm" data-w="copy">Скопировать</button></div>
        <ol class="steps"><li>Откройте <b>WhatsApp</b> на телефоне +${esc(st.pairPhone || '')}</li>
          <li><b>Настройки → Связанные устройства → Привязка устройства</b></li>
          <li>Внизу экрана с камерой — <b>«Привязать по номеру телефона»</b></li>
          <li>Введите код. Он действует пару минут</li></ol>
        <button class="linkbtn" data-w="pair">Запросить новый код</button>`
      : `<div class="wa-lbl">Номер телефона, который подключаем</div>
        <div class="wa-field"><input id="wa-phone" type="tel" inputmode="tel" autocomplete="tel"
          placeholder="+972 50 123 4567" value="${esc(phone)}"><button class="btn primary" data-w="pair">Получить код</button></div>
        <p class="wa-hint">С кодом страны. WhatsApp пришлёт на этот телефон уведомление, а здесь появится код из 8 символов —
          его вводят в приложении вместо сканирования QR.</p>`;
    body.innerHTML = `
      ${st.state === 'logged_out' && st.error ? `<div class="wa-warn">${esc(st.error)}</div>` : ''}
      <div class="seg" id="wa-tabs"><button data-t="qr" class="${tab === 'qr' ? 'on' : ''}">QR-код</button>
        <button data-t="code" class="${tab === 'code' ? 'on' : ''}">Код по номеру</button></div>
      ${tab === 'qr' ? qr : code}
      <div class="wa-foot"><span>Неофициальное подключение через протокол WhatsApp Web — лучше отдельный рабочий номер.</span>
        <button class="linkbtn" data-w="restart">Перезапустить подключение</button></div>`;
  }
  $$('#wa-tabs button', body).forEach((b) => b.onclick = () => { waTab = b.dataset.t; renderWaDlg(true); });
  $$('[data-w]', body).forEach((b) => b.onclick = () => waAction(b.dataset.w, b));
  $('#wa-phone')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') waAction('pair', $('[data-w="pair"]')); });
}

/** Копирование работает и там, где нет navigator.clipboard (телефон по адресу в локальной сети). */
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}

async function waAction(a, btn) {
  const label = btn?.textContent;
  try {
    if (a === 'pair') {
      const phone = ($('#wa-phone')?.value || localStorage.getItem('waPhone') || '').trim();
      if (!phone) { waTab = 'code'; waState = { ...waState, pairCode: null }; renderWaDlg(true); return; }
      localStorage.setItem('waPhone', phone);
      if (btn) { btn.disabled = true; btn.textContent = 'Запрашиваем…'; }
      const r = await api('/api/wa/pair', { method: 'POST', body: JSON.stringify({ phone }) });
      waState = { ...waState, pairCode: r.code, pairPhone: phone.replace(/\D/g, '') };
      waTab = 'code';
      renderWaDlg(true);
    }
    if (a === 'copy') { await copyText(String(waState.pairCode || '').replace(/-/g, '')); toast('Код скопирован'); }
    if (a === 'restart') {
      await api('/api/wa/restart', { method: 'POST' });
      toast('Переподключаемся…');
    }
    if (a === 'logout') {
      if (!confirm('Отвязать номер? Бот перестанет получать сообщения, пока вы не привяжете номер снова.')) return;
      await api('/api/wa/logout', { method: 'POST' });
      toast('Номер отвязан — можно привязать заново');
    }
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/** Бот без WhatsApp — главная неприятность: заметно должно быть с любого экрана. */
function waBanner() {
  clearTimeout(waBannerT);
  const st = waState;
  const bad = st.state && !['online', 'not_configured'].includes(st.state);
  if (!bad) { $('#wa-banner')?.remove(); return; }
  // короткие переподключения — обычное дело, из-за них не шумим
  waBannerT = setTimeout(() => {
    let el = $('#wa-banner');
    if (!el) {
      el = Object.assign(document.createElement('div'), { id: 'wa-banner', className: 'wa-banner' });
      document.querySelector('.main').insertBefore(el, $('.content'));
    }
    el.innerHTML = `<i class="led"></i><span><b>${esc(WA[st.state]?.[0] || st.state)}.</b> Бот не получает сообщения из WhatsApp.</span>
      <button class="btn sm">${st.state === 'reconnecting' ? 'Подробнее' : 'Подключить'}</button>`;
    el.querySelector('button').onclick = openWa;
  }, st.state === 'reconnecting' ? 8000 : 0);
}
$('#wa-x').onclick = () => waDlg.close();
waDlg.addEventListener('click', (e) => { if (e.target === waDlg) waDlg.close(); });   // клик мимо окна

/* ───── события ───── */
$$('.side a[data-p], #tabbar a[data-p]').forEach((a) => a.onclick = () => { if (a.dataset.p === 'dash') loadStats(); go(a.dataset.p); });
$('#nav-sim').onclick = () => window.open('/sim.html', '_blank');

// меню сворачивается до значков; на узком экране — по умолчанию
const appEl = $('.app');
const sidePref = localStorage.getItem('side');
appEl.classList.toggle('collapsed', sidePref ? sidePref === 'collapsed' : innerWidth < 1240);
$('#side-toggle').onclick = () => {
  const c = appEl.classList.toggle('collapsed');
  localStorage.setItem('side', c ? 'collapsed' : 'open');
  $('#side-toggle').title = c ? 'Развернуть меню' : 'Свернуть меню';
};

// телефон: меню выезжает по кнопке таб-бара, заявка — «Чат» или «Карточка»
$('#tab-menu').onclick = () => appEl.classList.add('menu-open');
$('#side-scrim').onclick = () => appEl.classList.remove('menu-open');
$('#nav-sim').addEventListener('click', () => appEl.classList.remove('menu-open'));
function showLead(on) {
  $('#drawer').classList.toggle('show-lead', on);
  $$('#m-seg button').forEach((b) => b.classList.toggle('on', (b.dataset.m === 'lead') === on));
}
$$('#m-seg button').forEach((b) => b.onclick = () => showLead(b.dataset.m === 'lead'));
$('#m-back').onclick = closeDrawer;
$('#sf-ai').onchange = async (e) => {
  await api('/api/state', { method: 'POST', body: JSON.stringify({ ai_global: e.target.checked }) });
  loadState();
};
$$('#sf-theme button').forEach((b) => b.onclick = () => applyTheme(b.dataset.t));
applyTheme(localStorage.getItem('theme') || 'system');

$('#scrim').onclick = closeDrawer;
$('#drawer-close').onclick = closeDrawer;
document.onkeydown = (e) => {
  if (e.key === 'Escape' && drawerOpen) return closeDrawer();
  // «/» — быстрый переход в поиск, как в почтовых клиентах
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === '/' && !typing && $('#q')) { e.preventDefault(); $('#q').focus(); }
  if (typing || drawerOpen || page !== 'inbox' || leadView !== 'list') return;
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
  if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
  if (e.key === 'Enter') { e.preventDefault(); $('#inbox-chat [data-r="inp"]')?.focus(); }
};

const es = new EventSource('/api/events');
es.addEventListener('conversations', loadList);
es.addEventListener('wa', (e) => renderWa(JSON.parse(e.data || '{}')));
es.addEventListener('message', (e) => {
  loadList();
  const d = JSON.parse(e.data || '{}');
  if (d.conv_id === current && (drawerOpen || page === 'inbox')) openConv(current, drawerOpen);
});
es.addEventListener('typing', (e) => {
  const d = JSON.parse(e.data || '{}');
  if (d.conv_id !== current) return;
  const root = drawerOpen ? $('#drawer-chat') : $('#inbox-chat');
  const th = root?.querySelector('[data-r="thread"]');
  if (!th || th.querySelector('.typing')) return;
  th.insertAdjacentHTML('beforeend', '<div class="typing"><i></i><i></i><i></i></div>');
  const w = root.querySelector('[data-r="wrap"]'); w.scrollTop = w.scrollHeight;
});

fetch('/api/wa/status').then((r) => r.json()).then(renderWa).catch(() => {});
const deepLink = Number(new URLSearchParams(location.search).get('conv'));
if (deepLink) current = deepLink;            // ссылка из уведомления менеджеру
// ссылка из вечернего отчёта ведёт прямо на «Контроль дня»
loadState().then(() => { go(location.hash === '#control' && !deepLink ? 'control' : 'inbox'); loadList(); loadStats(); });
setInterval(() => { if (page === 'inbox' || page === 'control') PAGES[page].render(); }, 60000);
setInterval(loadState, 60000);   // «рабочее время» должно переключаться само
