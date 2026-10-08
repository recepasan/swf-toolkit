/**
 * ActionScript 3 tokenizer.
 */

export class CompileError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
    readonly source?: string,
  ) {
    super(`${source ? source + ':' : ''}${line}:${column}: ${message}`);
    this.name = 'CompileError';
  }
}

export type TokKind = 'id' | 'kw' | 'num' | 'str' | 'regex' | 'punct' | 'eof';

export interface Tok {
  kind: TokKind;
  value: string;
  /** Numeric value for numbers. */
  num?: number;
  /** Regex flags. */
  flags?: string;
  line: number;
  col: number;
  /** Offset of first char in the source. */
  start: number;
  end: number;
  /** A line terminator precedes this token (for automatic semicolon insertion). */
  nl: boolean;
}

export const KEYWORDS = new Set([
  'as', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'internal',
  'is', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'use', 'var', 'void', 'while', 'with',
]);

const PUNCTS = [
  '>>>=', '...', '===', '!==', '>>>', '<<=', '>>=', '&&=', '||=',
  '::', '.<', '..', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@',
];

const ID_START = /[A-Za-z_$\u00c0-\uffff]/;
const ID_PART = /[A-Za-z0-9_$\u00c0-\uffff]/;

/** Tokens after which a `/` is a division operator rather than a regex. */
function slashIsDivision(prev: Tok | undefined): boolean {
  if (!prev) return false;
  if (prev.kind === 'num' || prev.kind === 'str' || prev.kind === 'regex' || prev.kind === 'id') return true;
  if (prev.kind === 'kw') return ['this', 'super', 'null', 'true', 'false'].includes(prev.value);
  if (prev.kind === 'punct') return [')', ']', '}', '++', '--'].includes(prev.value);
  return false;
}

export function tokenize(src: string, source?: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let nl = false;
  const n = src.length;
  const err = (msg: string, at = i): CompileError => new CompileError(msg, line, at - lineStart + 1, source);

  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      i++;
      line++;
      lineStart = i;
      nl = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\ufeff' || c === '\u00a0') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw err('Unterminated comment');
      for (let k = i; k < end; k++) {
        if (src[k] === '\n') {
          line++;
          lineStart = k + 1;
          nl = true;
        }
      }
      i = end + 2;
      continue;
    }

    const start = i;
    const col = i - lineStart + 1;
    const push = (kind: TokKind, value: string, extra: Partial<Tok> = {}): void => {
      toks.push({ kind, value, line, col, start, end: i, nl, ...extra });
      nl = false;
    };

    // Numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let text: string;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i]!)) i++;
        text = src.slice(start, i);
        push('num', text, { num: parseInt(text.slice(2), 16) });
      } else {
        while (i < n && /[0-9]/.test(src[i]!)) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
          i++;
          while (i < n && /[0-9]/.test(src[i]!)) i++;
        } else if (src[i] === '.' && !/[.A-Za-z_$]/.test(src[i + 1] ?? '')) {
          i++;
        }
        if (src[i] === 'e' || src[i] === 'E') {
          let j = i + 1;
          if (src[j] === '+' || src[j] === '-') j++;
          if (/[0-9]/.test(src[j] ?? '')) {
            i = j;
            while (i < n && /[0-9]/.test(src[i]!)) i++;
          }
        }
        text = src.slice(start, i);
        push('num', text, { num: Number(text) });
      }
      if (i < n && ID_START.test(src[i]!)) throw err('Invalid number literal');
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      i++;
      let out = '';
      while (i < n && src[i] !== c) {
        let ch = src[i]!;
        if (ch === '\n') throw err('Unterminated string');
        if (ch === '\\') {
          i++;
          ch = src[i]!;
          switch (ch) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'v': out += '\v'; break;
            case '0': out += '\0'; break;
            case 'x': out += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16)); i += 2; break;
            case 'u':
              if (src[i + 1] === '{') {
                const close = src.indexOf('}', i);
                out += String.fromCodePoint(parseInt(src.slice(i + 2, close), 16));
                i = close;
              } else {
                out += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
                i += 4;
              }
              break;
            case '\r':
              if (src[i + 1] === '\n') i++;
              break;
            case '\n':
              line++;
              lineStart = i + 1;
              break;
            default: out += ch;
          }
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      if (i >= n) throw err('Unterminated string', start);
      i++;
      push('str', out);
      continue;
    }

    // Regex literal
    if (c === '/' && !slashIsDivision(toks[toks.length - 1])) {
      i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i]!;
        if (ch === '\n') throw err('Unterminated regular expression', start);
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      const body = src.slice(start + 1, i);
      i++;
      const fstart = i;
      while (i < n && /[a-z]/i.test(src[i]!)) i++;
      push('regex', body, { flags: src.slice(fstart, i) });
      continue;
    }

    // Identifiers / keywords
    if (ID_START.test(c) || c === '\\') {
      while (i < n && ID_PART.test(src[i]!)) i++;
      const text = src.slice(start, i);
      push(KEYWORDS.has(text) ? 'kw' : 'id', text);
      continue;
    }

    // Punctuation
    let matched = '';
    for (const p of PUNCTS) {
      if (src.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (!matched) throw err(`Unexpected character '${c}'`);
    // ".<" only starts a type parameter list when followed by an identifier/'*'.
    if (matched === '.<' && !/[\sA-Za-z_$*]/.test(src[i + 2] ?? '')) matched = '.';
    i += matched.length;
    push('punct', matched);
  }
  toks.push({ kind: 'eof', value: '', line, col: i - lineStart + 1, start: i, end: i, nl: true });
  return toks;
}
