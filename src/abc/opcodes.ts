/**
 * AVM2 instruction set table (AVM2 overview, chapter 5).
 */

export type OperandType =
  /** Unsigned byte. */
  | 'u8'
  /** Signed byte (pushbyte). */
  | 's8'
  /** Generic u30 immediate (slot index, disp id, line number, ...). */
  | 'u30'
  /** Signed 32-bit immediate stored as u30 (pushshort). */
  | 'short'
  /** Argument count (affects stack effect). */
  | 'argc'
  /** Local register index. */
  | 'reg'
  | 'int'
  | 'uint'
  | 'double'
  | 'string'
  | 'namespace'
  | 'multiname'
  | 'method'
  | 'class'
  | 'exception'
  /** s24 branch offset, resolved to a label. */
  | 'branch'
  /** lookupswitch: default + case_count + cases. */
  | 'switch';

export type FlowKind = 'jump' | 'cond' | 'switch' | 'return' | 'throw';

export interface OpInfo {
  code: number;
  name: string;
  operands: OperandType[];
  /** Fixed number of values popped. */
  pop: number;
  /** Extra values popped per argc (0, 1 or 2). */
  popArgc: number;
  /** Pops runtime multiname parts (namespace/name) of the multiname operand. */
  popMn: boolean;
  push: number;
  /** Scope stack delta. */
  scope: number;
  flow?: FlowKind;
}

const table: OpInfo[] = [];
const byName = new Map<string, OpInfo>();

function op(
  code: number,
  name: string,
  operands: OperandType[],
  pop: number,
  push: number,
  extra: { popArgc?: number; popMn?: boolean; scope?: number; flow?: FlowKind } = {},
): void {
  const info: OpInfo = {
    code,
    name,
    operands,
    pop,
    push,
    popArgc: extra.popArgc ?? 0,
    popMn: extra.popMn ?? false,
    scope: extra.scope ?? 0,
    flow: extra.flow,
  };
  table[code] = info;
  byName.set(name, info);
}

const MN = { popMn: true } as const;

op(0x01, 'bkpt', [], 0, 0);
op(0x02, 'nop', [], 0, 0);
op(0x03, 'throw', [], 1, 0, { flow: 'throw' });
op(0x04, 'getsuper', ['multiname'], 1, 1, MN);
op(0x05, 'setsuper', ['multiname'], 2, 0, MN);
op(0x06, 'dxns', ['string'], 0, 0);
op(0x07, 'dxnslate', [], 1, 0);
op(0x08, 'kill', ['reg'], 0, 0);
op(0x09, 'label', [], 0, 0);
op(0x0c, 'ifnlt', ['branch'], 2, 0, { flow: 'cond' });
op(0x0d, 'ifnle', ['branch'], 2, 0, { flow: 'cond' });
op(0x0e, 'ifngt', ['branch'], 2, 0, { flow: 'cond' });
op(0x0f, 'ifnge', ['branch'], 2, 0, { flow: 'cond' });
op(0x10, 'jump', ['branch'], 0, 0, { flow: 'jump' });
op(0x11, 'iftrue', ['branch'], 1, 0, { flow: 'cond' });
op(0x12, 'iffalse', ['branch'], 1, 0, { flow: 'cond' });
op(0x13, 'ifeq', ['branch'], 2, 0, { flow: 'cond' });
op(0x14, 'ifne', ['branch'], 2, 0, { flow: 'cond' });
op(0x15, 'iflt', ['branch'], 2, 0, { flow: 'cond' });
op(0x16, 'ifle', ['branch'], 2, 0, { flow: 'cond' });
op(0x17, 'ifgt', ['branch'], 2, 0, { flow: 'cond' });
op(0x18, 'ifge', ['branch'], 2, 0, { flow: 'cond' });
op(0x19, 'ifstricteq', ['branch'], 2, 0, { flow: 'cond' });
op(0x1a, 'ifstrictne', ['branch'], 2, 0, { flow: 'cond' });
op(0x1b, 'lookupswitch', ['switch'], 1, 0, { flow: 'switch' });
op(0x1c, 'pushwith', [], 1, 0, { scope: 1 });
op(0x1d, 'popscope', [], 0, 0, { scope: -1 });
op(0x1e, 'nextname', [], 2, 1);
op(0x1f, 'hasnext', [], 2, 1);
op(0x20, 'pushnull', [], 0, 1);
op(0x21, 'pushundefined', [], 0, 1);
op(0x23, 'nextvalue', [], 2, 1);
op(0x24, 'pushbyte', ['s8'], 0, 1);
op(0x25, 'pushshort', ['short'], 0, 1);
op(0x26, 'pushtrue', [], 0, 1);
op(0x27, 'pushfalse', [], 0, 1);
op(0x28, 'pushnan', [], 0, 1);
op(0x29, 'pop', [], 1, 0);
op(0x2a, 'dup', [], 1, 2);
op(0x2b, 'swap', [], 2, 2);
op(0x2c, 'pushstring', ['string'], 0, 1);
op(0x2d, 'pushint', ['int'], 0, 1);
op(0x2e, 'pushuint', ['uint'], 0, 1);
op(0x2f, 'pushdouble', ['double'], 0, 1);
op(0x30, 'pushscope', [], 1, 0, { scope: 1 });
op(0x31, 'pushnamespace', ['namespace'], 0, 1);
op(0x32, 'hasnext2', ['reg', 'reg'], 0, 1);
// Alchemy / domain memory opcodes
op(0x35, 'li8', [], 1, 1);
op(0x36, 'li16', [], 1, 1);
op(0x37, 'li32', [], 1, 1);
op(0x38, 'lf32', [], 1, 1);
op(0x39, 'lf64', [], 1, 1);
op(0x3a, 'si8', [], 2, 0);
op(0x3b, 'si16', [], 2, 0);
op(0x3c, 'si32', [], 2, 0);
op(0x3d, 'sf32', [], 2, 0);
op(0x3e, 'sf64', [], 2, 0);
op(0x40, 'newfunction', ['method'], 0, 1);
op(0x41, 'call', ['argc'], 2, 1, { popArgc: 1 });
op(0x42, 'construct', ['argc'], 1, 1, { popArgc: 1 });
op(0x43, 'callmethod', ['u30', 'argc'], 1, 1, { popArgc: 1 });
op(0x44, 'callstatic', ['method', 'argc'], 1, 1, { popArgc: 1 });
op(0x45, 'callsuper', ['multiname', 'argc'], 1, 1, { popArgc: 1, popMn: true });
op(0x46, 'callproperty', ['multiname', 'argc'], 1, 1, { popArgc: 1, popMn: true });
op(0x47, 'returnvoid', [], 0, 0, { flow: 'return' });
op(0x48, 'returnvalue', [], 1, 0, { flow: 'return' });
op(0x49, 'constructsuper', ['argc'], 1, 0, { popArgc: 1 });
op(0x4a, 'constructprop', ['multiname', 'argc'], 1, 1, { popArgc: 1, popMn: true });
op(0x4c, 'callproplex', ['multiname', 'argc'], 1, 1, { popArgc: 1, popMn: true });
op(0x4e, 'callsupervoid', ['multiname', 'argc'], 1, 0, { popArgc: 1, popMn: true });
op(0x4f, 'callpropvoid', ['multiname', 'argc'], 1, 0, { popArgc: 1, popMn: true });
op(0x50, 'sxi1', [], 1, 1);
op(0x51, 'sxi8', [], 1, 1);
op(0x52, 'sxi16', [], 1, 1);
op(0x53, 'applytype', ['argc'], 1, 1, { popArgc: 1 });
op(0x55, 'newobject', ['argc'], 0, 1, { popArgc: 2 });
op(0x56, 'newarray', ['argc'], 0, 1, { popArgc: 1 });
op(0x57, 'newactivation', [], 0, 1);
op(0x58, 'newclass', ['class'], 1, 1);
op(0x59, 'getdescendants', ['multiname'], 1, 1, MN);
op(0x5a, 'newcatch', ['exception'], 0, 1);
op(0x5d, 'findpropstrict', ['multiname'], 0, 1, MN);
op(0x5e, 'findproperty', ['multiname'], 0, 1, MN);
op(0x5f, 'finddef', ['multiname'], 0, 1);
op(0x60, 'getlex', ['multiname'], 0, 1);
op(0x61, 'setproperty', ['multiname'], 2, 0, MN);
op(0x62, 'getlocal', ['reg'], 0, 1);
op(0x63, 'setlocal', ['reg'], 1, 0);
op(0x64, 'getglobalscope', [], 0, 1);
op(0x65, 'getscopeobject', ['u8'], 0, 1);
op(0x66, 'getproperty', ['multiname'], 1, 1, MN);
op(0x67, 'getouterscope', ['u30'], 0, 1);
op(0x68, 'initproperty', ['multiname'], 2, 0, MN);
op(0x6a, 'deleteproperty', ['multiname'], 1, 1, MN);
op(0x6c, 'getslot', ['u30'], 1, 1);
op(0x6d, 'setslot', ['u30'], 2, 0);
op(0x6e, 'getglobalslot', ['u30'], 0, 1);
op(0x6f, 'setglobalslot', ['u30'], 1, 0);
op(0x70, 'convert_s', [], 1, 1);
op(0x71, 'esc_xelem', [], 1, 1);
op(0x72, 'esc_xattr', [], 1, 1);
op(0x73, 'convert_i', [], 1, 1);
op(0x74, 'convert_u', [], 1, 1);
op(0x75, 'convert_d', [], 1, 1);
op(0x76, 'convert_b', [], 1, 1);
op(0x77, 'convert_o', [], 1, 1);
op(0x78, 'checkfilter', [], 1, 1);
op(0x80, 'coerce', ['multiname'], 1, 1);
op(0x81, 'coerce_b', [], 1, 1);
op(0x82, 'coerce_a', [], 1, 1);
op(0x83, 'coerce_i', [], 1, 1);
op(0x84, 'coerce_d', [], 1, 1);
op(0x85, 'coerce_s', [], 1, 1);
op(0x86, 'astype', ['multiname'], 1, 1);
op(0x87, 'astypelate', [], 2, 1);
op(0x88, 'coerce_u', [], 1, 1);
op(0x89, 'coerce_o', [], 1, 1);
op(0x90, 'negate', [], 1, 1);
op(0x91, 'increment', [], 1, 1);
op(0x92, 'inclocal', ['reg'], 0, 0);
op(0x93, 'decrement', [], 1, 1);
op(0x94, 'declocal', ['reg'], 0, 0);
op(0x95, 'typeof', [], 1, 1);
op(0x96, 'not', [], 1, 1);
op(0x97, 'bitnot', [], 1, 1);
op(0xa0, 'add', [], 2, 1);
op(0xa1, 'subtract', [], 2, 1);
op(0xa2, 'multiply', [], 2, 1);
op(0xa3, 'divide', [], 2, 1);
op(0xa4, 'modulo', [], 2, 1);
op(0xa5, 'lshift', [], 2, 1);
op(0xa6, 'rshift', [], 2, 1);
op(0xa7, 'urshift', [], 2, 1);
op(0xa8, 'bitand', [], 2, 1);
op(0xa9, 'bitor', [], 2, 1);
op(0xaa, 'bitxor', [], 2, 1);
op(0xab, 'equals', [], 2, 1);
op(0xac, 'strictequals', [], 2, 1);
op(0xad, 'lessthan', [], 2, 1);
op(0xae, 'lessequals', [], 2, 1);
op(0xaf, 'greaterthan', [], 2, 1);
op(0xb0, 'greaterequals', [], 2, 1);
op(0xb1, 'instanceof', [], 2, 1);
op(0xb2, 'istype', ['multiname'], 1, 1);
op(0xb3, 'istypelate', [], 2, 1);
op(0xb4, 'in', [], 2, 1);
op(0xc0, 'increment_i', [], 1, 1);
op(0xc1, 'decrement_i', [], 1, 1);
op(0xc2, 'inclocal_i', ['reg'], 0, 0);
op(0xc3, 'declocal_i', ['reg'], 0, 0);
op(0xc4, 'negate_i', [], 1, 1);
op(0xc5, 'add_i', [], 2, 1);
op(0xc6, 'subtract_i', [], 2, 1);
op(0xc7, 'multiply_i', [], 2, 1);
op(0xd0, 'getlocal0', [], 0, 1);
op(0xd1, 'getlocal1', [], 0, 1);
op(0xd2, 'getlocal2', [], 0, 1);
op(0xd3, 'getlocal3', [], 0, 1);
op(0xd4, 'setlocal0', [], 1, 0);
op(0xd5, 'setlocal1', [], 1, 0);
op(0xd6, 'setlocal2', [], 1, 0);
op(0xd7, 'setlocal3', [], 1, 0);
op(0xef, 'debug', ['u8', 'string', 'u8', 'u30'], 0, 0);
op(0xf0, 'debugline', ['u30'], 0, 0);
op(0xf1, 'debugfile', ['string'], 0, 0);
op(0xf2, 'bkptline', ['u30'], 0, 0);
op(0xf3, 'timestamp', [], 0, 0);

export function opInfo(code: number): OpInfo | undefined {
  return table[code];
}

export function opByName(name: string): OpInfo | undefined {
  return byName.get(name);
}

export const Op = Object.fromEntries([...byName].map(([name, info]) => [name, info.code])) as Record<string, number>;
