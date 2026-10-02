/**
 * Кабинет Meta (этап 4, ТЗ §5): названия кампаний, групп, объявлений и
 * креативов по номеру объявления и расходы по дням.
 *
 * Только чтение: токен системного пользователя с ads_read. Токен — секрет,
 * поэтому лежит в переменной окружения META_ADS_TOKEN, а не в базе. Номер
 * рекламного аккаунта не секрет — его можно задать и в настройках.
 * Нет токена — модуль молчит, остальное работает: расход вносится руками.
 */
import { db, getSetting, setSetting, fillAdNames } from './db.js';
import { logFailure } from './integrations.js';

const VERSION = process.env.META_API_VERSION || 'v23.0';
const token = () => process.env.META_ADS_TOKEN || '';
export const accountId = () => {
  const a = String(process.env.META_AD_ACCOUNT || getSetting('meta_ad_account') || '').trim().replace(/^act_/, '');
  return /^\d{5,}$/.test(a) ? a : '';
};
export const metaConfigured = () => Boolean(token() && accountId());

async function graph(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith('http') ? new URL(pathOrUrl)
    : new URL(`https://graph.facebook.com/${VERSION}/${pathOrUrl}`);
  if (!pathOrUrl.startsWith('http')) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    url.searchParams.set('access_token', token());
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}

const day = (d) => d.toISOString().slice(0, 10);

function saveAd(a) {
  if (!a?.ad_id) return;
  db.prepare(`INSERT INTO meta_ads(ad_id, name, adset_id, adset_name, campaign_id, campaign_name, creative_id, creative_name, account_id, fetched_at)
    VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(ad_id) DO UPDATE SET name=COALESCE(excluded.name, name), adset_id=COALESCE(excluded.adset_id, adset_id),
      adset_name=COALESCE(excluded.adset_name, adset_name), campaign_id=COALESCE(excluded.campaign_id, campaign_id),
      campaign_name=COALESCE(excluded.campaign_name, campaign_name), creative_id=COALESCE(excluded.creative_id, creative_id),
      creative_name=COALESCE(excluded.creative_name, creative_name), account_id=COALESCE(excluded.account_id, account_id),
      fetched_at=datetime('now')`)
    .run(a.ad_id, a.name ?? null, a.adset_id ?? null, a.adset_name ?? null, a.campaign_id ?? null, a.campaign_name ?? null,
      a.creative_id ?? null, a.creative_name ?? null, a.account_id ?? null);
}

/** Названия по номерам объявлений из заявок — для тех, кого ещё нет в справочнике или он устарел. */
export async function resolveAds() {
  const ids = db.prepare(`SELECT DISTINCT c.ad_id FROM conversations c LEFT JOIN meta_ads a ON a.ad_id = c.ad_id
    WHERE c.ad_id IS NOT NULL AND (a.ad_id IS NULL OR a.creative_id IS NULL OR a.fetched_at < datetime('now', '-7 days'))`).all();
  let ok = 0;
  for (const { ad_id } of ids) {
    try {
      const j = await graph(ad_id, { fields: 'name,account_id,adset{id,name},campaign{id,name},creative{id,name}' });
      saveAd({ ad_id, name: j.name, account_id: j.account_id, adset_id: j.adset?.id, adset_name: j.adset?.name,
        campaign_id: j.campaign?.id, campaign_name: j.campaign?.name, creative_id: j.creative?.id, creative_name: j.creative?.name });
      ok++;
    } catch (e) {
      logFailure('meta', { target: ad_id, error: 'объявление ' + ad_id + ': ' + e.message });
    }
  }
  fillAdNames();
  return ok;
}

/**
 * Расходы по объявлениям по дням. Последние три дня перезагружаем каждый раз:
 * Meta досчитывает показы задним числом.
 */
export async function syncSpend() {
  const acc = accountId();
  const since0 = getSetting('meta_spend_since') || day(new Date(Date.now() - 90 * 864e5));
  const last = db.prepare("SELECT max(date) d FROM ad_spend WHERE source='meta'").get().d;
  const since = last && last > since0 ? day(new Date(new Date(last + 'T00:00:00Z') - 3 * 864e5)) : since0;
  const until = day(new Date());
  let next = null, rows = 0;
  const first = await graph(`act_${acc}/insights`, {
    level: 'ad', time_increment: '1', limit: '500',
    fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,account_currency',
    time_range: { since, until }
  });
  const put = db.prepare(`INSERT INTO ad_spend(date, ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
      spend, impressions, clicks, currency, source, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'meta',datetime('now'))
    ON CONFLICT(date, ad_id) WHERE ad_id IS NOT NULL DO UPDATE SET ad_name=excluded.ad_name, adset_id=excluded.adset_id,
      adset_name=excluded.adset_name, campaign_id=excluded.campaign_id, campaign_name=excluded.campaign_name,
      spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, currency=excluded.currency,
      updated_at=datetime('now')`);
  for (let page = first; page; page = next ? await graph(next) : null) {
    for (const r of page.data || []) {
      put.run(r.date_start, r.ad_id, r.ad_name, r.adset_id, r.adset_name, r.campaign_id, r.campaign_name,
        Number(r.spend) || 0, Number(r.impressions) || null, Number(r.clicks) || null, r.account_currency || null);
      saveAd({ ad_id: r.ad_id, name: r.ad_name, adset_id: r.adset_id, adset_name: r.adset_name,
        campaign_id: r.campaign_id, campaign_name: r.campaign_name, account_id: acc });
      rows++;
    }
    next = page.paging?.next || null;
  }
  fillAdNames();
  return { since, until, rows };
}

/** Полная синхронизация: расходы, затем названия. Ошибка — в журнал сбоев и в статус настроек. */
export async function syncMeta() {
  if (!metaConfigured()) return { skipped: true };
  try {
    const spend = await syncSpend();
    const ads = await resolveAds();
    setSetting('meta_last_sync', new Date().toISOString());
    setSetting('meta_last_error', '');
    return { ...spend, ads };
  } catch (e) {
    setSetting('meta_last_error', e.message.slice(0, 300));
    logFailure('meta', { error: e.message });
    throw e;
  }
}

export function metaStatus() {
  return {
    configured: metaConfigured(), has_token: Boolean(token()), account: accountId(),
    account_from_env: Boolean(process.env.META_AD_ACCOUNT), version: VERSION,
    last_sync: getSetting('meta_last_sync') || null, last_error: getSetting('meta_last_error') || null,
    since: getSetting('meta_spend_since') || null,
    ads_known: db.prepare('SELECT count(*) n FROM meta_ads').get().n,
    spend_days: db.prepare("SELECT count(DISTINCT date) n FROM ad_spend WHERE source='meta'").get().n
  };
}

export function startMeta() {
  const run = () => syncMeta().catch((e) => console.error('Meta:', e.message));
  setTimeout(run, 45e3).unref?.();
  setInterval(run, 6 * 36e5).unref?.();          // четыре раза в сутки хватает: расход меняется медленно
}
