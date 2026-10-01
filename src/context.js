/**
 * Кто сейчас действует. Запрос из админки идёт от конкретного человека, а бот,
 * напоминания и миграции работают вне запроса — у них пользователя нет.
 * Хранилище контекста избавляет от передачи «кто» через каждую функцию:
 * журнал изменений сам узнаёт автора.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

export const runAs = (user, fn) => store.run({ user }, fn);
export const currentUser = () => store.getStore()?.user ?? null;

/** Имя для журнала: человек из запроса, иначе то, что передал код (бот, система). */
export const actorName = (fallback) => currentUser()?.name ?? fallback;
