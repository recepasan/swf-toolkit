/**
 * Builds the name-resolution environment (open namespaces, type resolution)
 * for compiling code that belongs to a class of an existing ABC.
 */
import type { AbcFile } from '../abc/abc-file.js';
import { decodeCode } from '../abc/code.js';
import { MultinameKind, NamespaceKind } from '../abc/constants.js';
import type { Interner } from '../abc/interner.js';
import { classMethods } from '../abc/model.js';
import type { TypeRef } from './ast.js';
import { TOPLEVEL_NAMES, type ClassScope } from './codegen.js';

const AS3_NS = 'http://adobe.com/AS3/2006/builtin';

export interface ScopeInput {
  abc: AbcFile;
  pool: Interner;
  pkg: string;
  imports: string[];
  useNamespaces: string[];
  /** Existing class index, or -1 for code outside an existing class. */
  classIndex: number;
  /** Local member names of the class (they shadow imports). */
  memberNames: Set<string>;
  source?: string;
}

/** Package names → short names, harvested from QNames in the constant pool. */
function knownQNames(abc: AbcFile): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const m of abc.multinames) {
    if (m.kind !== MultinameKind.QName) continue;
    const ns = abc.namespaces[m.ns];
    if (!ns || ns.kind !== NamespaceKind.PackageNamespace) continue;
    const name = abc.strings[m.name];
    if (!name) continue;
    const pkg = abc.strings[ns.name] ?? '';
    let set = map.get(name);
    if (!set) map.set(name, (set = new Set()));
    set.add(pkg);
  }
  return map;
}

const knownCache = new WeakMap<AbcFile, Map<string, Set<string>>>();

/** The namespace set most used by a class's existing code (its "open namespaces"). */
function classNsSet(abc: AbcFile, classIndex: number): number[] | undefined {
  const counts = new Map<number, number>();
  for (const r of classMethods(abc, classIndex, false)) {
    const body = abc.methodBody(r.methodIndex);
    if (!body) continue;
    let items;
    try {
      items = decodeCode(body.code, body.exceptions).items;
    } catch {
      continue;
    }
    for (const it of items) {
      if (it.type !== 'op') continue;
      for (const a of it.args) {
        const m = abc.multinames[a];
        if (m && (m.kind === MultinameKind.Multiname || m.kind === MultinameKind.MultinameL) && m.nsSet) {
          counts.set(m.nsSet, (counts.get(m.nsSet) ?? 0) + 1);
        }
      }
    }
  }
  let best = -1;
  for (const [s, n] of counts) if (best < 0 || n > counts.get(best)!) best = s;
  return best >= 0 ? [...abc.nsSets[best]!] : undefined;
}

function lastSegment(uri: string): string {
  return uri.split(/[/:]/).filter(Boolean).pop() ?? '';
}

export function buildClassScope(input: ScopeInput): ClassScope {
  const { abc, pool, pkg, classIndex } = input;
  const pkgNs = (p: string): number => pool.namespace(NamespaceKind.PackageNamespace, p);
  const inst = classIndex >= 0 ? abc.instances[classIndex] : undefined;

  // Namespaces of the class.
  let privateNs: number | undefined;
  const findPrivate = (traits: { name: number }[]): void => {
    for (const t of traits) {
      const m = abc.multinames[t.name];
      const ns = m ? abc.namespaces[m.ns] : undefined;
      if (ns && ns.kind === NamespaceKind.PrivateNs && privateNs === undefined) privateNs = m!.ns;
    }
  };
  if (inst) {
    findPrivate(inst.traits);
    findPrivate(abc.classes[classIndex]!.traits);
  }
  const existingSet = classIndex >= 0 ? classNsSet(abc, classIndex) : undefined;
  if (privateNs === undefined && existingSet) privateNs = existingSet.find((n) => abc.namespaces[n]?.kind === NamespaceKind.PrivateNs);
  if (privateNs === undefined) {
    const cname = inst ? abc.multinameName(inst.name) : 'script';
    privateNs = pool.addNs(NamespaceKind.PrivateNs, pool.string(pkg ? `${pkg}:${cname}` : cname));
  }
  const protectedNs = inst && inst.protectedNs ? inst.protectedNs : undefined;
  let staticProtectedNs: number | undefined;
  if (existingSet) staticProtectedNs = existingSet.find((n) => abc.namespaces[n]?.kind === NamespaceKind.StaticProtectedNs);
  if (staticProtectedNs === undefined && inst) {
    for (const t of abc.classes[classIndex]!.traits) {
      const m = abc.multinames[t.name];
      if (m && abc.namespaces[m.ns]?.kind === NamespaceKind.StaticProtectedNs) staticProtectedNs = m.ns;
    }
  }
  if (staticProtectedNs === undefined && inst && protectedNs) {
    staticProtectedNs = pool.namespace(NamespaceKind.StaticProtectedNs, abc.strings[abc.namespaces[protectedNs]!.name] ?? '');
  }

  const custom = new Map<string, number>();
  abc.namespaces.forEach((ns, i) => {
    if (i === 0 || ns.kind !== NamespaceKind.Namespace) return;
    const uri = abc.strings[ns.name] ?? '';
    const seg = lastSegment(uri);
    if (seg && !custom.has(seg)) custom.set(seg, i);
  });

  // Open namespace set.
  const set: number[] = existingSet ? [...existingSet] : [];
  const add = (n: number | undefined): void => {
    if (n !== undefined && !set.includes(n)) set.push(n);
  };
  add(privateNs);
  add(pkgNs(''));
  add(pkgNs(pkg));
  add(pool.namespace(NamespaceKind.PackageInternalNs, pkg));
  add(protectedNs);
  add(staticProtectedNs);
  // Every namespace the class's own members live in (static protected, custom...).
  if (inst) {
    for (const t of [...inst.traits, ...abc.classes[classIndex]!.traits]) {
      const m = abc.multinames[t.name];
      if (m && (m.kind === MultinameKind.QName || m.kind === MultinameKind.QNameA) && m.ns) add(m.ns);
    }
  }
  add(pool.namespace(NamespaceKind.Namespace, AS3_NS));
  for (const imp of input.imports) {
    const dot = imp.lastIndexOf('.');
    if (dot > 0) add(pkgNs(imp.slice(0, dot)));
  }
  for (const u of input.useNamespaces) add(custom.get(lastSegment(u)) ?? custom.get(u));
  const openNsSet = pool.nsSet(set);

  // Type resolution.
  let known = knownCache.get(abc);
  if (!known) knownCache.set(abc, (known = knownQNames(abc)));
  const definedClasses = new Map<string, Set<string>>();
  for (let c = 0; c < abc.instances.length; c++) {
    const q = abc.className(c);
    const dot = q.lastIndexOf('.');
    const short = dot >= 0 ? q.slice(dot + 1) : q;
    let s = definedClasses.get(short);
    if (!s) definedClasses.set(short, (s = new Set()));
    s.add(dot >= 0 ? q.slice(0, dot) : '');
  }
  const explicitImports = new Map<string, string>();
  const wildcard: string[] = [];
  for (const imp of input.imports) {
    if (imp.endsWith('.*')) wildcard.push(imp.slice(0, -2));
    else {
      const dot = imp.lastIndexOf('.');
      explicitImports.set(imp.slice(dot + 1), dot > 0 ? imp.slice(0, dot) : '');
    }
  }

  /** Package for a short class name, or undefined when unknown. */
  const packageOf = (short: string): string | undefined => {
    const imp = explicitImports.get(short);
    if (imp !== undefined) return imp;
    const defined = definedClasses.get(short);
    if (defined?.has(pkg)) return pkg;
    if (TOPLEVEL_NAMES.has(short)) return '';
    const candidates = new Set([...(defined ?? []), ...(known!.get(short) ?? [])]);
    for (const w of wildcard) if (candidates.has(w)) return w;
    if (candidates.has('')) return '';
    if (candidates.size === 1) return [...candidates][0];
    return undefined;
  };

  const resolveType = (t: TypeRef): number => {
    if (t.name === '*') return 0;
    if (t.params) {
      const base = resolveType({ name: t.name === 'Vector' ? '__AS3__.vec.Vector' : t.name, pos: t.pos });
      return pool.multiname({ kind: MultinameKind.TypeName, base, params: t.params.map(resolveType) });
    }
    const dot = t.name.lastIndexOf('.');
    if (dot > 0) return pool.qname(pkgNs(t.name.slice(0, dot)), t.name.slice(dot + 1));
    const p = t.name === 'Vector' ? '__AS3__.vec' : packageOf(t.name);
    if (p !== undefined) return pool.qname(pkgNs(p), t.name);
    return pool.multiname({ kind: MultinameKind.Multiname, name: pool.string(t.name), nsSet: openNsSet });
  };

  const resolveName = (name: string): number | undefined => {
    if (input.memberNames.has(name)) return undefined;
    if (name === 'Vector') return pool.qname(pkgNs('__AS3__.vec'), 'Vector');
    if (explicitImports.has(name)) return pool.qname(pkgNs(explicitImports.get(name)!), name);
    if (!/^[A-Z]/.test(name) && !TOPLEVEL_NAMES.has(name)) return undefined;
    const p = explicitImports.get(name) ?? (definedClasses.get(name)?.has(pkg) ? pkg : undefined) ?? (TOPLEVEL_NAMES.has(name) ? '' : undefined);
    return p === undefined ? undefined : pool.qname(pkgNs(p), name);
  };

  const namespaceByName = (name: string): number | undefined => {
    switch (name) {
      case 'private':
        return privateNs;
      case 'protected':
        return protectedNs;
      case 'static protected':
        return staticProtectedNs ?? protectedNs;
      case 'public':
        return pkgNs('');
      case 'internal':
        return pool.namespace(NamespaceKind.PackageInternalNs, pkg);
      case 'AS3':
        return pool.namespace(NamespaceKind.Namespace, AS3_NS);
      default:
        return custom.get(name);
    }
  };

  return { abc, pool, pkg, openNsSet, namespaceByName, resolveType, resolveName, source: input.source };
}

/** Namespace for a member declared with the given access keyword. */
export function memberNamespace(scope: ClassScope, access: string): number {
  if (access.startsWith('ns:')) {
    const n = scope.namespaceByName(access.slice(3));
    if (n === undefined) throw new Error(`Unknown namespace '${access.slice(3)}'`);
    return n;
  }
  return scope.namespaceByName(access === 'internal' ? 'internal' : access)!;
}
