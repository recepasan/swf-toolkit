/**
 * Prints a whole AS3 class (package, imports, fields, methods) from ABC.
 */
import type { AbcFile, Trait } from '../abc/abc-file.js';
import { InstanceFlags, NamespaceKind, TraitAttr, TraitKind } from '../abc/constants.js';
import { scriptOfClass } from '../abc/model.js';
import { decompileMethodBody, decompileMethodStatements, formatDefault, formatParams, typeNameOf, type DecompileEnv } from './method.js';

export interface DecompileClassOptions {
  indentUnit?: string;
}

function modifier(abc: AbcFile, mn: number, isInterface: boolean): string {
  if (isInterface) return '';
  const m = abc.multinames[mn];
  const ns = m ? abc.namespaces[m.ns] : undefined;
  switch (ns?.kind) {
    case NamespaceKind.PrivateNs:
      return 'private ';
    case NamespaceKind.ProtectedNamespace:
    case NamespaceKind.StaticProtectedNs:
      return 'protected ';
    case NamespaceKind.PackageInternalNs:
      return 'internal ';
    case NamespaceKind.Namespace: {
      const uri = abc.strings[ns.name] ?? '';
      const tail = uri.split(/[/:]/).filter(Boolean).pop() ?? 'ns';
      return `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tail) ? tail : 'ns'} `;
    }
    default:
      return 'public ';
  }
}

function metadataLines(abc: AbcFile, t: Trait, indent: string): string[] {
  const out: string[] = [];
  for (const mi of t.metadata) {
    const md = abc.metadata[mi];
    if (!md) continue;
    const items = md.keys.map((k, i) => {
      const v = JSON.stringify(abc.strings[md.values[i]!] ?? '');
      return k ? `${abc.strings[k]}=${v}` : v;
    });
    out.push(`${indent}[${abc.strings[md.name]}${items.length ? `(${items.join(',')})` : ''}]`);
  }
  return out;
}

function traitLines(env: DecompileEnv, t: Trait, isStatic: boolean, isInterface: boolean, indent: string, initText?: string): string[] {
  const { abc } = env;
  const name = abc.multinameName(t.name);
  const mods = `${t.attrs & TraitAttr.Override ? 'override ' : ''}${t.attrs & TraitAttr.Final && !isStatic ? 'final ' : ''}${modifier(abc, t.name, isInterface)}${isStatic ? 'static ' : ''}`;
  const out = metadataLines(abc, t, indent);
  switch (t.kind) {
    case TraitKind.Slot:
    case TraitKind.Const: {
      const kw = t.kind === TraitKind.Const ? 'const' : 'var';
      const init = t.valueIndex ? ` = ${formatDefault(abc, t.valueKind, t.valueIndex)}` : initText !== undefined ? ` = ${initText}` : '';
      out.push(`${indent}${mods}${kw} ${name}:${typeNameOf(env, t.typeName)}${init};`);
      return out;
    }
    case TraitKind.Method:
    case TraitKind.Getter:
    case TraitKind.Setter:
    case TraitKind.Function: {
      const accessor = t.kind === TraitKind.Getter ? 'get ' : t.kind === TraitKind.Setter ? 'set ' : '';
      const m = abc.methods[t.method];
      const ret = m ? typeNameOf(env, m.returnType) : '*';
      const sig = `${indent}${mods}function ${accessor}${name}(${formatParams(env, t.method)}):${ret}`;
      if (isInterface || !abc.methodBody(t.method)) {
        out.push(`${sig};`);
        return out;
      }
      const body = decompileMethodBody(env, t.method, indent);
      out.push(sig, `${indent}{`, ...body.lines, `${indent}}`);
      return out;
    }
    case TraitKind.Class:
      out.push(`${indent}// class ${name}`);
      return out;
  }
  return out;
}

/** Decompiles class `classIndex` to AS3 source text. */
export function decompileClass(abc: AbcFile, classIndex: number, options: DecompileClassOptions = {}): string {
  const unit = options.indentUnit ?? '   ';
  const inst = abc.instances[classIndex];
  const cls = abc.classes[classIndex];
  if (!inst || !cls) throw new Error(`Class index ${classIndex} out of range`);
  const qualified = abc.className(classIndex);
  const dot = qualified.lastIndexOf('.');
  const pkg = dot >= 0 ? qualified.slice(0, dot) : '';
  const shortName = abc.multinameName(inst.name);
  const isInterface = (inst.flags & InstanceFlags.Interface) !== 0;
  const script = scriptOfClass(abc, classIndex);
  const imports = new Set<string>();
  const env: DecompileEnv = {
    abc,
    thisTraits: inst.traits,
    globalTraits: script >= 0 ? abc.scripts[script]!.traits : [],
    imports,
    currentPackage: pkg,
    indentUnit: unit,
  };

  const I1 = unit;
  const I2 = unit + unit;
  const body: string[] = [];

  // Fields first (static, then instance), then methods.
  const slots = (traits: Trait[]): Trait[] => traits.filter((t) => t.kind === TraitKind.Slot || t.kind === TraitKind.Const);
  const methods = (traits: Trait[]): Trait[] => traits.filter((t) => t.kind !== TraitKind.Slot && t.kind !== TraitKind.Const);

  // Static initialiser: leading `NAME = value` assignments become field initialisers.
  const staticInits = new Map<string, string>();
  let cinitLines: string[] = [];
  if (!isInterface && abc.methodBody(cls.cinit)) {
    const cenv = { ...env, thisTraits: cls.traits };
    const r = decompileMethodStatements(cenv, cls.cinit);
    if ('error' in r) {
      cinitLines = decompileMethodBody(cenv, cls.cinit, I2).lines;
    } else {
      const slotNames = new Set(slots(cls.traits).filter((t) => !t.valueIndex).map((t) => abc.multinameName(t.name)));
      let k = 0;
      for (; k < r.stmts.length; k++) {
        const s = r.stmts[k]!;
        if (s.k !== 'expr' || s.e.k !== 'assign' || s.e.op) break;
        const tgt = s.e.target;
        const name = tgt.k === 'name' ? tgt.name : tgt.k === 'member' && (tgt.obj.k === 'this' || tgt.obj.k === 'findprop' || tgt.obj.k === 'global') ? tgt.name : undefined;
        if (!name || !slotNames.has(name) || staticInits.has(name)) break;
        staticInits.set(name, r.printer.expr(s.e.v, 1, I2));
      }
      cinitLines = r.printer.stmts(r.stmts.slice(k), I2 + unit);
    }
  }

  for (const t of slots(cls.traits)) body.push(...traitLines(env, t, true, isInterface, I2, staticInits.get(abc.multinameName(t.name))));
  if (slots(cls.traits).length) body.push('');
  for (const t of slots(inst.traits)) body.push(...traitLines(env, t, false, isInterface, I2));
  if (slots(inst.traits).length) body.push('');
  if (cinitLines.length) body.push(`${I2}{`, ...cinitLines, `${I2}}`, '');

  // Constructor
  if (!isInterface) {
    const ctor = decompileMethodBody(env, inst.iinit, I2);
    const lines = ctor.lines.filter((l, i, all) => !(all.length === 1 && /^\s*super\(\);$/.test(l)));
    body.push(`${I2}public function ${shortName}(${formatParams(env, inst.iinit)})`, `${I2}{`, ...lines, `${I2}}`, '');
  }

  for (const t of methods(cls.traits)) body.push(...traitLines(env, t, true, isInterface, I2), '');
  for (const t of methods(inst.traits)) body.push(...traitLines(env, t, false, isInterface, I2), '');
  while (body.length && body[body.length - 1] === '') body.pop();

  // Header (computed after the body so imports are complete).
  const superName = inst.superName ? typeNameOf(env, inst.superName) : '';
  const ifaces = inst.interfaces.map((i) => typeNameOf(env, i));
  imports.delete(qualified);
  const mods = `${modifier(abc, inst.name, false)}${inst.flags & InstanceFlags.Final ? 'final ' : ''}${!(inst.flags & InstanceFlags.Sealed) && !isInterface ? 'dynamic ' : ''}`;
  let header: string;
  if (isInterface) {
    header = `${I1}${mods}interface ${shortName}${ifaces.length ? ` extends ${ifaces.join(', ')}` : ''}`;
  } else {
    header = `${I1}${mods}class ${shortName}${superName && superName !== 'Object' ? ` extends ${superName}` : ''}${ifaces.length ? ` implements ${ifaces.join(', ')}` : ''}`;
  }

  const out: string[] = [`package${pkg ? ' ' + pkg : ''}`, '{'];
  const sortedImports = [...imports].sort();
  for (const imp of sortedImports) out.push(`${I1}import ${imp};`);
  if (sortedImports.length) out.push('');
  out.push(header, `${I1}{`, '', ...body, `${I1}}`, '}', '');
  return out.join('\n');
}
