import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const EFFORT = process.env.AI_EFFORT || 'low';
// output_config.effort не поддерживается на Haiku 4.5 — запрос упадёт с 400
const supportsEffort = !MODEL.startsWith('claude-haiku');

let client = null;
export const configured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const label = () => `Anthropic · ${MODEL}`;

const toMessage = (t) => ({
  role: t.role,
  content: t.images?.length
    ? [
        ...t.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })),
        ...(t.text ? [{ type: 'text', text: t.text }] : [])
      ]
    : t.text
});

export async function complete({ system, turns, schema }) {
  client ??= new Anthropic();

  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: supportsEffort ? 8000 : 2000,
    cache_control: { type: 'ephemeral' },   // системный промпт одинаков во всех запросах
    system,
    messages: turns.map(toMessage),
    output_config: {
      ...(supportsEffort ? { effort: EFFORT } : {}),
      format: zodOutputFormat(schema)
    }
  });

  if (res.stop_reason === 'refusal') {
    throw new Error('модель отказалась отвечать: ' + (res.stop_details?.category ?? 'refusal'));
  }
  if (!res.parsed_output) throw new Error('модель вернула ответ не по схеме');

  const u = res.usage ?? {};
  return { out: res.parsed_output, usage: { in: u.input_tokens, cached: u.cache_read_input_tokens ?? 0, out: u.output_tokens } };
}
