import type { AbcFile, MultinameInfo } from './abc-file.js';
import { emptyMultiname } from './abc-file.js';
import { MultinameKind, NamespaceKind } from './constants.js';

/**
 * Content-based constant pool interning.
 *
 * Unlike the index-based helpers on {@link AbcFile}, two pool entries are
 * considered equal when they *mean* the same thing (e.g. a QName whose
 * namespace refers to a duplicate-but-equal string), so assembling code
 * reuses existing entries instead of growing the pools. Private namespaces
 * are identity-based and never merged.
 */
export class Interner {
  private strMap = new Map<string, number>();
  private nsMap = new Map<string, number>();
  private nsSetMap = new Map<string, number>();
  private mnMap = new Map<string, number>();
  private nsKeys: string[] = [];
  private nsSetKeys: string[] = [];
  private mnKeys: string[] = [];

  constructor(readonly abc: AbcFile) {
    abc.strings.forEach((s, i) => {
      if (i > 0 && !this.strMap.has(s)) this.strMap.set(s, i);
    });
    abc.namespaces.forEach((_, i) => this.registerNs(i));
    abc.nsSets.forEach((_, i) => this.registerNsSet(i));
    abc.multinames.forEach((_, i) => this.registerMn(i));
  }

  private strKey(i: number): string {
    return i === 0 ? '∅' : JSON.stringify(this.abc.strings[i] ?? '');
  }

  private registerNs(i: number): void {
    const ns = this.abc.namespaces[i]!;
    const key = i === 0 ? '*' : ns.kind === NamespaceKind.PrivateNs ? `${ns.kind}:${this.strKey(ns.name)}#${i}` : `${ns.kind}:${this.strKey(ns.name)}`;
    this.nsKeys[i] = key;
    if (!this.nsMap.has(key)) this.nsMap.set(key, i);
  }

  private registerNsSet(i: number): void {
    const key = (this.abc.nsSets[i] ?? []).map((n) => this.nsKeys[n] ?? `?${n}`).join(',');
    this.nsSetKeys[i] = key;
    if (i > 0 && !this.nsSetMap.has(key)) this.nsSetMap.set(key, i);
  }

  private mnKeyOf(m: MultinameInfo): string {
    switch (m.kind) {
      case MultinameKind.QName:
      case MultinameKind.QNameA:
        return `${m.kind}(${this.nsKeys[m.ns]},${this.strKey(m.name)})`;
      case MultinameKind.RTQName:
      case MultinameKind.RTQNameA:
        return `${m.kind}(${this.strKey(m.name)})`;
      case MultinameKind.RTQNameL:
      case MultinameKind.RTQNameLA:
        return `${m.kind}()`;
      case MultinameKind.Multiname:
      case MultinameKind.MultinameA:
        return `${m.kind}(${this.strKey(m.name)},[${this.nsSetKeys[m.nsSet]}])`;
      case MultinameKind.MultinameL:
      case MultinameKind.MultinameLA:
        return `${m.kind}([${this.nsSetKeys[m.nsSet]}])`;
      case MultinameKind.TypeName:
        return `${m.kind}(${this.mnKeyAt(m.base)},${m.params.map((p) => this.mnKeyAt(p)).join(',')})`;
      default:
        return `?${m.kind}`;
    }
  }

  /** Key of an existing multiname; computed on demand because TypeNames may reference later entries. */
  private mnKeyAt(i: number, depth = 0): string {
    const cached = this.mnKeys[i];
    if (cached !== undefined) return cached;
    const m = this.abc.multinames[i];
    if (!m || depth > 32) return `?${i}`;
    if (i === 0) return '*';
    return this.mnKeyOf(m);
  }

  private registerMn(i: number): void {
    const key = i === 0 ? '*' : this.mnKeyOf(this.abc.multinames[i]!);
    this.mnKeys[i] = key;
    if (!this.mnMap.has(key)) this.mnMap.set(key, i);
  }

  /** String index; `null` → 0 (no string). */
  string(s: string | null): number {
    if (s === null) return 0;
    let i = this.strMap.get(s);
    if (i === undefined) {
      i = this.abc.strings.length;
      this.abc.strings.push(s);
      this.strMap.set(s, i);
    }
    return i;
  }

  /**
   * Namespace index. For private namespaces, `hint` selects an existing
   * entry; without a hint the only private namespace with that name is used,
   * or a new one is created if none exists.
   */
  namespace(kind: number, name: string | null, hint?: number): number {
    const nameIndex = this.string(name);
    if (kind === NamespaceKind.PrivateNs) {
      if (hint !== undefined) {
        const ns = this.abc.namespaces[hint];
        if (ns && ns.kind === kind && this.strKey(ns.name) === this.strKey(nameIndex)) return hint;
      }
      const matches: number[] = [];
      this.abc.namespaces.forEach((ns, i) => {
        if (i > 0 && ns.kind === kind && this.strKey(ns.name) === this.strKey(nameIndex)) matches.push(i);
      });
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        throw new Error(
          `Ambiguous PrivateNamespace(${name === null ? 'null' : JSON.stringify(name)}): candidates ${matches.join(', ')}; add the index, e.g. PrivateNamespace(${JSON.stringify(name)}, ${matches[0]})`,
        );
      }
      return this.addNs(kind, nameIndex);
    }
    const key = `${kind}:${this.strKey(nameIndex)}`;
    return this.nsMap.get(key) ?? this.addNs(kind, nameIndex);
  }

  /** Always creates a new namespace entry (e.g. a fresh private namespace). */
  addNs(kind: number, nameIndex: number): number {
    const i = this.abc.namespaces.length;
    this.abc.namespaces.push({ kind, name: nameIndex });
    this.registerNs(i);
    return i;
  }

  nsSet(namespaces: number[]): number {
    const key = namespaces.map((n) => this.nsKeys[n] ?? `?${n}`).join(',');
    let i = this.nsSetMap.get(key);
    if (i === undefined) {
      i = this.abc.nsSets.length;
      this.abc.nsSets.push([...namespaces]);
      this.registerNsSet(i);
    }
    return i;
  }

  multiname(partial: Partial<MultinameInfo> & { kind: number }): number {
    const m: MultinameInfo = { ...emptyMultiname(partial.kind), ...partial, params: [...(partial.params ?? [])] };
    const key = this.mnKeyOf(m);
    let i = this.mnMap.get(key);
    if (i === undefined) {
      i = this.abc.multinames.length;
      this.abc.multinames.push(m);
      this.registerMn(i);
    }
    return i;
  }

  qname(ns: number, name: string | null): number {
    return this.multiname({ kind: MultinameKind.QName, ns, name: this.string(name) });
  }

  int(v: number): number {
    return this.abc.int(v);
  }

  uint(v: number): number {
    return this.abc.uint(v);
  }

  double(v: number): number {
    return this.abc.double(v);
  }
}
