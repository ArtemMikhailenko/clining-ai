/**
 * Отчёт по рекламе и продажам (ТЗ §9). Каждое число складывается из заявок,
 * и за каждым числом отдаём список этих заявок — клик в отчёте открывает их.
 * Поэтому итоги отчёта всегда совпадают с карточками.
 *
 * Определения:
 *   Leads      — уникальные сделки за период (по дате создания), без удалённых
 *   Qualified  — не отсеяна как «обычная уборка»/«сотрудник», известны город, объект и площадь
 *   Called     — есть хотя бы одна попытка звонка
 *   Answered   — есть разговор («дозвонился»)
 *   Quote sent — менеджер сохранил окончательную цену
 *   Agreed     — клиент подтвердил цену и дату (этап «согласовано» и дальше)
 *   Paid       — внесена оплата больше нуля
 *   Revenue    — сумма оплат
 *   CPL = расход / Leads, CAC = расход / Paid, ROAS = выручка / расход
 */
import { db, getSetting } from './db.js';
import { localDate } from './schedule.js';
import { stageIndex } from './stages.js';
import { ATTR_TITLE, PLATFORM_TITLE } from './attribution.js';
import { listManagers } from './calls.js';
import { debtOf } from './deals.js';

const parse = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const leadOf = (c) => { try { return JSON.parse(c.lead || '{}'); } catch { return {}; } };

export const METRICS = ['leads', 'qualified', 'called', 'answered', 'quoted', 'agreed', 'paid'];

function facts(c, calls) {
  const l = leadOf(c);
  const k = calls.get(c.id) || {};
  const unq = ['unq_regular', 'unq_staff'].includes(c.close_reason);
  return {
    leads: true,
    qualified: !unq && Boolean(l.district && l.object_type && l.area_m2),
    called: (k.n || 0) > 0,
    answered: (k.answered || 0) > 0,
    quoted: (c.deal_sum || 0) > 0,
    agreed: c.close_reason === 'paid' || Boolean(c.job_date) || (c.stage !== 'closed' && stageIndex(c.stage) >= stageIndex('agreed')),
    paid: (c.paid_sum || 0) > 0
  };
}

/* Измерения: значение заявки и подпись для отчёта */
const DIMS = {
  campaign: { t: 'Кампания', key: (c) => c.campaign_id || (c.campaign_name ? 'n:' + c.campaign_name : ''), label: (c) => c.campaign_name || '' },
  adset: { t: 'Группа объявлений', key: (c) => c.adset_id || '', label: (c) => c.adset_name || '' },
  // пока нет доступа к кабинету, объявление узнаём по заголовку из карточки WhatsApp
  ad: { t: 'Объявление', key: (c) => c.ad_id || '', label: (c) => c.ad_name || c.source_title || '' },
  platform: { t: 'Площадка', key: (c) => c.platform || 'organic', label: (c) => PLATFORM_TITLE[c.platform || 'organic'] || c.platform },
  attr: { t: 'Атрибуция', key: (c) => c.attr_status || 'organic', label: (c) => ATTR_TITLE[c.attr_status || 'organic'] },
  manager: { t: 'Менеджер', key: (c) => String(c.manager_id || ''), label: (c, m) => m.get(c.manager_id) || '' },
  lang: { t: 'Язык', key: (c) => c.lang || '', label: (c) => ({ he: 'иврит', ru: 'русский', uk: 'украинский', en: 'английский' }[c.lang] || c.lang || '') },
  service: { t: 'Вид уборки', key: (c) => leadOf(c).service || '', label: (c) => leadOf(c).service || '' },
  city: { t: 'Город', key: (c) => String(leadOf(c).district || '').trim().toLowerCase(), label: (c) => String(leadOf(c).district || '').trim() }
};
const SPEND_DIMS = new Set(['campaign', 'adset', 'ad']);

/** НДС: выручку для ROAS считаем без НДС, если суммы в CRM вносятся с ним. */
const netOf = (sum) => {
  const withVat = (getSetting('amounts_with_vat') ?? '1') === '1';
  const rate = Number(getSetting('vat_rate')) || 18;
  return withVat ? sum / (1 + rate / 100) : sum;
};

export function buildReport(q = {}) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : localDate(new Date(Date.now() - 29 * 864e5));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : localDate();
  const group = DIMS[q.group] ? q.group : 'campaign';
  const managers = new Map(listManagers().map((m) => [m.id, m.name]));

  // берём с запасом по UTC и режем по местной дате
  const all = db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL
      AND created_at >= datetime(?, '-1 day') AND created_at < datetime(?, '+2 day')`).all(from, to)
    .filter((c) => { const d = localDate(parse(c.created_at)); return d >= from && d <= to; });

  // фильтры — по тем же измерениям, что и разбивка
  const filters = Object.entries(DIMS).filter(([k]) => q[k] != null && q[k] !== '').map(([k, d]) => [k, d, String(q[k])]);
  const rows = all.filter((c) => filters.every(([, d, v]) => d.key(c) === v));

  const calls = new Map(db.prepare(`SELECT conv_id, count(*) n, sum(status='answered') answered FROM calls GROUP BY conv_id`)
    .all().map((r) => [r.conv_id, r]));

  const tally = (list) => {
    const ids = Object.fromEntries(METRICS.map((m) => [m, []]));
    let revenue = 0, debt = 0;
    const debtIds = [];
    for (const c of list) {
      const f = facts(c, calls);
      for (const m of METRICS) if (f[m]) ids[m].push(c.id);
      if (f.paid) revenue += c.paid_sum;
      // работа сделана, а оплачено меньше окончательной цены — задолженность (этап 5)
      const d = debtOf(c);
      if (d > 0) { debt += d; debtIds.push(c.id); }
    }
    return { ids: { ...ids, debt: debtIds }, counts: Object.fromEntries(METRICS.map((m) => [m, ids[m].length])), revenue, debt };
  };

  // расход: только по рекламным измерениям — по менеджеру или языку его не разделить
  const spendFilterable = filters.every(([k]) => SPEND_DIMS.has(k));
  const spendRows = db.prepare('SELECT * FROM ad_spend WHERE date >= ? AND date <= ?').all(from, to)
    .filter((s) => filters.every(([k, , v]) =>
      k === 'campaign' ? (s.campaign_id || 'n:' + s.campaign_name) === v
        : k === 'adset' ? s.adset_id === v : k === 'ad' ? s.ad_id === v : true));
  const spendOf = (list) => list.reduce((a, s) => a + (Number(s.spend) || 0), 0);
  const currency = spendRows.find((s) => s.currency)?.currency || '₪';

  const money = (t, spend) => {
    const net = netOf(t.revenue);
    return {
      revenue: t.revenue, revenue_net: Math.round(net), debt: t.debt, spend: spend == null ? null : Math.round(spend * 100) / 100,
      cpl: spend && t.counts.leads ? Math.round(spend / t.counts.leads) : null,
      cac: spend && t.counts.paid ? Math.round(spend / t.counts.paid) : null,
      roas: spend ? Math.round(net / spend * 100) / 100 : null
    };
  };

  const total = tally(rows);
  const totalSpend = spendFilterable ? spendOf(spendRows) : null;

  // разбивка
  const groups = new Map();
  const d = DIMS[group];
  for (const c of rows) {
    const k = d.key(c);
    if (!groups.has(k)) groups.set(k, { key: k, label: d.label(c, managers) || (k ? k : '—'), list: [] });
    groups.get(k).list.push(c);
  }
  // кампании и объявления, на которые тратили, но заявок не было, — тоже строки отчёта
  if (SPEND_DIMS.has(group) && spendFilterable) {
    for (const s of spendRows) {
      const k = group === 'campaign' ? (s.campaign_id || 'n:' + s.campaign_name) : group === 'adset' ? s.adset_id : s.ad_id;
      if (k && !groups.has(k)) {
        groups.set(k, { key: k, label: (group === 'campaign' ? s.campaign_name : group === 'adset' ? s.adset_name : s.ad_name) || k, list: [] });
      }
    }
  }
  const breakdown = [...groups.values()].map((g) => {
    const t = tally(g.list);
    const sp = SPEND_DIMS.has(group) && spendFilterable
      ? spendOf(spendRows.filter((s) => (group === 'campaign' ? (s.campaign_id || 'n:' + s.campaign_name)
        : group === 'adset' ? s.adset_id : s.ad_id) === g.key))
      : null;
    return { key: g.key, label: g.label, ...t.counts, ids: t.ids, ...money(t, sp) };
  }).sort((a, b) => (b.spend || 0) - (a.spend || 0) || b.leads - a.leads);

  // варианты для фильтров — из заявок периода, без учёта самих фильтров
  const options = Object.fromEntries(Object.entries(DIMS).map(([k, dd]) => {
    const m = new Map();
    for (const c of all) { const key = dd.key(c); if (key && !m.has(key)) m.set(key, dd.label(c, managers) || key); }
    return [k, [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))];
  }));

  return {
    from, to, group, group_title: d.t, currency,
    dims: Object.fromEntries(Object.entries(DIMS).map(([k, dd]) => [k, dd.t])),
    totals: { ...total.counts, ids: total.ids, ...money(total, totalSpend) },
    spend_note: spendFilterable ? null : 'Расход по менеджеру, языку, виду уборки или городу не делится — CPL, CAC и ROAS не считаем',
    vat_note: (getSetting('amounts_with_vat') ?? '1') === '1'
      ? `ROAS — по выручке без НДС (${Number(getSetting('vat_rate')) || 18}%): расход Meta указан без НДС` : null,
    breakdown, options
  };
}

/** Короткие строки заявок для списка «из чего сложилось число». */
export function leadList(ids) {
  const list = (ids || []).map(Number).filter(Boolean).slice(0, 500);
  if (!list.length) return [];
  return db.prepare(`SELECT id, phone, name, lead, stage, close_reason, created_at, deal_sum, paid_sum, campaign_name, ad_name, platform, attr_status
    FROM conversations WHERE id IN (${list.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...list)
    .map((c) => ({ ...c, lead_name: leadOf(c).name || '', service: leadOf(c).service || '', city: leadOf(c).district || '', lead: undefined }));
}
