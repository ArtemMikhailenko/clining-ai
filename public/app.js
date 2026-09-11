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

const api = async (url, opts) => {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
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
const COLUMNS = [
  { k:'need',    t:'Нужен человек', c:'var(--warn)',   hint:'ИИ передал диалог' },
  { k:'manager', t:'У менеджера',   c:'var(--s1)',     hint:'человек ведёт сам' },
  { k:'ai',      t:'ИИ уточняет',   c:'var(--accent)', hint:'бот собирает заявку' },
  { k:'quoted',  t:'Назвали цену',  c:'var(--s4)',     hint:'ждём решения клиента' },
  { k:'agreed',  t:'Договорились',  c:'var(--s3)',     hint:'дата согласована' },
  { k:'closed',  t:'Закрыто',       c:'var(--muted)',  hint:'выполнено или отказ' }
];
function columnOf(c) {
  const st = lead(c).stage;
  if (c.status === 'closed' || st === 'отказ') return 'closed';
  if (c.needs_human) return 'need';
  if (['готов к заказу', 'дата согласована'].includes(st)) return 'agreed';
  if (st === 'назвали цену') return 'quoted';
  if (c.status === 'human') return 'manager';
  return 'ai';
}
const colTitle = (k) => COLUMNS.find((x) => x.k === k).t;

const matches = (c) => {
  // на доске чужие колонки только приглушаются, фильтрует лишь список
  if (stageFilter && leadView === 'list' && columnOf(c) !== stageFilter) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (c.name || '').toLowerCase().includes(q) || String(c.phone).includes(q)
    || (c.summary || '').toLowerCase().includes(q) || (c.last_body || '').toLowerCase().includes(q);
};
function chipFor(c) {
  if (c.needs_human) return '<span class="chip need">нужен человек</span>';
  return ({ ai:'<span class="chip ai">ИИ ведёт</span>', human:'<span class="chip human">менеджер</span>',
    closed:'<span class="chip closed">закрыта</span>', new:'<span class="chip ai">новая</span>' })[c.status] ?? '';
}

/* ═══════════ страницы ═══════════ */
const PAGES = {
  dash:     { title: 'Сводка',    tpl: 'tpl-dash',  render: renderDash,  tools: dashTools },
  inbox:    { title: 'Заявки',
              get tpl() { return leadView === 'board' ? 'tpl-board' : 'tpl-inbox'; },
              render: () => (leadView === 'board' ? renderBoard() : renderLeads()),
              tools: leadsTools },
  cal:      { title: 'Расписание', tpl: 'tpl-cal',  render: renderCal,   tools: calTools },
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
    </div>
    <div class="hstat" id="hstat"></div>` + searchTool()
    + `<button class="btn" id="csv">CSV</button>`;
}
function calTools() {
  const chev = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return `<div class="seg">
    <button id="cal-prev" title="Предыдущая неделя">${chev('m15 18-6-6 6-6')}</button>
    <button id="cal-today" class="${weekOffset === 0 ? 'on' : ''}">Эта неделя</button>
    <button id="cal-next" title="Следующая неделя">${chev('m9 18 6-6-6-6')}</button></div>`;
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
}

function renderHeaderStats() {
  const el = $('#hstat');
  if (!el) return;
  const need = convs.filter((c) => c.needs_human).length;
  const active = convs.filter((c) => c.status !== 'closed').length;
  const money = convs.filter((c) => c.status !== 'closed')
    .reduce((a, c) => a + (Number(String(lead(c).price_quote || '').replace(/[^\d]/g, '')) || 0), 0);
  el.innerHTML = `
    <span class="hchip ${need ? 'warn' : ''}"><b>${need}</b> ждут ответа</span>
    <span class="hchip"><b>${active}</b> в работе</span>
    <span class="hchip gold"><b>${money.toLocaleString('ru-RU')} ₪</b> в воронке</span>`;
}

/** Выгрузка заявок для бухгалтерии или переноса в другую систему. */
function exportCsv() {
  const rows = convs.filter(matches);
  const head = ['Клиент', 'Телефон', 'Уборка', 'м²', 'Комнат', 'Санузлов', 'Район', 'Дата', 'Цена', 'Стадия', 'Обновлена'];
  const esc2 = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((c) => {
    const l = lead(c);
    return [l.name || c.name || '', '+' + c.phone, l.service, l.area_m2, l.rooms_count, l.bathrooms,
      l.district, l.date, l.price_quote, colTitle(columnOf(c)), c.last_at].map(esc2).join(';');
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
const money = (v) => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
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
    { t: 'Назвали цену', v: s.quoted, c: 'var(--s4)', why: 'получили цену' },
    { t: 'Договорились', v: s.agreed, c: 'var(--s3)', why: 'согласились' }
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
const STAGE_COLOR = { 'уточняем': 'var(--accent)', 'назвали цену': 'var(--s4)', 'дата согласована': 'var(--s3)',
  'готов к заказу': 'var(--s3)', 'отказ': 'var(--muted)' };

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
        'по названным ценам')}
      ${kpi('var(--accent)', 'bolt', 'Ответ бота', `<div class="v">${secs ? secs + '<small>с</small>' : '—'}</div>`, 'в среднем')}
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
          <span><i style="background:var(--muted)"></i>закрыто <b>${s.closed}</b></span></div></div>
      </div>
    </div>
    <div class="panels low">
      <div class="panel"><div class="ph"><div><h3>Ближайшие уборки</h3><div class="s">что в работе на этой неделе</div></div></div>
        <div id="dash-jobs" class="joblist"></div></div>
      <div class="panel"><div class="ph"><div><h3>Типы уборки</h3><div class="s">по всем заявкам периода</div></div></div>${hbars(s.by_service, 'var(--s1)')}</div>
      <div class="panel"><div class="ph"><div><h3>Районы</h3><div class="s">откуда пишут клиенты</div></div></div>${hbars(s.by_district, 'var(--accent)')}</div>
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
  const pending = week.filter((j) => !j.confirmed).length;
  const free = days.filter((d) => Array.isArray(hours[d.getDay()]) && !hol[iso(d)] && iso(d) >= today
    && !jobs.some((j) => j.date === iso(d))).length;
  $('#cal-sum').innerHTML = `
    <div class="cs"><b>${week.length}</b>${plural(week.length, 'уборка', 'уборки', 'уборок')}</div>
    <div class="cs gold"><b>${total ? total.toLocaleString('ru-RU') + ' ₪' : '—'}</b>на неделе</div>
    <div class="cs ${pending ? 'warn' : ''}"><b>${pending}</b>ждут подтверждения</div>
    <div class="cs"><b>${free}</b>${plural(free, 'свободный день', 'свободных дня', 'свободных дней')}</div>
    <div class="grow"></div>
    <div class="cal-legend"><span><i style="background:var(--s3)"></i>подтверждена</span>
      <span><i style="background:var(--warn)"></i>ждёт подтверждения</span><span><i class="hatch"></i>выходной</span></div>`;

  el.innerHTML = days.map((d, di) => {
    const key = iso(d), mine = jobs.filter((j) => j.date === key);
    const isHol = hol[key];
    const h = hours[d.getDay()];
    const working = Array.isArray(h) && !isHol;
    const sum = mine.reduce((a, j) => a + money(j.price), 0);
    const when = working ? h.join('–') : isHol ? 'праздник' : 'выходной';
    const cls = [!working && 'off', key === today && 'today', key < today && 'past'].filter(Boolean).join(' ');
    return `<div class="cday ${cls}" style="animation-delay:${di * 30}ms">
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
  $$('.job', el).forEach((j) => j.onclick = () => openConv(Number(j.dataset.id), true));

  const upcoming = jobs.filter((j) => j.date >= today).length;
  const badge = $('#nav-cal');
  badge.textContent = upcoming; badge.classList.toggle('hidden', !upcoming);
}

function jobHtml(j, i) {
  return `<div class="job ${j.confirmed ? '' : 'unconfirmed'}" data-id="${j.id}" style="animation-delay:${i * 40}ms">
    <div class="jt">${ico(ICONS.time)}${esc(j.time || 'время не назначено')}
      ${j.confirmed ? '' : '<span class="st">не подтверждена</span>'}</div>
    <b dir="auto">${esc(j.name || '+' + j.phone)}</b>
    <div class="m">${esc([j.service, j.area && j.area + ' м²'].filter(Boolean).join(' · '))}</div>
    ${j.district ? `<div class="m" dir="auto">${ico(ICONS.pin)}${esc(j.district)}</div>` : ''}
    ${j.price ? `<span class="p">${esc(j.price)}</span>` : ''}
  </div>`;
}

/* ───── доска: обзор воронки ─────
   Список отвечает на «кому ответить сейчас», доска — на «где что застряло
   и где деньги». Это разные вопросы, поэтому оба вида нужны. */
function waitHtml(c) {
  if (!c.needs_human || !c.last_in_at) return '';
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
  el.innerHTML = `${n} ${plural(n, 'заявка', 'заявки', 'заявок')}`
    + (stageFilter ? ` · ${esc(colTitle(stageFilter))}<span class="clr" id="clr-stage">сбросить</span>` : '');
  const x = $('#clr-stage');
  if (x) x.onclick = () => setStage(null);
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
  const by = Object.fromEntries(COLUMNS.map((x) => [x.k, 0]));
  convs.forEach((c) => by[columnOf(c)]++);
  const bar = COLUMNS.filter((x) => by[x.k])
    .map((x) => `<i style="flex:${by[x.k]};background:${x.c}" title="${x.t}: ${by[x.k]}"></i>`).join('')
    || '<i style="flex:1;background:var(--border)"></i>';
  box.innerHTML = `<div class="fbar">${bar}</div>` + COLUMNS.map((x) => {
    const cls = [stageFilter === x.k && 'on', !by[x.k] && 'zero', x.k === 'need' && by[x.k] && 'alert']
      .filter(Boolean).join(' ');
    return `<a class="frow ${cls}" data-k="${x.k}"><span class="fdot" style="--c:${x.c}"></span>
      <span class="lbl">${x.t}</span><span class="fn">${by[x.k]}</span></a>`;
  }).join('');
  $$('.frow', box).forEach((r) => r.onclick = () => setStage(stageFilter === r.dataset.k ? null : r.dataset.k));
}

function renderBoard() {
  const board = $('#board');
  if (!board || dragging) return;
  const rows = convs.filter(matches);
  const by = Object.fromEntries(COLUMNS.map((x) => [x.k, []]));
  rows.forEach((c) => by[columnOf(c)].push(c));
  subLine(rows.length);
  renderHeaderStats();

  const wip = Number(state.wip_need) || 0;
  board.innerHTML = COLUMNS.map((col) => {
    const items = by[col.k];
    const money = items.reduce((a, c) => a + (Number(String(lead(c).price_quote || '').replace(/[^\d]/g, '')) || 0), 0);
    const over = col.k === 'need' && wip && items.length > wip;
    const dim = stageFilter && stageFilter !== col.k ? 'dim' : '';
    return `<div class="colm ${over ? 'over-wip' : ''} ${dim}" data-col="${col.k}" style="--c:${col.c}">
      <div class="colm-head"><b>${col.t}</b>
        ${money ? `<span class="sum">${money.toLocaleString('ru-RU')} ₪</span>` : ''}
        <span class="cnt">${items.length}${over ? ' / ' + wip : ''}</span></div>
      ${over ? '<div class="wip-warn">Очередь переполнена — клиенты ждут слишком долго</div>' : ''}
      <div class="colm-body">${items.map(cardHtml).join('')
        || `<div class="colm-empty">${col.hint}</div>`}</div></div>`;
  }).join('');

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
      await api(`/api/conversations/${id}/column`, { method: 'POST', body: JSON.stringify({ column: col.dataset.col }) });
      toast('Перенесено в «' + colTitle(col.dataset.col) + '»');
      loadList();
    };
  });
}

/* ───── список заявок ─────
   Плотные строки с выровненными колонками вместо карточек: за один экран
   помещается втрое больше, и заявки читаются сканированием, а не разглядыванием. */
const COLLAPSED = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));

function rowHtml(c) {
  const l = lead(c);
  const col = COLUMNS.find((x) => x.k === columnOf(c));
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
  const by = Object.fromEntries(COLUMNS.map((x) => [x.k, []]));
  rows.forEach((c) => by[columnOf(c)].push(c));
  subLine(rows.length);
  renderHeaderStats();

  const wip = Number(state.wip_need) || 0;
  box.innerHTML = COLUMNS.map((col) => {
    const items = by[col.k];
    // пустые группы не показываем: они занимали место и подсказка в строке
    // читалась как содержимое. Исключение — очередь «Нужен человек»:
    // её ноль сам по себе новость
    if (!items.length && col.k !== 'need') return '';
    const money = items.reduce((a, c) => a + (Number(String(lead(c).price_quote || '').replace(/[^\d]/g, '')) || 0), 0);
    const closed = COLLAPSED.has(col.k);
    const over = col.k === 'need' && wip && items.length > wip;
    return `<div class="grp ${closed ? 'closed' : ''}" data-g="${col.k}">
        <span class="caret">▾</span><span class="dot" style="background:${col.c}"></span>
        <b>${col.t}</b><span class="n">${items.length}${over ? ' / ' + wip : ''}</span>
        ${money ? `<span class="sum">${money.toLocaleString('ru-RU')} ₪</span>` : ''}
      </div>
      ${closed ? '' : items.map(rowHtml).join('')}`;
  }).join('');

  $$('.grp', box).forEach((g) => g.onclick = () => {
    const k = g.dataset.g;
    COLLAPSED.has(k) ? COLLAPSED.delete(k) : COLLAPSED.add(k);
    localStorage.setItem('collapsed', JSON.stringify([...COLLAPSED]));
    renderLeads();
  });
  // открываем прямо в средней панели: главная работа не должна прятаться за overlay
  $$('.lrow', box).forEach((r) => r.onclick = () => openConv(Number(r.dataset.id), isMobile()));
  $$('.lacts button', box).forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const id = Number(b.closest('.lrow').dataset.id);
    await api(`/api/conversations/${id}/column`, { method: 'POST', body: JSON.stringify({ column: b.dataset.act }) });
    toast(b.dataset.act === 'closed' ? 'Заявка закрыта' : b.dataset.act === 'ai' ? 'Диалог вернули боту' : 'Диалог у вас');
    loadList();
  });
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
    const who = { customer:'клиент', ai:'ИИ', human:'менеджер' }[m.author];
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
  q('[data-a="close"]').onclick = async () => {
    await api(`/api/conversations/${c.id}/status`, { method: 'POST',
      body: JSON.stringify({ status: c.status === 'closed' ? 'human' : 'closed' }) });
    openConv(c.id, drawerOpen);
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
const LABELS = { service:'Тип уборки', object_type:'Объект', area_m2:'Площадь, м²', rooms_count:'Комнат',
  bathrooms:'Санузлов', district:'Район', address:'Адрес', works:'Что сделать', date:'Дата', windows:'Мыть окна', condition:'Загрязнение',
  price_quote:'Названа цена', stage:'Стадия' };

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
  ['date_iso', 'Дата заказа', 'date'],
  ['time', 'Время', 'text'],
  ['windows', 'Мыть окна', 'select', ['', 'да', 'нет']],
  ['condition', 'Загрязнение', 'select', ['', 'лёгкое', 'среднее', 'сильное', 'после ремонта']],
  ['price_quote', 'Названа цена', 'text'],
  ['stage', 'Стадия', 'select', ['', 'новый', 'уточняем', 'ждём видео', 'заявка готова', 'назвали цену', 'готов к заказу', 'дата согласована', 'отказ']]
];

function leadFormHtml(c) {
  const l = lead(c);
  return `<div class="lead"><form class="leadform" data-r="leadform">
    ${EDITABLE.map(([k, t, type, opts]) => `<label class="lf"><span>${t}</span>
      ${type === 'select'
        ? `<select name="${k}">${opts.map((o) => `<option value="${esc(o)}" ${l[k] === o ? 'selected' : ''}>${o || '—'}</option>`).join('')}</select>`
        : `<input name="${k}" type="${type}" dir="auto" value="${esc(l[k] || '')}">`}</label>`).join('')}
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

function leadHtml(c) {
  const l = lead(c);
  const q = c.quote;
  const rows = Object.entries(LABELS).filter(([k]) => l[k])
    .map(([k, t]) => `<div class="kv"><dt>${t}</dt><dd dir="auto">${esc(l[k])}</dd></div>`).join('');
  const rooms = (l.rooms || []).filter((r) => r.room)
    .map((r) => `<div class="room"><b dir="auto">${esc(r.room)}</b><span dir="auto">${esc(r.notes || '')}</span></div>`).join('');
  const photos = (c.messages || []).flatMap((m) => m.media ? JSON.parse(m.media) : []);
  const thumbs = photos.map((it) => it.kind === 'video'
    ? `<video src="/media/${esc(it.file)}" preload="metadata"></video>`
    : `<img src="/media/${esc(it.file)}" loading="lazy" alt="">`).join('');
  return `<div class="lead">
    <div class="lead-head"><h4>Заявка</h4><button class="btn ghost sm" data-a="lead-edit">Изменить</button></div>
    <div class="lead-acts">
      <a class="btn" href="tel:+${esc(c.phone)}">${ico('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>')}Позвонить</a>
      <a class="btn" href="https://wa.me/${esc(c.phone)}" target="_blank" rel="noopener">${ico('<path d="M3 21l1.6-4.7A8.5 8.5 0 1 1 8 19.6z"/>')}WhatsApp</a>
    </div>
    <div class="kv"><dt>Колонка</dt><dd><select data-r="col">${COLUMNS.map((x) =>
      `<option value="${x.k}" ${columnOf(c) === x.k ? 'selected' : ''}>${x.t}</option>`).join('')}</select></dd></div>
    <div class="kv"><dt>Телефон</dt><dd>+${esc(c.phone)}</dd></div>
    <div class="kv"><dt>Имя</dt><dd dir="auto">${esc(l.name || c.name || '—')}</dd></div>
    <div class="kv"><dt>Создана</dt><dd>${dt(c.created_at).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}</dd></div>
    ${rows || '<div class="empty" style="padding:24px 0">ИИ ещё не собрал данные</div>'}
    ${q ? `<div class="sect"><h4>Расчёт по прайсу</h4><div class="calc">
        ${q.lines.map((x) => `<div class="l"><span>${esc(x.label)}</span><span>${x.sum.toLocaleString('ru-RU')}</span></div>`).join('')}
        <div class="tot"><span>Итого</span><span>${q.total.toLocaleString('ru-RU')} ${esc(q.currency)}</span></div>
      </div></div>` : ''}
    ${thumbs ? `<div class="sect"><h4>Фото от клиента (${photos.length})</h4><div class="thumbs">${thumbs}</div></div>` : ''}
    ${rooms ? `<div class="sect"><h4>Что видно на фото</h4>${rooms}</div>` : ''}
    ${c.summary ? `<div class="sect"><h4>Суть</h4><div class="quote" dir="auto">${esc(c.summary)}</div></div>` : ''}
    <div class="sect note"><h4>Заметка менеджера</h4>
      <textarea data-r="note" dir="auto" placeholder="Видна только вам, клиенту не уходит">${esc(c.note || '')}</textarea></div>
  </div>`;
}

function bindLead(root, convId) {
  const col = root.querySelector('[data-r="col"]');
  if (col) col.onchange = async () => {
    await api(`/api/conversations/${convId}/column`, { method: 'POST', body: JSON.stringify({ column: col.value }) });
    toast('Перенесено в «' + colTitle(col.value) + '»');
    loadList();
    openConv(convId, drawerOpen);
  };
  const ta = root.querySelector('[data-r="note"]');
  if (ta) ta.onblur = async () => {
    await api(`/api/conversations/${convId}/note`, { method: 'POST', body: JSON.stringify({ note: ta.value }) });
    toast('Заметка сохранена');
  };
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
  { k:'access', t:'Доступ', d:'белый список, уведомления',
    i:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>' },
  { k:'conn', t:'Подключения', d:'WhatsApp, модель, QR',
    i:'<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>' }
];
let setSection = 'company';
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

function setDirty(v) {
  setDirtyFlag = v;
  $('#save-bar')?.classList.toggle('on', v);
}

function renderSettings() {
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
        srow('Белый список номеров', 'Через запятую. Остальным бот молчит, но заявка всё равно появится с пометкой «нужен человек». Пусто — отвечает всем.',
          `<textarea id="f-allowed" class="mono" rows="3" placeholder="пусто — отвечать всем">${esc(s.allowed_numbers || '')}</textarea>`)
        + srow('Уведомления в браузере', 'Всплывающее уведомление, когда бот передаёт диалог человеку.',
          `<button class="btn" id="f-notify">${Notification?.permission === 'granted' ? 'Уведомления включены' : 'Включить уведомления'}</button>`))
    },
    conn: {
      lead: 'Канал и модель задаются в файле <code>.env</code> и требуют перезапуска сервера.',
      body: grp('', '', `<div class="ctiles">
          <div class="ctile"><span>WhatsApp</span><b><i class="led" id="i-led"></i><em id="i-wa">—</em></b></div>
          <div class="ctile"><span>Номер бота</span><b id="i-me">—</b></div>
          <div class="ctile"><span>Канал</span><b>${esc(s.channel || '—')}</b></div>
          <div class="ctile"><span>Модель</span><b>${esc(s.ai_label || '—')}</b></div></div>`
        + srow('Привязка WhatsApp', 'QR-код или код по номеру телефона, отвязка и переподключение.',
          '<button class="btn primary" id="f-qr">Управлять подключением</button>'))
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
  $$('.opt').forEach((o) => o.onclick = () => {
    $$('.opt').forEach((x) => x.classList.toggle('on', x === o));
    $('#f-off').value = o.dataset.v;
    setDirty(true);
  });
  $('#f-notify') && ($('#f-notify').onclick = async () => {
    const p = await Notification.requestPermission();
    $('#f-notify').textContent = p === 'granted' ? 'Уведомления включены' : 'Браузер отказал';
  });
  $('#f-qr') && ($('#f-qr').onclick = () => showQr(waState));
  if ($('#i-wa')) {
    const [t, cls] = WA[waState.state] || ['—', ''];
    $('#i-wa').textContent = t;
    $('#i-led').className = 'led ' + cls;
    $('#i-me').textContent = waState.me ? '+' + waState.me : '—';
  }
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
  put('#f-prompt', 'system_prompt'); put('#f-allowed', 'allowed_numbers'); put('#f-quick', 'quick_replies');
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
  await api('/api/state', { method: 'POST', body: JSON.stringify(body) });
  await loadState();
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
      if (Notification?.permission === 'granted') {
        new Notification('Нужен менеджер', { body: `${c.name || '+' + c.phone}: ${c.handoff_reason || ''}`, tag: 'conv' + c.id });
      }
    }
    if (!c.needs_human) notified.delete(c.id);
  }
  const need = convs.filter((c) => c.needs_human).length;
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
loadState().then(() => { go('inbox'); loadList(); loadStats(); });
setInterval(() => { if (page === 'inbox') PAGES[page].render(); }, 60000);
setInterval(loadState, 60000);   // «рабочее время» должно переключаться само
