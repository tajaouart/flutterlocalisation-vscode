/**
 * A Dart tokenizer that is just precise enough to find string literals: it
 * skips comments, understands every string form (raw, triple quoted,
 * interpolated with nested strings) and reports identifiers and punctuation so
 * the caller can look at what surrounds a literal.
 */

export type TokenKind = 'ident' | 'punct' | 'string' | 'number';

export interface Interpolation {
  /** Source of the expression, without `$` or `${ }`. */
  expr: string;
  /** True for `${...}`, false for `$name`. */
  braced: boolean;
}

export interface StringToken {
  kind: 'string';
  start: number;
  end: number;
  raw: boolean;
  triple: boolean;
  /** Text and interpolations in order; escapes are decoded in the text parts. */
  parts: Array<string | Interpolation>;
}

export interface PlainToken {
  kind: 'ident' | 'punct' | 'number';
  start: number;
  end: number;
  text: string;
}

export type Token = StringToken | PlainToken;

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

const escapes: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
};

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const skipBlockComment = (): void => {
    // Dart block comments nest.
    let depth = 0;
    while (i < src.length) {
      if (src.startsWith('/*', i)) {
        depth++;
        i += 2;
      } else if (src.startsWith('*/', i)) {
        depth--;
        i += 2;
        if (depth === 0) return;
      } else {
        i++;
      }
    }
  };

  /** Reads a string starting at `i` (prefix `r` already consumed if raw). */
  const readString = (start: number, raw: boolean): StringToken => {
    const quote = src[i];
    const triple = src.startsWith(quote.repeat(3), i);
    const delim = triple ? quote.repeat(3) : quote;
    i += delim.length;
    const parts: Array<string | Interpolation> = [];
    let text = '';
    const flush = (): void => {
      if (text) parts.push(text);
      text = '';
    };
    while (i < src.length) {
      if (src.startsWith(delim, i)) {
        i += delim.length;
        flush();
        return { kind: 'string', start, end: i, raw, triple, parts };
      }
      const c = src[i];
      if (!triple && (c === '\n' || c === '\r')) break;
      if (!raw && c === '\\') {
        const n = src[i + 1] ?? '';
        if (n === 'u') {
          const braced = src[i + 2] === '{';
          const hex = braced
            ? src.slice(i + 3, src.indexOf('}', i + 3))
            : src.slice(i + 2, i + 6);
          text += String.fromCodePoint(parseInt(hex, 16) || 0xfffd);
          i += braced ? hex.length + 4 : 6;
        } else if (n === 'x') {
          text += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
          i += 4;
        } else {
          text += escapes[n] ?? n;
          i += 2;
        }
        continue;
      }
      if (!raw && c === '$') {
        if (src[i + 1] === '{') {
          flush();
          const exprStart = i + 2;
          i = exprStart;
          skipBalanced();
          parts.push({ expr: src.slice(exprStart, i - 1).trim(), braced: true });
          continue;
        }
        if (isIdentStart(src[i + 1] ?? '') && src[i + 1] !== '$') {
          flush();
          let j = i + 1;
          while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
          parts.push({ expr: src.slice(i + 1, j), braced: false });
          i = j;
          continue;
        }
      }
      text += c;
      i++;
    }
    // Unterminated: report what we have so offsets stay sane.
    flush();
    return { kind: 'string', start, end: i, raw, triple, parts };
  };

  /** Skips to just past the `}` matching an already consumed `${` or `{`. */
  const skipBalanced = (): void => {
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (src.startsWith('//', i)) {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (src.startsWith('/*', i)) {
        skipBlockComment();
      } else if (c === "'" || c === '"') {
        readString(i, false);
      } else if ((c === 'r' || c === 'R') && (src[i + 1] === "'" || src[i + 1] === '"')) {
        i++;
        readString(i - 1, true);
      } else {
        if (c === '{') depth++;
        if (c === '}') depth--;
        i++;
      }
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (src.startsWith('/*', i)) {
      skipBlockComment();
    } else if ((c === 'r' || c === 'R') && (src[i + 1] === "'" || src[i + 1] === '"')) {
      const start = i;
      i++;
      tokens.push(readString(start, true));
    } else if (c === "'" || c === '"') {
      tokens.push(readString(i, false));
    } else if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i])) i++;
      tokens.push({ kind: 'ident', start, end: i, text: src.slice(start, i) });
    } else if (isDigit(c)) {
      const start = i;
      while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i++;
      tokens.push({ kind: 'number', start, end: i, text: src.slice(start, i) });
    } else {
      tokens.push({ kind: 'punct', start: i, end: i + 1, text: c });
      i++;
    }
  }
  return tokens;
}
