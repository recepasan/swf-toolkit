/**
 * Text formatting of constant pool entries for P-code.
 *
 * Syntax (all of it is accepted back by the assembler):
 *   strings     "text" (JSON escapes), null = string index 0
 *   namespaces  PackageNamespace("flash.display"), PrivateNamespace("Foo", 12), * = index 0
 *   multinames  QName(ns, "name"), QNameA(...), RTQName("n"), RTQNameA("n"), RTQNameL(), RTQNameLA(),
 *               Multiname("n", [ns, ...]), MultinameA(...), MultinameL([ns, ...]), MultinameLA(...),
 *               TypeName(QName(...), [QName(...), ...]), * = index 0
 *   values      Integer(1), UInteger(1), Double(1.5), Utf8("s"), True, False, Null, Undefined,
 *               any namespace syntax
 */
import type { AbcFile, Trait } from '../abc-file.js';
import { ConstantKind, MultinameKind, NAMESPACE_KIND_NAMES, NamespaceKind, TraitAttr, TraitKind } from '../constants.js';

export function formatString(abc: AbcFile, index: number): string {
  if (index === 0) return 'null';
  const s = abc.strings[index];
  return s === undefined ? `null ; invalid string index ${index}` : JSON.stringify(s);
}

export function formatDouble(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

export function formatNamespace(abc: AbcFile, index: number): string {
  if (index === 0) return '*';
  const ns = abc.namespaces[index];
  if (!ns) return `* ; invalid namespace index ${index}`;
  const kind = NAMESPACE_KIND_NAMES.get(ns.kind) ?? `Namespace_0x${ns.kind.toString(16)}`;
  const name = formatString(abc, ns.name);
  if (ns.kind === NamespaceKind.PrivateNs) return `${kind}(${name}, ${index})`;
  return `${kind}(${name})`;
}

export function formatNsSet(abc: AbcFile, index: number): string {
  const set = abc.nsSets[index] ?? [];
  return `[${set.map((n) => formatNamespace(abc, n)).join(', ')}]`;
}

export function formatMultiname(abc: AbcFile, index: number): string {
  if (index === 0) return '*';
  const m = abc.multinames[index];
  if (!m) return `* ; invalid multiname index ${index}`;
  const K = MultinameKind;
  switch (m.kind) {
    case K.QName:
      return `QName(${formatNamespace(abc, m.ns)}, ${formatString(abc, m.name)})`;
    case K.QNameA:
      return `QNameA(${formatNamespace(abc, m.ns)}, ${formatString(abc, m.name)})`;
    case K.RTQName:
      return `RTQName(${formatString(abc, m.name)})`;
    case K.RTQNameA:
      return `RTQNameA(${formatString(abc, m.name)})`;
    case K.RTQNameL:
      return 'RTQNameL()';
    case K.RTQNameLA:
      return 'RTQNameLA()';
    case K.Multiname:
      return `Multiname(${formatString(abc, m.name)}, ${formatNsSet(abc, m.nsSet)})`;
    case K.MultinameA:
      return `MultinameA(${formatString(abc, m.name)}, ${formatNsSet(abc, m.nsSet)})`;
    case K.MultinameL:
      return `MultinameL(${formatNsSet(abc, m.nsSet)})`;
    case K.MultinameLA:
      return `MultinameLA(${formatNsSet(abc, m.nsSet)})`;
    case K.TypeName:
      return `TypeName(${formatMultiname(abc, m.base)}, [${m.params.map((p) => formatMultiname(abc, p)).join(', ')}])`;
    default:
      return `* ; unknown multiname kind 0x${m.kind.toString(16)}`;
  }
}

/** Constant value (optional parameter default / slot initial value). */
export function formatValue(abc: AbcFile, kind: number, index: number): string {
  const C = ConstantKind;
  switch (kind) {
    case C.Int:
      return `Integer(${abc.ints[index] ?? 0})`;
    case C.UInt:
      return `UInteger(${abc.uints[index] ?? 0})`;
    case C.Double:
      return `Double(${formatDouble(abc.doubles[index] ?? NaN)})`;
    case C.Utf8:
      return `Utf8(${formatString(abc, index)})`;
    case C.True:
    case C.False:
    case C.Null:
    case C.Undefined: {
      // Compilers store the kind itself as the (unused) index; keep any other value explicit.
      const name = kind === C.True ? 'True' : kind === C.False ? 'False' : kind === C.Null ? 'Null' : 'Undefined';
      return index === kind ? name : `${name}(${index})`;
    }
    default:
      if (NAMESPACE_KIND_NAMES.has(kind)) return formatNamespace(abc, index);
      return `RawValue(${kind}, ${index})`;
  }
}

const TRAIT_KIND_TEXT: Record<number, string> = {
  [TraitKind.Slot]: 'slot',
  [TraitKind.Const]: 'const',
  [TraitKind.Method]: 'method',
  [TraitKind.Getter]: 'getter',
  [TraitKind.Setter]: 'setter',
  [TraitKind.Class]: 'class',
  [TraitKind.Function]: 'function',
};

export const TRAIT_KIND_BY_TEXT = new Map(Object.entries(TRAIT_KIND_TEXT).map(([k, v]) => [v, Number(k)]));

/** One-line trait representation: `trait slot QName(...) slotid 1 type ... value ...`. */
export function formatTrait(abc: AbcFile, t: Trait): string {
  const parts = [`trait ${TRAIT_KIND_TEXT[t.kind] ?? `kind${t.kind}`} ${formatMultiname(abc, t.name)}`];
  switch (t.kind) {
    case TraitKind.Slot:
    case TraitKind.Const:
      parts.push(`slotid ${t.id}`, `type ${formatMultiname(abc, t.typeName)}`);
      if (t.valueIndex !== 0 || t.valueKind !== 0) parts.push(`value ${formatValue(abc, t.valueKind, t.valueIndex)}`);
      break;
    case TraitKind.Class:
      parts.push(`slotid ${t.id}`, `class ${t.classIndex}`);
      break;
    case TraitKind.Function:
      parts.push(`slotid ${t.id}`, `method ${t.method}`);
      break;
    default:
      parts.push(`dispid ${t.id}`, `method ${t.method}`);
  }
  if (t.attrs & TraitAttr.Final) parts.push('final');
  if (t.attrs & TraitAttr.Override) parts.push('override');
  if (t.attrs & TraitAttr.Metadata) parts.push(`metadata [${t.metadata.join(', ')}]`);
  return parts.join(' ');
}
