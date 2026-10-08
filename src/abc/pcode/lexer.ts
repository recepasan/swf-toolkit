import { AssemblerError } from '../../errors.js';

export type TokenType = 'id' | 'num' | 'str' | 'punct' | 'offset';

export interface Token {
  type: TokenType;
  /** Identifier text, punctuation char, or original number text. */
  text: string;
  /** Parsed value for numbers / strings / offsets. */
  value?: number | string;
  col: number;
}

const PUNCT = new Set(['(', ')', '[', ']', ',', ':', '|', '*']);
const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$.]/;
const NUM_RE = /^-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/** Tokenises one line of P-code. `;` starts a comment outside of strings. */
export function tokenizeLine(line: string, lineNo: number, source?: string): Token[] {
  const tokens: Token[] = [];
  const trimmed = line.trimStart();
  if (trimmed.startsWith('.bytes')) {
    // Raw byte directive: `.bytes 0a ff 3c ; comment`
    const indent = line.length - trimmed.length;
    tokens.push({ type: 'id', text: '.bytes', col: indent + 1 });
    const re = /[^\s;]+|;/g;
    let m: RegExpExecArray | null;
    re.lastIndex = indent + 6;
    while ((m = re.exec(line))) {
      if (m[0] === ';') break;
      tokens.push({ type: 'id', text: m[0], col: m.index + 1 });
    }
    return tokens;
  }
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === ';') break;
    const col = i + 1;
    if (c === '"') {
      let j = i + 1;
      while (j < n && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      if (j >= n) throw new AssemblerError('Unterminated string', lineNo, col, source);
      const text = line.slice(i, j + 1);
      let value: string;
      try {
        value = JSON.parse(text) as string;
      } catch {
        throw new AssemblerError(`Invalid string literal ${text}`, lineNo, col, source);
      }
      tokens.push({ type: 'str', text, value, col });
      i = j + 1;
      continue;
    }
    if (c === '@') {
      const m = /^@(\d+)/.exec(line.slice(i));
      if (!m) throw new AssemblerError('Expected byte offset after @', lineNo, col, source);
      tokens.push({ type: 'offset', text: m[0], value: Number(m[1]), col });
      i += m[0].length;
      continue;
    }
    const rest = line.slice(i);
    if (/[-0-9.]/.test(c)) {
      if (rest.startsWith('-Infinity')) {
        tokens.push({ type: 'num', text: '-Infinity', value: -Infinity, col });
        i += 9;
        continue;
      }
      const m = NUM_RE.exec(rest);
      if (m) {
        const text = m[0];
        const neg = text.startsWith('-');
        const body = neg ? text.slice(1) : text;
        let value = body.startsWith('0x') ? parseInt(body.slice(2), 16) : Number(body);
        if (neg) value = -value;
        tokens.push({ type: 'num', text, value, col });
        i += text.length;
        continue;
      }
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(line[j]!)) j++;
      const text = line.slice(i, j);
      if (text === 'NaN' || text === 'Infinity') tokens.push({ type: 'num', text, value: text === 'NaN' ? NaN : Infinity, col });
      else tokens.push({ type: 'id', text, col });
      i = j;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ type: 'punct', text: c, col });
      i++;
      continue;
    }
    throw new AssemblerError(`Unexpected character '${c}'`, lineNo, col, source);
  }
  return tokens;
}

/** Cursor over the tokens of one line. */
export class LineCursor {
  pos = 0;
  constructor(
    readonly tokens: Token[],
    readonly line: number,
    readonly source?: string,
  ) {}

  get done(): boolean {
    return this.pos >= this.tokens.length;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  error(message: string, tok: Token | undefined = this.peek()): AssemblerError {
    const col = tok?.col ?? (this.tokens.length ? this.tokens[this.tokens.length - 1]!.col + this.tokens[this.tokens.length - 1]!.text.length : 1);
    return new AssemblerError(message, this.line, col, this.source);
  }

  next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw this.error('Unexpected end of line');
    this.pos++;
    return t;
  }

  isPunct(p: string): boolean {
    const t = this.peek();
    return t?.type === 'punct' && t.text === p;
  }

  isId(text?: string): boolean {
    const t = this.peek();
    return t?.type === 'id' && (text === undefined || t.text === text);
  }

  punct(p: string): void {
    const t = this.next();
    if (t.type !== 'punct' || t.text !== p) throw this.error(`Expected '${p}'`, t);
  }

  tryPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.pos++;
      return true;
    }
    return false;
  }

  id(expected?: string): string {
    const t = this.next();
    if (t.type !== 'id' || (expected !== undefined && t.text !== expected)) {
      throw this.error(expected ? `Expected '${expected}'` : 'Expected identifier', t);
    }
    return t.text;
  }

  number(): number {
    const t = this.next();
    if (t.type !== 'num') throw this.error('Expected number', t);
    return t.value as number;
  }

  integer(min = -Infinity, max = Infinity): number {
    const tok = this.peek();
    const v = this.number();
    if (!Number.isInteger(v) || v < min || v > max) throw this.error(`Expected integer in range ${min}..${max}`, tok);
    return v;
  }

  /** String literal or `null`. */
  stringOrNull(): string | null {
    const t = this.next();
    if (t.type === 'str') return t.value as string;
    if (t.type === 'id' && t.text === 'null') return null;
    throw this.error('Expected string or null', t);
  }

  end(): void {
    if (!this.done) throw this.error(`Unexpected '${this.peek()!.text}'`);
  }
}
