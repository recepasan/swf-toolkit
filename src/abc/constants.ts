/** Namespace kinds (AVM2 overview §4.4.1). */
export const NamespaceKind = {
  Namespace: 0x08,
  PackageNamespace: 0x16,
  PackageInternalNs: 0x17,
  ProtectedNamespace: 0x18,
  ExplicitNamespace: 0x19,
  StaticProtectedNs: 0x1a,
  PrivateNs: 0x05,
} as const;

/** Multiname kinds (AVM2 overview §4.4.3). */
export const MultinameKind = {
  QName: 0x07,
  QNameA: 0x0d,
  RTQName: 0x0f,
  RTQNameA: 0x10,
  RTQNameL: 0x11,
  RTQNameLA: 0x12,
  Multiname: 0x09,
  MultinameA: 0x0e,
  MultinameL: 0x1b,
  MultinameLA: 0x1c,
  /** Parameterised type, e.g. Vector.<int>. */
  TypeName: 0x1d,
} as const;

/** Constant value kinds used for optional parameters and slot defaults. */
export const ConstantKind = {
  Undefined: 0x00,
  Utf8: 0x01,
  Decimal: 0x02,
  Int: 0x03,
  UInt: 0x04,
  PrivateNs: 0x05,
  Double: 0x06,
  Namespace: 0x08,
  False: 0x0a,
  True: 0x0b,
  Null: 0x0c,
  PackageNamespace: 0x16,
  PackageInternalNs: 0x17,
  ProtectedNamespace: 0x18,
  ExplicitNamespace: 0x19,
  StaticProtectedNs: 0x1a,
} as const;

export const MethodFlags = {
  NEED_ARGUMENTS: 0x01,
  NEED_ACTIVATION: 0x02,
  NEED_REST: 0x04,
  HAS_OPTIONAL: 0x08,
  IGNORE_REST: 0x10,
  EXPLICIT: 0x20,
  SET_DXNS: 0x40,
  HAS_PARAM_NAMES: 0x80,
} as const;

export const InstanceFlags = {
  Sealed: 0x01,
  Final: 0x02,
  Interface: 0x04,
  ProtectedNs: 0x08,
} as const;

export const TraitKind = {
  Slot: 0,
  Method: 1,
  Getter: 2,
  Setter: 3,
  Class: 4,
  Function: 5,
  Const: 6,
} as const;

export const TraitAttr = {
  Final: 0x1,
  Override: 0x2,
  Metadata: 0x4,
} as const;

function invert<T extends Record<string, number>>(o: T): Map<number, keyof T & string> {
  return new Map(Object.entries(o).map(([k, v]) => [v, k as keyof T & string]));
}

export const NAMESPACE_KIND_NAMES = new Map<number, string>([
  [NamespaceKind.Namespace, 'Namespace'],
  [NamespaceKind.PackageNamespace, 'PackageNamespace'],
  [NamespaceKind.PackageInternalNs, 'PackageInternalNs'],
  [NamespaceKind.ProtectedNamespace, 'ProtectedNamespace'],
  [NamespaceKind.ExplicitNamespace, 'ExplicitNamespace'],
  [NamespaceKind.StaticProtectedNs, 'StaticProtectedNs'],
  [NamespaceKind.PrivateNs, 'PrivateNamespace'],
]);
export const NAMESPACE_KIND_BY_NAME = new Map<string, number>([...NAMESPACE_KIND_NAMES].map(([k, v]) => [v, k]));

export const MULTINAME_KIND_NAMES = invert(MultinameKind);
export const TRAIT_KIND_NAMES = invert(TraitKind);

export const METHOD_FLAG_NAMES = invert(MethodFlags);

export function isNamespaceKind(kind: number): boolean {
  return NAMESPACE_KIND_NAMES.has(kind);
}
