/**
 * Control-flow structuring: rebuilds if/else, loops, switch and try/catch
 * from the CFG, using dominator / post-dominator information.
 */
import type { Expr, Stmt, SwitchCase } from './ast.js';
import { lit, not } from './ast.js';
import { dominates as dominatesBlock, findLoops, type Cfg, type Loop } from './cfg.js';
import { simulate, SimulationError, type MethodContext, type Terminator } from './simulate.js';
import { Op } from '../abc/opcodes.js';

interface LoopCtx {
  header: number;
  continueTarget: number;
  breakTarget: number;
  /** Assigned lazily when a labelled break/continue is needed. */
  label?: string;
  /** do-while latch: reaching it ends the body. */
  latch?: number;
}

interface Env {
  follows: ReadonlySet<number>;
  /** Break/continue targets, innermost last. */
  loops: LoopCtx[];
  /** Innermost switch break target. */
  switchBreak?: number;
  /** Blocks the current construct may use; leaving it stops the sequence. */
  region?: ReadonlySet<number>;
  /** Exit blocks reached when leaving `region`. */
  exits?: number[];
  activeLoops: ReadonlySet<number>;
  activeTries: ReadonlySet<string>;
  /** Set when the sequence ended at a do-while latch. */
  latchResult?: { stmts: Stmt[]; c: Expr; latch: number };
}

interface TryGroup {
  key: string;
  fromBlock: number;
  toBlock: number;
  handlers: Array<{ index: number; block: number }>;
}

export class Structurer {
  private visited = new Set<number>();
  private loops: Map<number, Loop>;
  private labelCounter = 0;
  private tries: TryGroup[] = [];
  /** Labels of loop statements that need one, keyed by LoopCtx. */
  private loopStmts = new Map<LoopCtx, Stmt>();

  constructor(
    private readonly ctx: MethodContext,
    private readonly cfg: Cfg,
  ) {
    this.loops = findLoops(cfg);
    const groups = new Map<string, TryGroup>();
    cfg.exceptions.forEach((e, index) => {
      const fromBlock = cfg.labelBlock.get(e.from);
      const toBlock = cfg.labelBlock.get(e.to);
      const handler = cfg.labelBlock.get(e.target);
      if (fromBlock === undefined || toBlock === undefined || handler === undefined) return;
      const key = `${fromBlock}:${toBlock}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, fromBlock, toBlock, handlers: [] };
        groups.set(key, g);
      }
      g.handlers.push({ index, block: handler });
    });
    // Outer (larger) try ranges first.
    this.tries = [...groups.values()].sort((a, b) => a.fromBlock - b.fromBlock || b.toBlock - a.toBlock);
  }

  run(): Stmt[] {
    return this.seq(0, { follows: new Set(), loops: [], activeLoops: new Set(), activeTries: new Set() }, []);
  }

  /**
   * If block `id` only evaluates a condition on top of `stack` (no statements,
   * stack unchanged afterwards), returns that condition.
   */
  private blockIsEmptyCondition(id: number, stack: Expr[] = []): { c: Expr } | null {
    const b = this.cfg.blocks[id]!;
    if (b.kind !== 'cond' || b.entryHeight !== stack.length || this.visited.has(id) || this.loops.has(id)) return null;
    if (this.tries.some((t) => t.fromBlock === id)) return null;
    const stmts: Stmt[] = [];
    try {
      const r = simulate(this.ctx, b.insns, stack, stmts);
      if (stmts.length || r.term.k !== 'cond' || r.stack.length !== stack.length) return null;
      if (r.stack.some((v, i) => v !== stack[i])) return null;
      return { c: r.term.c };
    } catch {
      return null;
    }
  }

  /** Collapses short-circuit conditions (`a && b`, `a || b`) starting at a conditional block. */
  private collapse(block: number, c: Expr, region?: ReadonlySet<number>, stack: Expr[] = []): { c: Expr; t: number; f: number; group: Set<number> } {
    const group = new Set([block]);
    let [t, f] = this.cfg.blocks[block]!.succs as [number, number];
    for (let changed = true; changed; ) {
      changed = false;
      for (const x of [t, f]) {
        if (group.has(x) || (region && !region.has(x))) continue;
        const preds = this.cfg.blocks[x]!.preds;
        if (!preds.every((p) => group.has(p))) continue;
        const inner = this.blockIsEmptyCondition(x, stack);
        if (!inner) continue;
        const [tx, fx] = this.cfg.blocks[x]!.succs as [number, number];
        let ok = true;
        if (x === t && fx === f) {
          c = { k: 'binary', op: '&&', a: c, b: inner.c };
          t = tx;
        } else if (x === t && tx === f) {
          c = { k: 'binary', op: '&&', a: c, b: not(inner.c) };
          t = fx;
        } else if (x === f && tx === t) {
          c = { k: 'binary', op: '||', a: c, b: inner.c };
          f = fx;
        } else if (x === f && fx === t) {
          c = { k: 'binary', op: '||', a: c, b: not(inner.c) };
          f = tx;
        } else ok = false;
        if (ok) {
          group.add(x);
          this.visited.add(x);
          changed = true;
          break;
        }
      }
    }
    return { c, t, f, group };
  }

  private mergeOf(block: number, env: Env): number {
    const m = this.cfg.ipdom[block]!;
    if (m >= 0) {
      if (env.region && !env.region.has(m)) return -1;
      return m;
    }
    // No post-dominator (some paths return/throw): use the earliest block
    // reachable from at least two successors inside the current region.
    const succs = [...new Set(this.cfg.blocks[block]!.succs)];
    if (succs.length < 2) return -1;
    const stop = new Set<number>([block, ...env.follows]);
    for (const l of env.loops) {
      stop.add(l.header);
      stop.add(l.breakTarget);
      stop.add(l.continueTarget);
    }
    const reach = (from: number): Set<number> => {
      const seen = new Set<number>();
      const work = [from];
      while (work.length) {
        const x = work.pop()!;
        if (x < 0 || seen.has(x)) continue;
        if (env.region && !env.region.has(x)) continue;
        seen.add(x);
        if (stop.has(x) && x !== from) continue;
        for (const s of this.cfg.blocks[x]!.succs) if (s !== block) work.push(s);
      }
      return seen;
    };
    const counts = new Map<number, number>();
    for (const s of succs) for (const x of reach(s)) counts.set(x, (counts.get(x) ?? 0) + 1);
    const targets = new Set(succs);
    let best = -1;
    let bestCount = 0;
    for (const [x, n] of counts) {
      if (n < 2 || (succs.length > 2 && targets.has(x))) continue;
      if (stop.has(x) && !env.follows.has(x)) continue;
      const better = n > bestCount || (n === bestCount && this.cfg.order[x]! < this.cfg.order[best]!);
      if (best < 0 || better) {
        best = x;
        bestCount = n;
      }
    }
    if (best >= 0 && env.loops.some((l) => l.header === best || l.continueTarget === best || l.breakTarget === best)) return -1;
    return best;
  }

  /** Follows blocks that only contain `label` / `jump` / `nop` to their destination. */
  private resolveTrivial(id: number): number {
    for (let guard = 0; guard < 64; guard++) {
      const b = this.cfg.blocks[id];
      if (!b || (b.kind !== 'jump' && b.kind !== 'fall') || b.succs.length !== 1) return id;
      if (!b.insns.every((i) => i.op === Op.label || i.op === Op.jump || i.op === Op.nop)) return id;
      if (this.tries.some((t) => t.fromBlock === id) || this.loops.has(id)) return id;
      id = b.succs[0]!;
    }
    return id;
  }

  /** Statement for jumping to `target` from inside the current constructs, or null. */
  private jumpStmt(target: number, env: Env): Stmt | null {
    const resolved = this.resolveTrivial(target);
    for (let i = env.loops.length - 1; i >= 0; i--) {
      const l = env.loops[i]!;
      const innermost = i === env.loops.length - 1 && env.switchBreak === undefined;
      if (target === l.breakTarget || resolved === l.breakTarget) return innermost ? { k: 'break' } : { k: 'break', label: this.loopLabel(l) };
      if ((target === l.continueTarget || resolved === l.continueTarget) && l.latch === undefined) {
        return i === env.loops.length - 1 ? { k: 'continue' } : { k: 'continue', label: this.loopLabel(l) };
      }
    }
    if (env.switchBreak !== undefined && (target === env.switchBreak || resolved === env.switchBreak)) return { k: 'break' };
    return null;
  }

  private loopLabel(l: LoopCtx): string {
    if (!l.label) {
      l.label = `loop${this.labelCounter++}`;
      const s = this.loopStmts.get(l);
      if (s && 'label' in s) (s as { label?: string }).label = l.label;
    }
    return l.label;
  }

  private seq(start: number, env: Env, entryStack: Expr[], allowStartTarget = false): Stmt[] {
    const out: Stmt[] = [];
    let cur = start;
    let stack = entryStack;
    let first = true;

    while (cur >= 0) {
      if (!(first && allowStartTarget)) {
        const latchLoop = env.loops[env.loops.length - 1];
        if (latchLoop?.latch === cur && !this.visited.has(cur)) {
          // do-while latch: its statements end the body, its condition is the loop test.
          this.visited.add(cur);
          const stmts: Stmt[] = [];
          const r = simulate(this.ctx, this.cfg.blocks[cur]!.insns, stack, stmts);
          if (r.term.k !== 'cond') throw new SimulationError('do-while latch without condition');
          const [t] = this.cfg.blocks[cur]!.succs;
          env.latchResult = { stmts, c: t === latchLoop.header ? r.term.c : not(r.term.c), latch: cur };
          out.push(...stmts);
          break;
        }
        const j = this.jumpStmt(cur, env);
        if (j) {
          out.push(j);
          break;
        }
        if (env.follows.has(cur) || env.follows.has(this.resolveTrivial(cur))) break;
        if (env.region && !env.region.has(cur)) {
          env.exits?.push(this.resolveTrivial(cur));
          break;
        }
      }
      first = false;

      if (this.visited.has(cur)) {
        out.push({ k: 'comment', text: `goto block ${cur} (unstructured jump)` });
        break;
      }

      const tryGroup = this.tries.find((t) => t.fromBlock === cur && !env.activeTries.has(t.key));
      if (tryGroup) {
        const r = this.emitTry(tryGroup, env, stack);
        out.push(r.stmt);
        cur = r.next;
        continue;
      }

      const loop = this.loops.get(cur);
      if (loop && !env.activeLoops.has(cur)) {
        const r = this.emitLoop(loop, env, stack);
        out.push(...r.stmts);
        cur = r.next;
        continue;
      }

      this.visited.add(cur);
      const b = this.cfg.blocks[cur]!;
      if (b.kind === 'raw') {
        out.push({ k: 'comment', text: 'undecodable bytecode' });
        break;
      }
      const r = simulate(this.ctx, b.insns, stack, out);
      stack = r.stack;
      const term: Terminator = r.term;
      switch (term.k) {
        case 'fall':
        case 'jump':
          cur = b.succs[0] ?? -1;
          if (cur < 0 && b.kind !== 'end') out.push({ k: 'comment', text: 'end of code' });
          break;
        case 'end':
          cur = -1;
          break;
        case 'return':
          out.push(term.e ? { k: 'return', e: term.e } : { k: 'return' });
          cur = -1;
          break;
        case 'throw':
          out.push({ k: 'throw', e: term.e });
          cur = -1;
          break;
        case 'cond': {
          const merge = this.mergeOf(cur, env);
          if (merge >= 0 && this.cfg.blocks[merge]!.entryHeight > 0) {
            stack = this.evalCond(cur, term.c, merge, stack);
            cur = merge;
            break;
          }
          const { c, t, f } = this.collapse(cur, term.c, env.region, stack);
          const follows = merge >= 0 ? new Set([...env.follows, merge]) : env.follows;
          // Compilers emit `if(c) A else B` as `iffalse Lelse; A; ...`, so the
          // fall-through successor is the source's "then" branch.
          const inner: Env = { ...env, follows, latchResult: undefined };
          const thenBody = this.seq(f, inner, stack);
          const elseEnv: Env = { ...env, follows, latchResult: undefined };
          const elseBody = this.seq(t, elseEnv, stack);
          if (inner.latchResult || elseEnv.latchResult) env.latchResult = inner.latchResult ?? elseEnv.latchResult;
          out.push(makeIf(not(c), thenBody, elseBody));
          cur = merge;
          break;
        }
        case 'switch': {
          const r2 = this.emitSwitch(cur, term.e, env, stack);
          out.push(r2.stmt);
          cur = r2.next;
          break;
        }
      }
      if (env.latchResult) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Value merges (ternaries, && / || used as values)
  // -------------------------------------------------------------------------

  private evalCond(block: number, c0: Expr, merge: number, stack: Expr[]): Expr[] {
    // `(a && b) ? x : y` compiles to two conditional jumps sharing a target.
    const { c, t, f } = this.collapse(block, c0, undefined, stack);
    const st = this.evalPath(t, merge, stack);
    const sf = this.evalPath(f, merge, stack);
    if (st.length !== sf.length) throw new SimulationError('Stack height mismatch at value merge');
    const negOf = (cond: Expr, v: Expr): boolean =>
      (cond.k === 'unary' && cond.op === '!' && cond.e === v) || (v.k === 'unary' && v.op === '!' && v.e === cond);
    return st.map((x, i) => {
      const y = sf[i]!;
      if (x === y) return x;
      // x ? x : y  →  x || y
      if (x === c) return { k: 'binary', op: '||', a: c, b: y };
      // c ? x : c  →  c && x
      if (y === c) return { k: 'binary', op: '&&', a: c, b: x };
      // !x ? x : y  →  x && y
      if (negOf(c, x)) return { k: 'binary', op: '&&', a: x, b: y };
      // !y ? x : y  →  y || x
      if (negOf(c, y)) return { k: 'binary', op: '||', a: y, b: x };
      if (c.k === 'unary' && c.op === '!') return { k: 'cond', c: c.e, t: y, f: x };
      return { k: 'cond', c, t: x, f: y };
    });
  }

  private evalPath(start: number, merge: number, stack: Expr[]): Expr[] {
    let cur = start;
    let st = stack;
    for (let guard = 0; guard < 10000; guard++) {
      if (cur === merge) return st;
      if (cur < 0 || this.visited.has(cur)) throw new SimulationError('Unsupported control flow inside expression');
      this.visited.add(cur);
      const b = this.cfg.blocks[cur]!;
      const stmts: Stmt[] = [];
      const r = simulate(this.ctx, b.insns, st, stmts);
      if (stmts.length) {
        // Side effects inside an expression (e.g. `(a = b) > 0`): fold them
        // into a comma expression on the value this path produced.
        if (!stmts.every((s) => s.k === 'expr')) throw new SimulationError('Statement inside expression');
        const idx = r.stack.findIndex((v, i) => v !== st[i]);
        if (idx < 0) throw new SimulationError('Statement inside expression');
        let seqExpr: Expr = r.stack[idx]!;
        for (let k = stmts.length - 1; k >= 0; k--) seqExpr = { k: 'binary', op: ',', a: (stmts[k] as { e: Expr }).e, b: seqExpr };
        r.stack[idx] = seqExpr;
      }
      st = r.stack;
      if (r.term.k === 'fall' || r.term.k === 'jump') {
        cur = b.succs[0] ?? -1;
        continue;
      }
      if (r.term.k === 'cond') {
        const inner = this.cfg.ipdom[cur]!;
        if (inner >= 0 && inner !== merge && this.cfg.blocks[inner]!.entryHeight > 0) {
          st = this.evalCond(cur, r.term.c, inner, st);
          cur = inner;
          continue;
        }
        return this.evalCond(cur, r.term.c, merge, st);
      }
      throw new SimulationError('Unsupported terminator inside expression');
    }
    throw new SimulationError('Expression too complex');
  }

  // -------------------------------------------------------------------------
  // Loops
  // -------------------------------------------------------------------------

  private emitLoop(loop: Loop, env: Env, stack: Expr[]): { stmts: Stmt[]; next: number } {
    const h = loop.header;
    const hb = this.cfg.blocks[h]!;
    const outside = (x: number): boolean => !loop.body.has(x);

    // Exit selection.
    let exit = -1;
    let form: 'while' | 'dowhile' | 'forever' = 'forever';
    let latch: number | undefined;
    const headerCond = hb.kind === 'cond' ? this.blockIsEmptyCondition(h) ?? this.pureHeaderCondition(h) : null;
    if (headerCond && hb.succs.some(outside) && hb.succs.some((s) => !outside(s))) {
      form = 'while';
    } else {
      const condLatch = loop.latches.find((l) => {
        const lb = this.cfg.blocks[l]!;
        return lb.kind === 'cond' && lb.succs.includes(h) && lb.succs.some(outside);
      });
      if (condLatch !== undefined && condLatch === h && loop.body.size === 1) {
        // Single-block do-while: body and test in the header block.
        this.visited.add(h);
        const stmts: Stmt[] = [];
        const r = simulate(this.ctx, hb.insns, stack, stmts);
        if (r.term.k === 'cond') {
          const [t] = hb.succs;
          const next = hb.succs.find(outside)!;
          return { stmts: [{ k: 'dowhile', c: t === h ? r.term.c : not(r.term.c), body: stmts }], next };
        }
        this.visited.delete(h);
      } else if (condLatch !== undefined && loop.latches.length === 1) {
        form = 'dowhile';
        latch = condLatch;
        exit = this.cfg.blocks[condLatch]!.succs.find(outside)!;
      }
    }

    if (form === 'while') {
      const activeLoops = new Set([...env.activeLoops, h]);
      this.visited.add(h);
      const { c, t, f, group } = this.collapse(h, headerCond!.c, loop.body);
      const inBody = !outside(t) ? t : f;
      exit = inBody === t ? f : t;
      const cond = inBody === t ? c : not(c);
      for (const g of group) this.visited.add(g);
      // for-loop update block: the single latch, reached by several paths (continue / merges)
      // or holding only increments of locals.
      let update: Stmt[] | undefined;
      let updateBlock = -1;
      if (loop.latches.length === 1) {
        const l = loop.latches[0]!;
        const lb = this.cfg.blocks[l]!;
        if (l !== h && l !== inBody && (lb.kind === 'fall' || lb.kind === 'jump') && lb.succs[0] === h && !this.loops.has(l)) {
          const stmts: Stmt[] = [];
          try {
            const r = simulate(this.ctx, lb.insns, [], stmts);
            const simple = stmts.length > 0 && stmts.every((s) => s.k === 'expr' && (s.e.k === 'postfix' || (s.e.k === 'assign' && s.e.target.k === 'local')));
            if (r.stack.length === 0 && stmts.every((s) => s.k === 'expr') && (lb.preds.length >= 2 || simple)) {
              update = stmts;
              updateBlock = l;
            }
          } catch {
            /* not an update block */
          }
        }
      }
      const lc: LoopCtx = { header: h, continueTarget: updateBlock >= 0 ? updateBlock : h, breakTarget: exit };
      const stmt: Stmt = update
        ? { k: 'for', c: cond, update: commaOf(update.map((s) => (s as { e: Expr }).e)), body: [] }
        : { k: 'while', c: cond, body: [] };
      this.loopStmts.set(lc, stmt);
      const bodyEnv: Env = { ...env, follows: new Set(), loops: [...env.loops, lc], switchBreak: undefined, region: intersect(this.loopRegion(loop, exit), env.region), exits: [], activeLoops };
      stmt.body = this.seq(inBody, bodyEnv, stack);
      if (updateBlock >= 0) this.visited.add(updateBlock);
      if (lc.label) stmt.label = lc.label;
      return { stmts: [stmt], next: exit };
    }

    if (exit < 0) {
      const candidates = new Map<number, number>();
      for (const x of loop.body) {
        for (const s0 of this.cfg.blocks[x]!.succs) {
          if (!outside(s0)) continue;
          const s = this.resolveTrivial(s0);
          candidates.set(s, (candidates.get(s) ?? 0) + 1);
        }
      }
      let best = -1;
      for (const [s, n] of candidates) if (best < 0 || n > candidates.get(best)! || (n === candidates.get(best)! && s < best)) best = s;
      exit = best;
    }

    const activeLoops = new Set([...env.activeLoops, h]);
    const lc: LoopCtx = { header: h, continueTarget: latch ?? h, breakTarget: exit, latch };
    const bodyEnv: Env = { ...env, follows: new Set(), loops: [...env.loops, lc], switchBreak: undefined, region: intersect(this.loopRegion(loop, exit), env.region), exits: [], activeLoops, latchResult: undefined };
    if (form === 'dowhile') {
      const stmt: Stmt = { k: 'dowhile', c: lit(true), body: [] };
      this.loopStmts.set(lc, stmt);
      stmt.body = this.seq(h, bodyEnv, stack, true);
      if (bodyEnv.latchResult) stmt.c = bodyEnv.latchResult.c;
      if (lc.label) stmt.label = lc.label;
      return { stmts: [stmt], next: exit };
    }
    const stmt: Stmt = { k: 'while', c: lit(true), body: [] };
    this.loopStmts.set(lc, stmt);
    stmt.body = this.seq(h, bodyEnv, stack, true);
    if (lc.label) stmt.label = lc.label;
    return { stmts: [stmt], next: exit };
  }

  /**
   * Natural loop body plus dead-end blocks (return/throw paths) dominated by
   * the header: those are syntactically inside the loop even though they
   * never branch back.
   */
  private loopRegion(loop: Loop, exit: number): Set<number> {
    const region = new Set(loop.body);
    const canLeave = new Map<number, boolean>();
    const leaves = (x: number, seen: Set<number>): boolean => {
      const c = canLeave.get(x);
      if (c !== undefined) return c;
      if (seen.has(x)) return false;
      seen.add(x);
      let r = false;
      for (const s of this.cfg.blocks[x]!.succs) {
        if (loop.body.has(s)) continue;
        if (!dominatesBlock(this.cfg, loop.header, s)) {
          r = true;
          break;
        }
        if (leaves(s, seen)) {
          r = true;
          break;
        }
      }
      canLeave.set(x, r);
      return r;
    };
    for (const x of loop.body) {
      for (const s of this.cfg.blocks[x]!.succs) {
        if (region.has(s) || !dominatesBlock(this.cfg, loop.header, s)) continue;
        const stack = [s];
        const group: number[] = [];
        let deadEnd = true;
        const seen = new Set<number>();
        while (stack.length) {
          const y = stack.pop()!;
          if (seen.has(y) || region.has(y)) continue;
          if (y === exit) {
            deadEnd = false;
            break;
          }
          seen.add(y);
          group.push(y);
          const yb = this.cfg.blocks[y]!;
          if (yb.kind !== 'return' && yb.kind !== 'throw' && yb.succs.length === 0) deadEnd = false;
          for (const z of yb.succs) {
            if (loop.body.has(z)) continue;
            if (!dominatesBlock(this.cfg, loop.header, z)) deadEnd = false;
            else stack.push(z);
          }
        }
        if (deadEnd && group.length <= 64 && !group.some((g) => leaves(g, new Set()))) for (const g of group) region.add(g);
      }
    }
    return region;
  }

  /** Header condition for blocks that only compute a condition from scratch (e.g. hasnext2). */
  private pureHeaderCondition(id: number): { c: Expr } | null {
    const b = this.cfg.blocks[id]!;
    const stmts: Stmt[] = [];
    try {
      const r = simulate(this.ctx, b.insns, [], stmts);
      if (stmts.length === 0 && r.stack.length === 0 && r.term.k === 'cond') return { c: r.term.c };
    } catch {
      /* not a pure condition */
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // switch
  // -------------------------------------------------------------------------

  private switchFollow(block: number, env: Env): number {
    const m = this.cfg.ipdom[block]!;
    if (m >= 0) return env.region && !env.region.has(m) ? -1 : m;
    // Most common target of `break`-like jumps out of the case bodies.
    const targets = new Set(this.cfg.blocks[block]!.succs);
    const counts = new Map<number, number>();
    for (const b of this.cfg.blocks) {
      if (b.kind !== 'jump' || b.id === block) continue;
      if (!dominatesBlock(this.cfg, block, b.id)) continue;
      const t = this.resolveTrivial(b.succs[0]!);
      if (targets.has(t) || t === block) continue;
      if (env.region && !env.region.has(t)) continue;
      if (!dominatesBlock(this.cfg, block, t) && !env.follows.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    let best = -1;
    for (const [t, n] of counts) if (best < 0 || n > counts.get(best)! || (n === counts.get(best)! && t > best)) best = t;
    // A "follow" that is only reached from inside one case is part of that case.
    if (best >= 0 && counts.get(best)! < 2) {
      const reachedFrom = [...targets].filter((t) => this.reaches(t, best, block));
      if (reachedFrom.length < 2) return -1;
    }
    return best;
  }

  private reaches(from: number, to: number, avoid: number): boolean {
    const seen = new Set<number>();
    const work = [from];
    while (work.length) {
      const x = work.pop()!;
      if (x === to) return true;
      if (seen.has(x) || x === avoid) continue;
      seen.add(x);
      work.push(...this.cfg.blocks[x]!.succs);
    }
    return false;
  }

  private emitSwitch(block: number, index: Expr, env: Env, stack: Expr[]): { stmt: Stmt; next: number } {
    const b = this.cfg.blocks[block]!;
    const follow = this.switchFollow(block, env);
    const { disc, values } = recoverSwitch(index);
    const targets = b.succs;
    const order = [...new Set(targets)].sort((x, y) => x - y);
    const cases: SwitchCase[] = [];
    for (let i = 0; i < order.length; i++) {
      const t = order[i]!;
      const next = order[i + 1];
      const follows = new Set([...env.follows, ...(follow >= 0 ? [follow] : []), ...(next !== undefined ? [next] : [])]);
      const caseEnv: Env = { ...env, follows, switchBreak: follow >= 0 ? follow : undefined };
      const body = t === follow ? [{ k: 'break' } as Stmt] : this.seq(t, caseEnv, stack);
      const labels: Array<Expr | null> = [];
      targets.forEach((tt, k) => {
        if (tt !== t) return;
        if (k === 0) labels.push(null);
        else if (!values) labels.push(lit(k - 1));
        else if (values.has(k - 1)) labels.push(values.get(k - 1)!);
        // Indices without a case value are the dispatcher's "no match" index (= default).
      });
      if (labels.length === 0) labels.push(null);
      // Default last among labels sharing a body, as compilers emit it.
      labels.sort((x, y) => (x === null ? 1 : 0) - (y === null ? 1 : 0));
      labels.forEach((l, k) => cases.push({ test: l, body: k === labels.length - 1 ? body : [] }));
    }
    // Drop "default: break;" when default jumps straight to the end.
    const last = cases[cases.length - 1];
    if (last && last.test === null && last.body.length === 1 && last.body[0]!.k === 'break' && targets[0] === follow) cases.pop();
    return { stmt: { k: 'switch', disc: disc ?? index, cases }, next: follow };
  }

  // -------------------------------------------------------------------------
  // try / catch
  // -------------------------------------------------------------------------

  private emitTry(g: TryGroup, env: Env, stack: Expr[]): { stmt: Stmt; next: number } {
    const savedScope = [...this.ctx.scope];
    const region = new Set<number>();
    for (let i = g.fromBlock; i < g.toBlock; i++) region.add(i);
    const activeTries = new Set([...env.activeTries, g.key]);
    const exits: number[] = [];
    const bodyEnv: Env = { ...env, region: intersect(region, env.region), exits, activeTries };
    const body = this.seq(g.fromBlock, bodyEnv, stack, true);
    const counts = new Map<number, number>();
    for (const x of exits) counts.set(x, (counts.get(x) ?? 0) + 1);
    let follow = -1;
    for (const [x, n] of counts) if (follow < 0 || n > counts.get(follow)!) follow = x;

    const catches = g.handlers.map(({ index, block }) => {
      const e = this.cfg.exceptions[index]!;
      const name = e.varName ? this.ctx.abc.multinameName(e.varName) : `e${index}`;
      this.ctx.catchNames.set(index, name);
      const type = e.excType ? this.ctx.typeName(e.excType) : '*';
      const follows = new Set([...env.follows, ...(follow >= 0 ? [follow] : [])]);
      const handlerEnv: Env = { ...env, follows, activeTries };
      // Handlers start with an empty scope stack (relative to init_scope_depth).
      this.ctx.scope.length = 0;
      const hbody = this.visited.has(block) ? [] : this.seq(block, handlerEnv, [{ k: 'name', name }]);
      return { name, type, body: hbody };
    });
    this.ctx.scope.length = 0;
    this.ctx.scope.push(...savedScope);
    return { stmt: { k: 'try', body, catches }, next: follow };
  }
}

function intersect(a: Set<number>, b?: ReadonlySet<number>): Set<number> {
  if (!b) return a;
  return new Set([...a].filter((x) => b.has(x)));
}

function commaOf(list: Expr[]): Expr | undefined {
  if (list.length === 0) return undefined;
  return list.reduceRight((acc: Expr | undefined, e) => (acc ? { k: 'binary', op: ',', a: e, b: acc } : e), undefined);
}

function makeIf(c: Expr, thenBody: Stmt[], elseBody: Stmt[]): Stmt {
  if (thenBody.length === 0 && elseBody.length > 0) return { k: 'if', c: not(c), then: elseBody };
  return elseBody.length ? { k: 'if', c, then: thenBody, else: elseBody } : { k: 'if', c, then: thenBody };
}

/**
 * Compilers lower `switch(x)` to a chain of `x === v ? index : ...` feeding
 * lookupswitch. Recovers the discriminant and index → case value mapping.
 */
function recoverSwitch(index: Expr): { disc?: Expr; values?: Map<number, Expr> } {
  const values = new Map<number, Expr>();
  let disc: Expr | undefined;
  let e: Expr = index;
  for (let guard = 0; guard < 10000 && e.k === 'cond'; guard++) {
    let c = e.c;
    let hit = e.t;
    let miss = e.f;
    if (c.k === 'binary' && c.op === '!==') {
      c = { ...c, op: '===' };
      [hit, miss] = [miss, hit];
    }
    if (c.k !== 'binary' || c.op !== '===' || hit.k !== 'lit' || typeof hit.v !== 'number') return {};
    const [x, v] = isRegLike(c.b) ? [c.b, c.a] : [c.a, c.b];
    if (disc && JSON.stringify(disc) !== JSON.stringify(x)) return {};
    disc = x;
    values.set(hit.v, v);
    e = miss;
  }
  if (!disc) return {};
  return { disc, values };
}

function isRegLike(e: Expr): boolean {
  const x = e.k === 'coerce' ? e.e : e;
  return x.k === 'local';
}
