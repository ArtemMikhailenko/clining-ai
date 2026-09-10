/**
 * Расчёт цены по прайсу. Считаем в коде, а не просим модель умножать:
 * арифметика в языковой модели — источник ошибок, а цена это деньги.
 * Прайс хранится структурой; свободный текст «услуги и цены» остаётся
 * для условий и оговорок, которые в таблицу не ложатся.
 */
import { getSetting } from './db.js';

export const DEFAULT_PRICES = {
  currency: '₪',
  services: [
    { name: 'после ремонта', rate: 25, min: 400 },
    { name: 'перед въездом', rate: 18, min: 400 },
    { name: 'после выезда',  rate: 18, min: 400 },
    { name: 'генеральная',   rate: 15, min: 350 },
    { name: 'поддерживающая', rate: 10, min: 250 }
  ],
  extras: [{ name: 'мытьё окон', unit: 'створка', price: 40 }]
};

export function priceList() {
  try {
    const p = JSON.parse(getSetting('price_list') || 'null');
    return p && Array.isArray(p.services) ? p : DEFAULT_PRICES;
  } catch {
    return DEFAULT_PRICES;
  }
}

/** Возвращает расчёт или null, если данных не хватает. */
export function quote(lead = {}) {
  const pl = priceList();
  const area = Number(String(lead.area_m2 || '').replace(/[^\d.]/g, ''));
  const svc = pl.services.find((s) => s.name === lead.service);
  if (!svc || !area) return null;

  const lines = [{ label: `${svc.name}, ${area} м² × ${svc.rate} ${pl.currency}`, sum: Math.round(area * svc.rate) }];
  let total = lines[0].sum;

  if (svc.min && total < svc.min) {
    lines.push({ label: `минимальный заказ ${svc.min} ${pl.currency}`, sum: svc.min - total });
    total = svc.min;
  }
  return { total, currency: pl.currency, lines };
}

/** Строка для промпта: модель называет готовую сумму, а не считает сама. */
export function quoteHint(lead) {
  const q = quote(lead);
  if (!q) return '';
  return `РАСЧЁТ ПО ПРАЙСУ: ${q.lines.map((l) => l.label).join(' + ')} = ${q.total} ${q.currency}. `
    + 'Называй именно эту сумму, сам ничего не пересчитывай. Говори «примерно» и что точная цена — после осмотра.';
}
