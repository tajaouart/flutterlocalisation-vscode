import { Placeholder } from './hardcoded';

export type Arb = Record<string, unknown>;

export function parseArb(text: string): Arb {
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('An ARB file must hold a JSON object.');
  return v as Arb;
}

/** Message keys, without `@key` metadata and `@@locale`-style entries. */
export function messageKeys(arb: Arb): string[] {
  return Object.keys(arb).filter((k) => !k.startsWith('@'));
}

/** The key that already holds exactly [message], if any. */
export function keyForMessage(arb: Arb, message: string): string | undefined {
  return messageKeys(arb).find((k) => arb[k] === message);
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'at', 'is', 'are', 'your', 'you']);

/** A camelCase key built from the first words of [message], unique in [arb]. */
export function suggestKey(message: string, arb: Arb): string {
  const words = message
    .replace(/\{[^}]*\}/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w));
  const picked = (meaningful.length ? meaningful : words).slice(0, 4);
  let base = picked.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
  if (!base) base = 'message';
  if (/^[0-9]/.test(base)) base = `text${base[0].toUpperCase()}${base.slice(1)}`;
  let key = base;
  let n = 2;
  while (key in arb) key = `${base}${n++}`;
  return key;
}

export const KEY_PATTERN = /^[a-z][A-Za-z0-9_]*$/;

/**
 * [text] with the message added at the end of the object. The rest of the file
 * is left byte for byte as it was, so a file the backend or a teammate
 * formatted does not get rewritten.
 */
export function insertMessage(
  text: string,
  key: string,
  message: string,
  placeholders: Placeholder[],
  withMetadata: boolean,
): string {
  const arb = parseArb(text);
  if (key in arb) throw new Error(`The key "${key}" already exists.`);
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const close = text.lastIndexOf('}');
  const body = text.slice(0, close).replace(/\s+$/, '');
  const empty = body.trim() === '{';

  const entries: string[] = [`${indent}${JSON.stringify(key)}: ${JSON.stringify(message)}`];
  if (withMetadata || placeholders.length) {
    const meta: Record<string, unknown> = {};
    if (placeholders.length) {
      meta.placeholders = Object.fromEntries(placeholders.map((p) => [p.name, { type: 'Object' }]));
    }
    const json = JSON.stringify(meta, null, indent.length ? indent : 2)
      .split('\n')
      .map((l, i) => (i === 0 ? l : indent + l))
      .join(nl);
    entries.push(`${indent}${JSON.stringify(`@${key}`)}: ${json}`);
  }
  const out = `${body}${empty ? '' : ','}${nl}${entries.join(`,${nl}`)}${nl}}${text.slice(close + 1)}`;
  parseArb(out);
  return out.endsWith('\n') ? out : `${out}${nl}`;
}

/** Keys of [template] that [other] has no translation for. */
export function missingKeys(template: Arb, other: Arb): string[] {
  return messageKeys(template).filter((k) => typeof other[k] !== 'string' || other[k] === '');
}

/**
 * Locale of an ARB file: its `@@locale`, else what follows [prefix] (the part of
 * the template's name before its own locale, `app_` for `app_en.arb`).
 */
export function arbLocale(fileName: string, prefix: string, arb?: Arb): string | undefined {
  const declared = arb?.['@@locale'];
  if (typeof declared === 'string') return declared;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.arb')) return undefined;
  return fileName.slice(prefix.length, -'.arb'.length) || undefined;
}

/** `app_` for a template `app_en.arb` whose locale is `en`. */
export function arbPrefix(templateName: string, template?: Arb): string {
  const declared = template?.['@@locale'];
  if (typeof declared === 'string' && templateName.endsWith(`${declared}.arb`)) {
    return templateName.slice(0, -`${declared}.arb`.length);
  }
  const m = /^(.*_)[a-zA-Z]{2,3}\.arb$/.exec(templateName);
  return m ? m[1] : templateName.replace(/[a-zA-Z_-]*\.arb$/, '');
}
