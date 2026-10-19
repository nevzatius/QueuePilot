import { messages, type MessageKey } from './messages';

export type { MessageKey };

/** Looks up a UI string and fills `{name}` placeholders. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template: string = messages[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Typed lookup for dynamic keys such as `status.${status}`; falls back to the raw value. */
export function tDynamic(prefix: string, value: string): string {
  const key = `${prefix}.${value}`;
  return key in messages ? t(key as MessageKey) : value;
}
