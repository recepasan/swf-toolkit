/**
 * Control-flow graph over decoded method code, with dominator and
 * post-dominator trees.
 */
import type { AbcFile } from '../abc/abc-file.js';
import { stackEffect } from '../abc/analysis.js';
import type { CodeException, CodeItem, Instruction } from '../abc/code.js';
import { opInfo } from '../abc/opcodes.js';

export type BlockKind = 'fall' | 'jump' | 'cond' | 'switch' | 'return' | 'throw' | 'raw' | 'end';

export interface Block {
  id: number;
  /** Instructions (labels removed). */
  insns: Instruction[];
  labels: number[];
  kind: BlockKind;
  /** cond: [taken, fallthrough]; switch: [default, ...cases]; fall/jump: [next]. */
  succs: number[];
  preds: number[];
  /** Stack height on entry (-1 if unreachable). */
  entryHeight: number;
}

export interface Cfg {
  blocks: Block[];
  labelBlock: Map<number, number>;
  exceptions: CodeException[];
  /** Immediate dominator per block (-1 for entry / unreachable). */
  idom: number[];
  /** Immediate post-dominator per block (-1 = virtual exit). */
  ipdom: number[];
  /** Reverse post-order index (lower = earlier). */
  order: number[];
}

export function buildCfg(abc: AbcFile, items: readonly CodeItem[], exceptions: readonly CodeException[]): Cfg {
  const blocks: Block[] = [];
  const labelBlock = new Map<number, number>();
  let cur: Block | null = null;
  const newBlock = (): Block => {
    const b: Block = { id: blocks.length, insns: [], labels: [], kind: 'fall', succs: [], preds: [], entryHeight: -1 };
    blocks.push(b);
    return b;
  };

  for (const it of items) {
    if (it.type === 'label') {
      if (!cur || cur.insns.length > 0) cur = newBlock();
      cur.labels.push(it.id);
      labelBlock.set(it.id, cur.id);
      continue;
    }
    if (!cur) cur = newBlock();
    if (it.type === 'bytes') {
      if (cur.insns.length > 0) cur = newBlock();
      cur.kind = 'raw';
      cur = null;
      continue;
    }
    cur.insns.push(it);
    const flow = opInfo(it.op)?.flow;
    if (flow) {
      cur.kind = flow === 'return' ? 'return' : flow === 'throw' ? 'throw' : flow;
      cur = null;
    }
  }
  if (blocks.length === 0) newBlock().kind = 'end';

  // Successors
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const last = b.insns[b.insns.length - 1];
    const next = i + 1 < blocks.length ? i + 1 : -1;
    switch (b.kind) {
      case 'fall':
        if (next >= 0) b.succs = [next];
        else b.kind = 'end';
        break;
      case 'jump':
        b.succs = [labelBlock.get(last!.targets[0]!)!];
        break;
      case 'cond':
        b.succs = [labelBlock.get(last!.targets[0]!)!, ...(next >= 0 ? [next] : [])];
        if (b.succs.length < 2) b.succs.push(b.succs[0]!);
        break;
      case 'switch':
        b.succs = last!.targets.map((t) => labelBlock.get(t)!);
        break;
      default:
        break;
    }
  }
  for (const b of blocks) for (const s of new Set(b.succs)) blocks[s]!.preds.push(b.id);

  // Stack heights
  const handlerBlocks = exceptions.map((e) => labelBlock.get(e.target)!).filter((x) => x !== undefined);
  const work: Array<[number, number]> = [[0, 0], ...handlerBlocks.map((h): [number, number] => [h, 1])];
  while (work.length) {
    const [id, h] = work.pop()!;
    const b = blocks[id]!;
    if (b.entryHeight >= 0) continue;
    b.entryHeight = h;
    let height = h;
    for (const ins of b.insns) {
      const { pop, push } = stackEffect(abc, ins);
      height = Math.max(0, height - pop) + push;
    }
    for (const s of b.succs) work.push([s, height]);
  }
  // Drop edges from unreachable (dead) blocks so they do not disturb structuring.
  const handlerSet = new Set(handlerBlocks);
  for (const b of blocks) {
    if (b.entryHeight >= 0 || handlerSet.has(b.id)) continue;
    for (const s of b.succs) {
      const t = blocks[s]!;
      t.preds = t.preds.filter((p) => p !== b.id);
    }
    b.succs = [];
  }

  // Dominators (Cooper, Harvey & Kennedy) with exception edges from try starts.
  const extraSuccs = new Map<number, number[]>();
  for (const e of exceptions) {
    const from = labelBlock.get(e.from);
    const target = labelBlock.get(e.target);
    if (from === undefined || target === undefined) continue;
    // Every block inside the try range may throw; using the first one is
    // enough for reachability and keeps handlers dominated by the try start.
    extraSuccs.set(from, [...(extraSuccs.get(from) ?? []), target]);
  }
  const succsOf = (id: number): number[] => [...blocks[id]!.succs, ...(extraSuccs.get(id) ?? [])];
  const predsOf: number[][] = blocks.map(() => []);
  for (const b of blocks) for (const s of new Set(succsOf(b.id))) predsOf[s]!.push(b.id);

  const order = rpo(blocks.length, [0], succsOf);
  const idom = dominators(blocks.length, 0, order, (id) => predsOf[id]!);

  // Post-dominators: reverse graph with a virtual exit node (index n).
  const n = blocks.length;
  const exitPreds: number[] = [];
  for (const b of blocks) if (b.succs.length === 0) exitPreds.push(b.id);
  const rsuccs = (id: number): number[] => (id === n ? exitPreds : blocks[id]!.preds);
  const rpreds = (id: number): number[] => {
    if (id === n) return [];
    const b = blocks[id]!;
    return b.succs.length === 0 ? [n] : [...new Set(b.succs)];
  };
  const rorder = rpo(n + 1, [n], rsuccs);
  const pdom = dominators(n + 1, n, rorder, rpreds);
  const ipdom = blocks.map((b) => {
    const p = pdom[b.id]!;
    return p === n || p === undefined ? -1 : p;
  });

  return { blocks, labelBlock, exceptions: [...exceptions], idom, ipdom, order };
}

function rpo(n: number, roots: number[], succs: (id: number) => number[]): number[] {
  const order = new Array<number>(n).fill(-1);
  const visited = new Uint8Array(n);
  const post: number[] = [];
  for (const root of roots) {
    const stack: Array<[number, number]> = [[root, 0]];
    visited[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const ss = succs(top[0]);
      if (top[1] < ss.length) {
        const s = ss[top[1]++]!;
        if (!visited[s]) {
          visited[s] = 1;
          stack.push([s, 0]);
        }
      } else {
        post.push(top[0]);
        stack.pop();
      }
    }
  }
  post.reverse().forEach((id, i) => (order[id] = i));
  return order;
}

function dominators(n: number, root: number, order: number[], preds: (id: number) => number[]): number[] {
  const idom = new Array<number>(n).fill(-1);
  idom[root] = root;
  const nodes = [...Array(n).keys()].filter((i) => order[i]! >= 0).sort((a, b) => order[a]! - order[b]!);
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (order[a]! > order[b]!) a = idom[a]!;
      while (order[b]! > order[a]!) b = idom[b]!;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of nodes) {
      if (b === root) continue;
      let nd = -1;
      for (const p of preds(b)) {
        if (idom[p] === -1 || order[p]! < 0) continue;
        nd = nd === -1 ? p : intersect(p, nd);
      }
      if (nd !== -1 && idom[b] !== nd) {
        idom[b] = nd;
        changed = true;
      }
    }
  }
  idom[root] = -1;
  return idom;
}

/** True if `a` dominates `b`. */
export function dominates(cfg: Cfg, a: number, b: number): boolean {
  let x = b;
  for (let guard = 0; x !== -1 && guard < 100000; guard++) {
    if (x === a) return true;
    x = cfg.idom[x]!;
  }
  return false;
}

export interface Loop {
  header: number;
  body: Set<number>;
  latches: number[];
}

/** Natural loops keyed by header block. */
export function findLoops(cfg: Cfg): Map<number, Loop> {
  const loops = new Map<number, Loop>();
  for (const b of cfg.blocks) {
    for (const s of b.succs) {
      if (!dominates(cfg, s, b.id)) continue;
      let loop = loops.get(s);
      if (!loop) {
        loop = { header: s, body: new Set([s]), latches: [] };
        loops.set(s, loop);
      }
      if (!loop.latches.includes(b.id)) loop.latches.push(b.id);
      const stack = [b.id];
      while (stack.length) {
        const x = stack.pop()!;
        if (loop.body.has(x)) continue;
        loop.body.add(x);
        for (const p of cfg.blocks[x]!.preds) stack.push(p);
      }
    }
  }
  return loops;
}
