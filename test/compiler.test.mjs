import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbcFile, compileClassSource, decompileClass, parseAs3, Swf } from '../dist/index.js';
import { buildFixtureSwf } from './helpers.mjs';

const SYNTAX = `
package a.b {
  import flash.display.*;
  [Event(name="change", type="flash.events.Event")]
  public dynamic class C extends Sprite implements I1, I2 {
    public static const K:Vector.<Vector.<int>> = null;
    mx_internal var hidden:* = undefined;
    { trace("static init"); }
    public function C(...rest) { super(); }
    override protected function get x():Number { return 1; }
    public function f(a:int = -1, b:String = "s"):void {
      var re:RegExp = /a[/]b/gi, n:Number = .5e3;
      outer: for each (var v:* in [1, 2]) { if (v is int) continue outer; }
      var o:Object = { "q": 1, k: [ , 2], 3: new <int>[1, 2] };
      a ||= b.length; a >>>= 2;
      var t = typeof o, d = delete o.q, i = "q" in o ? 1 : 2;
      do a--; while (a > 0)
      switch (a) { case 1: case 2: break; default: }
      try { throw new Error("x"); } catch (e:Error) {} finally {}
    }
  }
}`;

test('parser handles the AS3 surface syntax', () => {
  const unit = parseAs3(SYNTAX);
  assert.equal(unit.package, 'a.b');
  const c = unit.classes[0];
  assert.equal(c.name, 'C');
  assert.equal(c.isDynamic, true);
  assert.equal(c.implements.length, 2);
  assert.deepEqual(c.members.map((m) => m.k), ['field', 'field', 'static', 'method', 'method', 'method']);
  const getter = c.members[4];
  assert.equal(getter.kind, 'get');
  assert.equal(getter.isOverride, true);
});

test('parser reports positions', () => {
  assert.throws(() => parseAs3('package { class A { function f() { var = 1; } } }', 'A.as'), /A\.as:1:\d+/);
});

test('fixture program compiles into new classes', () => {
  const { abc, result } = buildFixtureSwf();
  const classes = result.changes.filter((c) => c.member === '<class>').map((c) => c.className);
  assert.deepEqual(classes, ['tests.IShape', 'tests.Base', 'tests.Square', 'tests.Helper', 'tests.Bag', 'Main']);
  assert.equal(abc.instances.length, 6);
});

test('decompile → compile → decompile is stable for compiled code', () => {
  const { abc } = buildFixtureSwf();
  for (let ci = 0; ci < abc.instances.length; ci++) {
    const before = decompileClass(abc, ci);
    const copy = AbcFile.parse(abc.toBytes());
    compileClassSource(copy, before, { baseline: null });
    const after = decompileClass(copy, ci);
    const norm = (s) => {
      const m = new Map();
      return s.replace(/_loc\d+_/g, (x) => (m.has(x) ? m.get(x) : (m.set(x, `_L${m.size}_`), m.get(x))));
    };
    assert.equal(norm(after), norm(before), abc.className(ci));
  }
});

test('only changed members are recompiled', () => {
  const { swf } = buildFixtureSwf();
  const abc = Swf.parse(swf.toBytes()).abcTags[0].abc;
  const ci = abc.findClass('tests.Helper');
  const src = decompileClass(abc, ci);
  const methodsBefore = abc.methods.length;
  const r = compileClassSource(abc, src.replace('"hi "', '"hey "'));
  assert.deepEqual(r.changes.map((c) => c.member), ['static greet']);
  assert.equal(abc.methods.length, methodsBefore);
  assert.match(decompileClass(abc, ci), /"hey "/);
});

test('new members are added to existing classes', () => {
  const { swf } = buildFixtureSwf();
  const abc = Swf.parse(swf.toBytes()).abcTags[0].abc;
  const ci = abc.findClass('tests.Square');
  const src = decompileClass(abc, ci).replace(/(\n   \}\n\}\n?)$/, `
      public static var made:int = 0;

      public function perimeter():Number
      {
         return 4 * side;
      }
$1`);
  const r = compileClassSource(abc, src);
  assert.deepEqual(r.changes.map((c) => `${c.action} ${c.member}`), ['added made', 'added perimeter']);
  assert.match(decompileClass(abc, ci), /public function perimeter\(\):Number/);
});

test('field initialisers run in classes without a constructor', () => {
  const abc = new AbcFile();
  const r = compileClassSource(abc, 'package { public class Box { public var items:Array = [1, 2]; public var n:String = "x"; } }');
  assert.ok(r.changes.some((c) => c.member === '<constructor>'));
  const out = decompileClass(abc, abc.findClass('Box'));
  assert.match(out, /this\.items = \[1, 2\];\s*\n\s*super\(\);/);
  assert.match(out, /public var n:String = "x";/);
});

test('missing constructor with a non-trivial existing one is an error, not data loss', () => {
  const abc = new AbcFile();
  compileClassSource(abc, 'package { public class Box { public function Box() { super(); trace("ctor"); } } }');
  assert.throws(
    () => compileClassSource(abc, 'package { public class Box { public var items:Array = []; } }', { source: 'Box.as' }),
    /Box\.as:1:\d+: Field 'items' has an initialiser.*no constructor/,
  );
});

test('compile errors carry file and position', () => {
  const abc = new AbcFile();
  assert.throws(() => compileClassSource(abc, 'package { public class X { function f() { break; } } }', { source: 'X.as' }), /X\.as:1:\d+: 'break' outside of a loop/);
});
