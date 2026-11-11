import { Interpolation, StringToken, Token, tokenize } from './dartLexer';

export interface Placeholder {
  /** ARB placeholder name. */
  name: string;
  /** Dart expression passed for it. */
  expr: string;
}

export interface Candidate {
  start: number;
  end: number;
  /** ARB message text, with `{name}` for each placeholder. */
  message: string;
  placeholders: Placeholder[];
  /** Plain text shown in the diagnostic. */
  preview: string;
  /** Offsets of every enclosing `const` that has to go once the literal becomes a call. */
  constStarts: number[];
}

/** Widgets whose first positional argument is the text the user reads. */
const TEXT_WIDGETS = new Set(['Text', 'SelectableText', 'TextSpan']);

/** Named arguments that take text the user reads. */
const TEXT_ARGS = new Set([
  'text',
  'label',
  'labelText',
  'hintText',
  'helperText',
  'errorText',
  'counterText',
  'prefixText',
  'suffixText',
  'title',
  'subtitle',
  'tooltip',
  'message',
  'semanticLabel',
  'semanticsLabel',
]);

const IGNORE_MARK = /l10n-ignore/;

/**
 * Finds string literals in [src] that are shown to the user: the text of a
 * `Text`-like widget or a label-like named argument. Everything else (map keys,
 * routes, logs, asset paths) is left alone, which keeps false positives low.
 */
export function findHardcodedStrings(src: string): Candidate[] {
  const tokens = tokenize(src);
  const out: Candidate[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'string') continue;
    if (!isUserFacingPosition(tokens, k)) continue;
    const next = tokens[k + 1];
    // 'Hello ' + name, or adjacent literals: not a single message.
    if (next && (next.kind === 'string' || isPunct(next, '+'))) continue;
    if (t.raw || t.triple) continue;
    if (lineHasIgnoreMark(src, t.start)) continue;
    const built = buildMessage(t);
    if (!built || !looksLikeProse(built.preview)) continue;
    out.push({
      start: t.start,
      end: t.end,
      ...built,
      constStarts: findConsts(tokens, k),
    });
  }
  return out;
}

/** The literal at [offset], if it can become an ARB message, wherever it is. */
export function stringAt(src: string, offset: number): Candidate | undefined {
  const tokens = tokenize(src);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'string' || offset < t.start || offset > t.end) continue;
    if (t.raw || t.triple) return undefined;
    const built = buildMessage(t);
    if (!built || !built.preview.trim()) return undefined;
    return { start: t.start, end: t.end, ...built, constStarts: findConsts(tokens, k) };
  }
  return undefined;
}

function isPunct(t: Token | undefined, text: string): boolean {
  return !!t && t.kind === 'punct' && t.text === text;
}

function isIdent(t: Token | undefined, text?: string): boolean {
  return !!t && t.kind === 'ident' && (text === undefined || t.text === text);
}

function isUserFacingPosition(tokens: Token[], k: number): boolean {
  const prev = tokens[k - 1];
  const prev2 = tokens[k - 2];
  const prev3 = tokens[k - 3];
  // Text('...'), const Text('...'), m.Text('...').
  if (isPunct(prev, '(') && prev2?.kind === 'ident' && TEXT_WIDGETS.has(prev2.text)) {
    return true;
  }
  // label: '...' inside an argument list, not `cond ? label : '...'`.
  if (isPunct(prev, ':') && prev2?.kind === 'ident' && TEXT_ARGS.has(prev2.text)) {
    return isPunct(prev3, '(') || isPunct(prev3, ',');
  }
  return false;
}

/**
 * Every `const` that makes an expression around token [k] constant: the one
 * before the constructor holding it, and any before an enclosing call or
 * collection literal (`children: const [Text('...')]`).
 */
function findConsts(tokens: Token[], k: number): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let j = k - 1; j >= 0; j--) {
    const t = tokens[j];
    if (isPunct(t, ')') || isPunct(t, ']') || isPunct(t, '}')) {
      depth++;
      continue;
    }
    if (!(isPunct(t, '(') || isPunct(t, '[') || isPunct(t, '{'))) continue;
    if (depth > 0) {
      depth--;
      continue;
    }
    // t opens a group that encloses the literal.
    if (isPunct(t, '{') && isPunct(tokens[j - 1], ')')) break; // a function body
    let m = j - 1;
    if (isPunct(t, '(')) {
      // const Foo( / const Foo.named( / const prefix.Foo(
      while (m >= 1 && isIdent(tokens[m]) && isPunct(tokens[m - 1], '.')) m -= 2;
      if (!isIdent(tokens[m])) continue;
      m--;
    } else if (isPunct(tokens[m], '>')) {
      // const <Widget>[
      let angle = 0;
      for (; m >= 0; m--) {
        if (isPunct(tokens[m], '>')) angle++;
        else if (isPunct(tokens[m], '<') && --angle === 0) break;
      }
      m--;
    }
    if (isIdent(tokens[m], 'const')) found.push(tokens[m].start);
  }
  return found;
}

function lineHasIgnoreMark(src: string, offset: number): boolean {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  const prevStart = src.lastIndexOf('\n', lineStart - 2) + 1;
  const lineEnd = src.indexOf('\n', offset);
  const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const prevLine = lineStart > 0 ? src.slice(prevStart, lineStart) : '';
  return IGNORE_MARK.test(line) || /^\s*\/\/.*l10n-ignore/.test(prevLine);
}

function looksLikeProse(text: string): boolean {
  const t = text.trim();
  if (!/\p{L}/u.test(t)) return false;
  if (/^(https?:|mailto:|tel:|assets\/|packages\/)/i.test(t)) return false;
  // identifiers, routes and file names: no spaces, and a separator in them
  if (!/\s/.test(t) && /[_/.]/.test(t)) return false;
  return true;
}

function buildMessage(
  t: StringToken,
): Pick<Candidate, 'message' | 'placeholders' | 'preview'> | undefined {
  const placeholders: Placeholder[] = [];
  let message = '';
  let preview = '';
  for (const part of t.parts) {
    if (typeof part === 'string') {
      // A brace in the text would be read as ICU syntax by gen-l10n.
      if (/[{}]/.test(part)) return undefined;
      message += part;
      preview += part;
    } else {
      const name = uniqueName(placeholderName(part), placeholders);
      placeholders.push({ name, expr: part.expr });
      message += `{${name}}`;
      preview += `{${name}}`;
    }
  }
  return { message, placeholders, preview };
}

function placeholderName(p: Interpolation): string {
  const dotted = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
  if (!dotted.test(p.expr)) return 'value';
  const segs = p.expr.split('.').filter((s) => s !== 'this' && s !== 'widget');
  const words = segs.slice(-2);
  const name = words
    .map((w, i) => (i === 0 ? w.replace(/^_+/, '') : w[0].toUpperCase() + w.slice(1)))
    .join('');
  return name || 'value';
}

function uniqueName(base: string, taken: Placeholder[]): string {
  let name = base;
  let n = 2;
  while (taken.some((p) => p.name === name)) name = `${base}${n++}`;
  return name;
}
