import { ByteReader } from '../io/reader.js';
import { ByteWriter } from '../io/writer.js';
import { SwfFormatError } from '../errors.js';
import { InstanceFlags, MethodFlags, MultinameKind, NamespaceKind, TraitAttr, TraitKind } from './constants.js';

// ---------------------------------------------------------------------------
// Data model (index based, mirrors the ABC file layout)
// ---------------------------------------------------------------------------

export interface NamespaceInfo {
  kind: number;
  /** String pool index (0 = no name). */
  name: number;
}

/**
 * A multiname pool entry. Only the fields relevant for `kind` are meaningful:
 * - QName(A): ns, name
 * - RTQName(A): name
 * - RTQNameL(A): –
 * - Multiname(A): name, nsSet
 * - MultinameL(A): nsSet
 * - TypeName: base, params
 */
export interface MultinameInfo {
  kind: number;
  ns: number;
  name: number;
  nsSet: number;
  base: number;
  params: number[];
}

export interface OptionalParam {
  kind: number;
  value: number;
}

export interface MethodInfo {
  paramTypes: number[];
  returnType: number;
  name: number;
  flags: number;
  optional: OptionalParam[];
  paramNames: number[];
}

export interface MetadataInfo {
  name: number;
  keys: number[];
  values: number[];
}

export interface Trait {
  name: number;
  kind: number;
  /** Upper 4 bits of the kind byte (Final / Override / Metadata). */
  attrs: number;
  /** slot_id for Slot/Const/Class/Function, disp_id for Method/Getter/Setter. */
  id: number;
  /** Slot/Const: type multiname. */
  typeName: number;
  /** Slot/Const: default value index (0 = none). */
  valueIndex: number;
  /** Slot/Const: default value kind (only if valueIndex != 0). */
  valueKind: number;
  /** Class: class index. */
  classIndex: number;
  /** Method/Getter/Setter/Function: method index. */
  method: number;
  metadata: number[];
}

export interface InstanceInfo {
  name: number;
  superName: number;
  flags: number;
  protectedNs: number;
  interfaces: number[];
  iinit: number;
  traits: Trait[];
}

export interface ClassInfo {
  cinit: number;
  traits: Trait[];
}

export interface ScriptInfo {
  init: number;
  traits: Trait[];
}

export interface ExceptionInfo {
  from: number;
  to: number;
  target: number;
  excType: number;
  varName: number;
}

export interface MethodBody {
  method: number;
  maxStack: number;
  localCount: number;
  initScopeDepth: number;
  maxScopeDepth: number;
  code: Uint8Array;
  exceptions: ExceptionInfo[];
  traits: Trait[];
}

export function emptyMultiname(kind = 0): MultinameInfo {
  return { kind, ns: 0, name: 0, nsSet: 0, base: 0, params: [] };
}

export function newTrait(partial: Partial<Trait> & { name: number; kind: number }): Trait {
  return {
    attrs: 0,
    id: 0,
    typeName: 0,
    valueIndex: 0,
    valueKind: 0,
    classIndex: 0,
    method: 0,
    metadata: [],
    ...partial,
  };
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const utf8Lossy = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

/** Simple pool lookup cache that tolerates direct pushes to the pool array. */
class PoolCache<T> {
  private map = new Map<string, number>();
  private scanned = 0;
  constructor(
    private readonly pool: () => T[],
    private readonly key: (v: T) => string,
    private readonly first = 1,
  ) {}

  find(k: string): number {
    const pool = this.pool();
    if (this.scanned > pool.length) {
      this.map.clear();
      this.scanned = 0;
    }
    for (let i = Math.max(this.scanned, this.first); i < pool.length; i++) {
      const pk = this.key(pool[i]!);
      if (!this.map.has(pk)) this.map.set(pk, i);
    }
    this.scanned = pool.length;
    const hit = this.map.get(k);
    if (hit !== undefined) {
      if (hit < pool.length && this.key(pool[hit]!) === k) return hit;
      // Entry was modified in place: rebuild.
      this.map.clear();
      this.scanned = 0;
      return this.find(k);
    }
    return -1;
  }
}

const nsKey = (n: NamespaceInfo): string => `${n.kind}:${n.name}`;
const nsSetKey = (s: number[]): string => s.join(',');
const mnKey = (m: MultinameInfo): string => `${m.kind}:${m.ns}:${m.name}:${m.nsSet}:${m.base}:${m.params.join(',')}`;

/** A parsed ActionScript Byte Code (ABC) file. */
export class AbcFile {
  minorVersion = 16;
  majorVersion = 46;

  ints: number[] = [0];
  uints: number[] = [0];
  doubles: number[] = [NaN];
  strings: string[] = [''];
  namespaces: NamespaceInfo[] = [{ kind: 0, name: 0 }];
  nsSets: number[][] = [[]];
  multinames: MultinameInfo[] = [emptyMultiname()];

  methods: MethodInfo[] = [];
  metadata: MetadataInfo[] = [];
  instances: InstanceInfo[] = [];
  classes: ClassInfo[] = [];
  scripts: ScriptInfo[] = [];
  bodies: MethodBody[] = [];

  /** Raw bytes of strings that are not valid UTF-8, keyed by pool index. */
  private rawStrings = new Map<number, { decoded: string; bytes: Uint8Array }>();
  /** Pools whose count was written as 1 (instead of 0) while empty; preserved for exact round-trips. */
  private onePools = new Set<string>();

  private readonly intCache = new PoolCache(() => this.ints, (v) => String(v));
  private readonly uintCache = new PoolCache(() => this.uints, (v) => String(v));
  private readonly doubleCache = new PoolCache(() => this.doubles, (v) => (Object.is(v, -0) ? '-0' : String(v)));
  private readonly stringCache = new PoolCache(() => this.strings, (v) => v);
  private readonly nsCache = new PoolCache(() => this.namespaces, nsKey);
  private readonly nsSetCache = new PoolCache(() => this.nsSets, nsSetKey);
  private readonly mnCache = new PoolCache(() => this.multinames, mnKey);

  private bodyIndex: Map<number, number> | undefined;
  private bodyIndexSize = -1;

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  static parse(bytes: Uint8Array): AbcFile {
    const r = new ByteReader(bytes);
    const abc = new AbcFile();
    const u30 = (): number => r.encodedU32();

    abc.minorVersion = r.u16();
    abc.majorVersion = r.u16();

    let n = u30();
    if (n === 1) abc.onePools.add('ints');
    for (let i = 1; i < n; i++) abc.ints.push(u30() | 0);
    n = u30();
    if (n === 1) abc.onePools.add('uints');
    for (let i = 1; i < n; i++) abc.uints.push(u30() >>> 0);
    n = u30();
    if (n === 1) abc.onePools.add('doubles');
    for (let i = 1; i < n; i++) abc.doubles.push(r.f64());
    n = u30();
    if (n === 1) abc.onePools.add('strings');
    for (let i = 1; i < n; i++) {
      const len = u30();
      const raw = r.bytesView(len);
      let s: string;
      try {
        s = utf8Strict.decode(raw);
      } catch {
        s = utf8Lossy.decode(raw);
        abc.rawStrings.set(i, { decoded: s, bytes: raw.slice() });
      }
      abc.strings.push(s);
    }
    n = u30();
    if (n === 1) abc.onePools.add('namespaces');
    for (let i = 1; i < n; i++) abc.namespaces.push({ kind: r.u8(), name: u30() });
    n = u30();
    if (n === 1) abc.onePools.add('nsSets');
    for (let i = 1; i < n; i++) {
      const c = u30();
      const set: number[] = [];
      for (let j = 0; j < c; j++) set.push(u30());
      abc.nsSets.push(set);
    }
    n = u30();
    if (n === 1) abc.onePools.add('multinames');
    for (let i = 1; i < n; i++) {
      const kind = r.u8();
      const m = emptyMultiname(kind);
      switch (kind) {
        case MultinameKind.QName:
        case MultinameKind.QNameA:
          m.ns = u30();
          m.name = u30();
          break;
        case MultinameKind.RTQName:
        case MultinameKind.RTQNameA:
          m.name = u30();
          break;
        case MultinameKind.RTQNameL:
        case MultinameKind.RTQNameLA:
          break;
        case MultinameKind.Multiname:
        case MultinameKind.MultinameA:
          m.name = u30();
          m.nsSet = u30();
          break;
        case MultinameKind.MultinameL:
        case MultinameKind.MultinameLA:
          m.nsSet = u30();
          break;
        case MultinameKind.TypeName: {
          m.base = u30();
          const c = u30();
          for (let j = 0; j < c; j++) m.params.push(u30());
          break;
        }
        default:
          throw new SwfFormatError(`Unknown multiname kind 0x${kind.toString(16)} at pool index ${i}`);
      }
      abc.multinames.push(m);
    }

    n = u30();
    for (let i = 0; i < n; i++) {
      const paramCount = u30();
      const returnType = u30();
      const paramTypes: number[] = [];
      for (let j = 0; j < paramCount; j++) paramTypes.push(u30());
      const name = u30();
      const flags = r.u8();
      const optional: OptionalParam[] = [];
      if (flags & MethodFlags.HAS_OPTIONAL) {
        const c = u30();
        for (let j = 0; j < c; j++) {
          const value = u30();
          optional.push({ value, kind: r.u8() });
        }
      }
      const paramNames: number[] = [];
      if (flags & MethodFlags.HAS_PARAM_NAMES) for (let j = 0; j < paramCount; j++) paramNames.push(u30());
      abc.methods.push({ paramTypes, returnType, name, flags, optional, paramNames });
    }

    n = u30();
    for (let i = 0; i < n; i++) {
      const name = u30();
      const c = u30();
      const keys: number[] = [];
      const values: number[] = [];
      for (let j = 0; j < c; j++) keys.push(u30());
      for (let j = 0; j < c; j++) values.push(u30());
      abc.metadata.push({ name, keys, values });
    }

    const readTraits = (): Trait[] => {
      const c = u30();
      const traits: Trait[] = [];
      for (let j = 0; j < c; j++) {
        const name = u30();
        const kindByte = r.u8();
        const t = newTrait({ name, kind: kindByte & 0x0f, attrs: kindByte >> 4 });
        switch (t.kind) {
          case TraitKind.Slot:
          case TraitKind.Const:
            t.id = u30();
            t.typeName = u30();
            t.valueIndex = u30();
            if (t.valueIndex !== 0) t.valueKind = r.u8();
            break;
          case TraitKind.Class:
            t.id = u30();
            t.classIndex = u30();
            break;
          case TraitKind.Function:
            t.id = u30();
            t.method = u30();
            break;
          case TraitKind.Method:
          case TraitKind.Getter:
          case TraitKind.Setter:
            t.id = u30();
            t.method = u30();
            break;
          default:
            throw new SwfFormatError(`Unknown trait kind ${t.kind}`);
        }
        if (t.attrs & TraitAttr.Metadata) {
          const mc = u30();
          for (let k = 0; k < mc; k++) t.metadata.push(u30());
        }
        traits.push(t);
      }
      return traits;
    };

    const classCount = u30();
    for (let i = 0; i < classCount; i++) {
      const name = u30();
      const superName = u30();
      const flags = r.u8();
      const protectedNs = flags & InstanceFlags.ProtectedNs ? u30() : 0;
      const ic = u30();
      const interfaces: number[] = [];
      for (let j = 0; j < ic; j++) interfaces.push(u30());
      const iinit = u30();
      abc.instances.push({ name, superName, flags, protectedNs, interfaces, iinit, traits: readTraits() });
    }
    for (let i = 0; i < classCount; i++) {
      const cinit = u30();
      abc.classes.push({ cinit, traits: readTraits() });
    }

    n = u30();
    for (let i = 0; i < n; i++) {
      const init = u30();
      abc.scripts.push({ init, traits: readTraits() });
    }

    n = u30();
    for (let i = 0; i < n; i++) {
      const method = u30();
      const maxStack = u30();
      const localCount = u30();
      const initScopeDepth = u30();
      const maxScopeDepth = u30();
      const codeLength = u30();
      const code = r.bytesCopy(codeLength);
      const ec = u30();
      const exceptions: ExceptionInfo[] = [];
      for (let j = 0; j < ec; j++) {
        exceptions.push({ from: u30(), to: u30(), target: u30(), excType: u30(), varName: u30() });
      }
      abc.bodies.push({ method, maxStack, localCount, initScopeDepth, maxScopeDepth, code, exceptions, traits: readTraits() });
    }

    return abc;
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  toBytes(): Uint8Array {
    const w = new ByteWriter(1 << 16);
    const u30 = (v: number): void => {
      w.encodedU32(v);
    };
    const count = (items: unknown[], name: string): number =>
      items.length > 1 ? items.length : this.onePools.has(name) ? 1 : 0;
    const pool = <T>(items: T[], name: string, write: (v: T) => void): void => {
      u30(count(items, name));
      for (let i = 1; i < items.length; i++) write(items[i]!);
    };

    w.u16(this.minorVersion);
    w.u16(this.majorVersion);
    pool(this.ints, 'ints', (v) => u30(v >>> 0));
    pool(this.uints, 'uints', (v) => u30(v >>> 0));
    pool(this.doubles, 'doubles', (v) => w.f64(v));
    u30(count(this.strings, 'strings'));
    for (let i = 1; i < this.strings.length; i++) {
      const s = this.strings[i]!;
      const raw = this.rawStrings.get(i);
      const bytes = raw && raw.decoded === s ? raw.bytes : utf8Encoder.encode(s);
      u30(bytes.length);
      w.bytes(bytes);
    }
    pool(this.namespaces, 'namespaces', (ns) => {
      w.u8(ns.kind);
      u30(ns.name);
    });
    pool(this.nsSets, 'nsSets', (set) => {
      u30(set.length);
      for (const ns of set) u30(ns);
    });
    pool(this.multinames, 'multinames', (m) => {
      w.u8(m.kind);
      switch (m.kind) {
        case MultinameKind.QName:
        case MultinameKind.QNameA:
          u30(m.ns);
          u30(m.name);
          break;
        case MultinameKind.RTQName:
        case MultinameKind.RTQNameA:
          u30(m.name);
          break;
        case MultinameKind.RTQNameL:
        case MultinameKind.RTQNameLA:
          break;
        case MultinameKind.Multiname:
        case MultinameKind.MultinameA:
          u30(m.name);
          u30(m.nsSet);
          break;
        case MultinameKind.MultinameL:
        case MultinameKind.MultinameLA:
          u30(m.nsSet);
          break;
        case MultinameKind.TypeName:
          u30(m.base);
          u30(m.params.length);
          for (const p of m.params) u30(p);
          break;
        default:
          throw new Error(`Cannot write multiname kind 0x${m.kind.toString(16)}`);
      }
    });

    u30(this.methods.length);
    for (const m of this.methods) {
      u30(m.paramTypes.length);
      u30(m.returnType);
      for (const p of m.paramTypes) u30(p);
      u30(m.name);
      let flags = m.flags;
      if (m.optional.length > 0) flags |= MethodFlags.HAS_OPTIONAL;
      if (m.paramNames.length > 0) flags |= MethodFlags.HAS_PARAM_NAMES;
      if (flags & MethodFlags.HAS_PARAM_NAMES && m.paramNames.length !== m.paramTypes.length) {
        if (m.paramNames.length === 0) flags &= ~MethodFlags.HAS_PARAM_NAMES;
        else throw new Error('MethodInfo.paramNames must be empty or have one entry per parameter');
      }
      w.u8(flags);
      if (flags & MethodFlags.HAS_OPTIONAL) {
        u30(m.optional.length);
        for (const o of m.optional) {
          u30(o.value);
          w.u8(o.kind);
        }
      }
      if (flags & MethodFlags.HAS_PARAM_NAMES) {
        for (const p of m.paramNames) u30(p);
      }
    }

    u30(this.metadata.length);
    for (const md of this.metadata) {
      u30(md.name);
      u30(md.keys.length);
      for (const k of md.keys) u30(k);
      for (const v of md.values) u30(v);
    }

    const writeTraits = (traits: Trait[]): void => {
      u30(traits.length);
      for (const t of traits) {
        u30(t.name);
        let attrs = t.attrs;
        if (t.metadata.length > 0) attrs |= TraitAttr.Metadata;
        w.u8((attrs << 4) | t.kind);
        switch (t.kind) {
          case TraitKind.Slot:
          case TraitKind.Const:
            u30(t.id);
            u30(t.typeName);
            u30(t.valueIndex);
            if (t.valueIndex !== 0) w.u8(t.valueKind);
            break;
          case TraitKind.Class:
            u30(t.id);
            u30(t.classIndex);
            break;
          default:
            u30(t.id);
            u30(t.method);
        }
        if (attrs & TraitAttr.Metadata) {
          u30(t.metadata.length);
          for (const m of t.metadata) u30(m);
        }
      }
    };

    if (this.instances.length !== this.classes.length) {
      throw new Error('AbcFile.instances and AbcFile.classes must have the same length');
    }
    u30(this.instances.length);
    for (const inst of this.instances) {
      u30(inst.name);
      u30(inst.superName);
      w.u8(inst.flags);
      if (inst.flags & InstanceFlags.ProtectedNs) u30(inst.protectedNs);
      u30(inst.interfaces.length);
      for (const i of inst.interfaces) u30(i);
      u30(inst.iinit);
      writeTraits(inst.traits);
    }
    for (const c of this.classes) {
      u30(c.cinit);
      writeTraits(c.traits);
    }

    u30(this.scripts.length);
    for (const s of this.scripts) {
      u30(s.init);
      writeTraits(s.traits);
    }

    u30(this.bodies.length);
    for (const b of this.bodies) {
      u30(b.method);
      u30(b.maxStack);
      u30(b.localCount);
      u30(b.initScopeDepth);
      u30(b.maxScopeDepth);
      u30(b.code.length);
      w.bytes(b.code);
      u30(b.exceptions.length);
      for (const e of b.exceptions) {
        u30(e.from);
        u30(e.to);
        u30(e.target);
        u30(e.excType);
        u30(e.varName);
      }
      writeTraits(b.traits);
    }

    return w.toBytes();
  }

  // -------------------------------------------------------------------------
  // Constant pool interning (find-or-add)
  // -------------------------------------------------------------------------

  /** String pool index for `s` (adds it if missing). */
  string(s: string): number {
    let i = this.stringCache.find(s);
    if (i < 0) {
      i = this.strings.length;
      this.strings.push(s);
    }
    return i;
  }

  int(v: number): number {
    v |= 0;
    let i = this.intCache.find(String(v));
    if (i < 0) {
      i = this.ints.length;
      this.ints.push(v);
    }
    return i;
  }

  uint(v: number): number {
    v >>>= 0;
    let i = this.uintCache.find(String(v));
    if (i < 0) {
      i = this.uints.length;
      this.uints.push(v);
    }
    return i;
  }

  double(v: number): number {
    let i = this.doubleCache.find(Object.is(v, -0) ? '-0' : String(v));
    if (i < 0) {
      i = this.doubles.length;
      this.doubles.push(v);
    }
    return i;
  }

  /** Namespace pool index. `PrivateNs` entries are always created fresh unless `reuse` is set. */
  namespace(kind: number, name: string | number, reuse = kind !== NamespaceKind.PrivateNs): number {
    const nameIndex = typeof name === 'number' ? name : this.string(name);
    const info = { kind, name: nameIndex };
    if (reuse) {
      const i = this.nsCache.find(nsKey(info));
      if (i >= 0) return i;
    }
    this.namespaces.push(info);
    return this.namespaces.length - 1;
  }

  packageNamespace(name: string): number {
    return this.namespace(NamespaceKind.PackageNamespace, name);
  }

  nsSet(namespaces: number[]): number {
    let i = this.nsSetCache.find(nsSetKey(namespaces));
    if (i < 0) {
      i = this.nsSets.length;
      this.nsSets.push([...namespaces]);
    }
    return i;
  }

  multiname(info: Partial<MultinameInfo> & { kind: number }): number {
    const m: MultinameInfo = { ...emptyMultiname(info.kind), ...info, params: [...(info.params ?? [])] };
    let i = this.mnCache.find(mnKey(m));
    if (i < 0) {
      i = this.multinames.length;
      this.multinames.push(m);
    }
    return i;
  }

  /** QName multiname index. `ns` may be a namespace index or a package name. */
  qname(ns: number | string, name: string): number {
    const nsIndex = typeof ns === 'number' ? ns : this.packageNamespace(ns);
    return this.multiname({ kind: MultinameKind.QName, ns: nsIndex, name: this.string(name) });
  }

  /** QName for a fully qualified name like "flash.display.Sprite" (or "flash.display:Sprite"). */
  qnameFor(qualified: string): number {
    const { pkg, name } = splitQualifiedName(qualified);
    return this.qname(pkg, name);
  }

  // -------------------------------------------------------------------------
  // Lookup helpers
  // -------------------------------------------------------------------------

  /** Method body for a method index, if the method has one. */
  methodBody(methodIndex: number): MethodBody | undefined {
    if (!this.bodyIndex || this.bodyIndexSize !== this.bodies.length) {
      this.bodyIndex = new Map();
      this.bodies.forEach((b, i) => this.bodyIndex!.set(b.method, i));
      this.bodyIndexSize = this.bodies.length;
    }
    const i = this.bodyIndex.get(methodIndex);
    const body = i === undefined ? undefined : this.bodies[i];
    if (body && body.method !== methodIndex) {
      this.bodyIndexSize = -1;
      return this.methodBody(methodIndex);
    }
    return body;
  }

  /** Namespace URI string (empty for the public/unnamed namespace). */
  namespaceName(nsIndex: number): string {
    const ns = this.namespaces[nsIndex];
    return ns ? (this.strings[ns.name] ?? '') : '';
  }

  /** Local name of a multiname ("*" if any). */
  multinameName(mnIndex: number): string {
    const m = this.multinames[mnIndex];
    if (!m || mnIndex === 0) return '*';
    if (m.kind === MultinameKind.TypeName) {
      return `${this.multinameName(m.base)}.<${m.params.map((p) => this.qualifiedName(p)).join(',')}>`;
    }
    return m.name === 0 && m.kind !== MultinameKind.QName && m.kind !== MultinameKind.QNameA ? '*' : (this.strings[m.name] ?? '');
  }

  /**
   * Fully qualified dotted name of a multiname, e.g. "flash.display.Sprite".
   * For non-QName multinames this is just the local name.
   */
  qualifiedName(mnIndex: number): string {
    const m = this.multinames[mnIndex];
    if (!m || mnIndex === 0) return '*';
    if (m.kind === MultinameKind.QName || m.kind === MultinameKind.QNameA) {
      const ns = this.namespaces[m.ns];
      const pkg = ns && (ns.kind === NamespaceKind.PackageNamespace || ns.kind === NamespaceKind.PackageInternalNs) ? this.namespaceName(m.ns) : '';
      const name = this.strings[m.name] ?? '';
      return pkg ? `${pkg}.${name}` : name;
    }
    if (m.kind === MultinameKind.TypeName) {
      return `${this.qualifiedName(m.base)}.<${m.params.map((p) => this.qualifiedName(p)).join(',')}>`;
    }
    return this.multinameName(mnIndex);
  }

  /** Fully qualified name of class `classIndex`. */
  className(classIndex: number): string {
    const inst = this.instances[classIndex];
    return inst ? this.qualifiedName(inst.name) : `<class ${classIndex}>`;
  }

  /** Class index by fully qualified name ("com.example.Foo" or "com.example:Foo"); -1 if not found. */
  findClass(qualified: string): number {
    const { pkg, name } = splitQualifiedName(qualified);
    const full = pkg ? `${pkg}.${name}` : name;
    for (let i = 0; i < this.instances.length; i++) if (this.qualifiedName(this.instances[i]!.name) === full) return i;
    return -1;
  }

  /** Names of all classes defined in this ABC. */
  classNames(): string[] {
    return this.instances.map((_, i) => this.className(i));
  }
}

/** Split "a.b.C" / "a.b:C" into package and local name. */
export function splitQualifiedName(qualified: string): { pkg: string; name: string } {
  const colon = qualified.lastIndexOf(':');
  if (colon >= 0) return { pkg: qualified.slice(0, colon), name: qualified.slice(colon + 1) };
  // Do not split generic type names like Vector.<int>.
  const generic = qualified.indexOf('.<');
  const searchEnd = generic >= 0 ? generic : qualified.length;
  const dot = qualified.lastIndexOf('.', searchEnd - 1);
  if (dot < 0) return { pkg: '', name: qualified };
  return { pkg: qualified.slice(0, dot), name: qualified.slice(dot + 1) };
}
