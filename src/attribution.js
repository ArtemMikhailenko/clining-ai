/**
 * Статус атрибуции (ТЗ §5): насколько точно известно, откуда пришла заявка.
 *
 *   exact          — известно конкретное объявление (номер из карточки WhatsApp)
 *   partial        — реклама точно была, но объявление не определилось
 *   unknown        — пришла с рекламы, а данных нет совсем
 *   organic        — не с рекламы: написали сами, по ссылке, по метке
 *   manual         — источник указал человек, с причиной
 *   legacy_unknown — старая заявка: до этапа 4 детали рекламы не сохранялись
 *
 * Без базы и сети — чистая функция от уже сохранённых полей заявки.
 */

export const ATTR_TITLE = {
  exact: 'точно', partial: 'частично', unknown: 'неизвестно', organic: 'органика',
  manual: 'вручную', legacy_unknown: 'старая заявка'
};

export const PLATFORM_TITLE = {
  facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp (статусы)', meta: 'Meta',
  google: 'Google', site: 'Сайт', referral: 'Рекомендация', organic: 'Без рекламы', other: 'Другое'
};

const platformOf = (app = '') => {
  const a = String(app).toLowerCase();
  if (a === 'fb' || a.includes('facebook')) return 'facebook';
  if (a === 'ig' || a.includes('instagram')) return 'instagram';
  if (a.includes('whatsapp')) return 'whatsapp';
  return a ? 'meta' : '';
};

export function classifySource(c) {
  let raw = null;
  try { raw = c.source_raw ? JSON.parse(c.source_raw) : null; } catch {}
  const out = { status: 'organic', reason: null, platform: 'organic', ad_id: null, ctwa_clid: null,
    first_touch_at: c.created_at || null, label: null };

  if (c.attr_status === 'manual') return { ...out, status: 'manual', reason: c.attr_reason, platform: c.platform };

  if (raw) {
    out.platform = platformOf(raw.sourceApp) || 'meta';
    out.ctwa_clid = raw.ctwaClid || null;
    out.first_touch_at = raw.at ? raw.at.replace('T', ' ').slice(0, 19) : out.first_touch_at;
    out.label = `Реклама ${PLATFORM_TITLE[out.platform] || ''}`.trim();
    if (raw.sourceId && raw.sourceType === 'ad') {
      out.status = 'exact';
      out.ad_id = String(raw.sourceId);
    } else if (raw.sourceId) {
      // продвигаемая публикация: номер есть, но это пост, а не объявление
      out.status = 'partial';
      out.reason = `продвигаемая публикация (${raw.sourceType || raw.entry || 'тип не указан'}) — объявление не определено`;
    } else if (raw.ctwaClid || raw.title || raw.sourceUrl) {
      out.status = 'partial';
      out.reason = 'WhatsApp передал карточку рекламы без номера объявления';
    } else {
      out.status = 'unknown';
      out.reason = 'реклама отмечена, но данных объявления нет';
    }
    return out;
  }

  const src = String(c.source || '');
  if (/^Реклама/i.test(src)) {
    return { ...out, status: 'legacy_unknown', platform: 'meta',
      reason: 'заявка до сохранения деталей рекламы: объявление уже не восстановить' };
  }
  if (/^Метка /.test(src)) return { ...out, reason: 'метка в тексте сообщения: ' + src.slice(6) };
  if (src) return { ...out, reason: src };
  return out;
}
