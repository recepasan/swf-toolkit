/** Thrown when SWF / ABC binary data is malformed or truncated. */
export class SwfFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwfFormatError';
  }
}

/** Thrown by the P-code assembler, with source position information. */
export class AssemblerError extends Error {
  readonly line: number;
  readonly column: number;
  readonly source?: string;

  constructor(message: string, line: number, column: number, source?: string) {
    super(`${source ? source + ':' : ''}${line}:${column}: ${message}`);
    this.name = 'AssemblerError';
    this.line = line;
    this.column = column;
    this.source = source;
  }
}
