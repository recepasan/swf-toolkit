package
{
   import flash.display.Sprite;
   import flash.utils.Dictionary;
   import tests.Bag;
   import tests.Helper;
   import tests.IShape;
   import tests.Square;

   public class Main extends Sprite
   {
      private static var log:Array = [];
      private var counter:int = 0;
      public var items:Array = [1, 2, 3];

      public function Main()
      {
         super();
         run();
      }

      private function check(name:String, actual:*, expected:*):void
      {
         var ok:Boolean = actual === expected;
         trace((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " expected=" + expected + " actual=" + actual));
      }

      private function run():void
      {
         // arithmetic & precedence
         check("arith", 1 + 2 * 3 - 4 / 2, 5);
         check("mod", 17 % 5, 2);
         check("bits", (0xF0 | 0x0F) & ~0x01 ^ 0x10, 0xEE);
         check("shift", (-16 >> 2) + (-16 >>> 28) + (1 << 4), 27);
         check("string concat", "a" + 1 + 2, "a12");
         check("ternary", counter > 0 ? "pos" : "zero", "zero");

         // locals, compound assignment, ++/--
         var i:int = 5;
         i += 3;
         i *= 2;
         i -= 1;
         i++;
         ++i;
         var j:int = i--;
         check("compound", i, 16);
         check("postfix value", j, 17);
         var n:Number = 1.5;
         n /= 2;
         check("number", n, 0.75);

         // fields and statics
         counter++;
         this.counter += 10;
         check("field", counter, 11);
         log.push("x");
         log.push("y");
         check("static", log.length, 2);
         check("array field", items[1], 2);
         items[1] += 40;
         check("index compound", items[1], 42);

         // loops
         var sum:int = 0;
         for (var k:int = 0; k < 10; k++)
         {
            if (k == 3) continue;
            if (k == 8) break;
            sum += k;
         }
         check("for/continue/break", sum, 25);
         var w:int = 0;
         while (w < 5) w++;
         check("while", w, 5);
         var d:int = 0;
         do { d += 2; } while (d < 7);
         check("do-while", d, 8);
         var keys:Array = [];
         var obj:Object = {a: 1, b: 2, c: 3};
         for (var key:String in obj) keys.push(key);
         keys.sort();
         check("for-in", keys.join(","), "a,b,c");
         var total:int = 0;
         for each (var v:int in obj) total += v;
         check("for-each", total, 6);
         outer: for (var x:int = 0; x < 3; x++)
         {
            for (var y:int = 0; y < 3; y++)
            {
               if (y == 1) continue outer;
               if (x == 2) break outer;
               total++;
            }
         }
         check("labels", total, 8);

         // switch
         check("switch 1", kind(5), "num");
         check("switch 2", kind("s"), "str");
         check("switch 3", kind(null), "other");
         check("switch fallthrough", fall(1), "abc");
         check("switch fallthrough 2", fall(2), "bc");

         // logical operators as values and conditions
         var nothing:Object = null;
         check("or value", nothing || "fallback", "fallback");
         check("and value", items && items.length, 3);
         check("and cond", (nothing != null && nothing.foo) ? 1 : 2, 2);
         check("not", !nothing, true);

         // closures capturing locals
         var acc:int = 0;
         var add:Function = function(a:int):void { acc += a; };
         add(5);
         add(7);
         check("closure", acc, 12);
         check("closure 2", makeCounter()() + makeCounter()(), 2);

         // try / catch / finally
         check("try/catch", safeParse("{bad"), "error");
         check("try ok", safeParse("{\"a\":5}"), "5");
         check("finally", withFinally(), "tf");

         // classes, interfaces, statics, getters/setters
         var sq:Square = new Square(3);
         check("method", sq.area(), 9);
         check("getter", sq.side, 3);
         sq.side = 4;
         check("setter", sq.area(), 16);
         var shape:IShape = sq;
         check("interface", shape.area(), 16);
         check("is", sq is IShape, true);
         check("as", (sq as Sprite) == null, true);
         check("static method", Helper.twice(21), 42);
         check("static const", Helper.NAME, "helper");
         check("super call", sq.describe(), "Square(4) shape");

         // typeof, delete, in, instanceof
         check("typeof", typeof 1 + typeof "s" + typeof undefined, "numberstringundefined");
         var o2:Object = {p: 1};
         delete o2.p;
         check("delete/in", "p" in o2, false);
         check("instanceof", items instanceof Array, true);

         // vectors, dictionary, regex, object/array literals
         var vec:Vector.<int> = new Vector.<int>();
         vec.push(3);
         vec.push(4);
         check("vector", vec.length + vec[1], 6);
         var lit:Vector.<String> = new <String>["x", "y"];
         check("vector literal", lit.join(""), "xy");
         var dict:Dictionary = new Dictionary();
         dict[sq] = "sq";
         check("dictionary", dict[sq], "sq");
         check("regex", "a1b22c333".replace(/\d+/g, "#"), "a#b#c#");
         check("nested literal", {list: [1, {z: "deep"}]}.list[1].z, "deep");

         // conversions
         check("int()", int("42") + 1, 43);
         check("String()", String(12) + "", "12");
         check("Number", Number("1.5") * 2, 3);
         check("rest", Helper.sum(1, 2, 3, 4), 10);
         check("default param", Helper.greet(), "hi world");

         // field initialisers in a class without a constructor
         var bag:Bag = new Bag();
         check("implicit ctor: array init", bag.size(), 3);
         check("implicit ctor: object init", bag.index != null, true);
         check("implicit ctor: constant init", bag.name, "bag");
         check("implicit ctor: dependent init", bag.count, 6);

         trace("DONE");
      }

      private function kind(x:*):String
      {
         switch (typeof x)
         {
            case "number":
               return "num";
            case "string":
               return "str";
            default:
               return "other";
         }
      }

      private function fall(n:int):String
      {
         var s:String = "";
         switch (n)
         {
            case 1:
               s += "a";
            case 2:
               s += "b";
               s += "c";
               break;
            case 3:
               s += "z";
         }
         return s;
      }

      private function makeCounter():Function
      {
         var c:int = 0;
         return function():int { return ++c; };
      }

      private function safeParse(s:String):String
      {
         try
         {
            return String(JSON.parse(s).a);
         }
         catch (e:Error)
         {
            return "error";
         }
         return "unreachable";
      }

      private function withFinally():String
      {
         var r:String = "";
         try
         {
            r += "t";
         }
         finally
         {
            r += "f";
         }
         return r;
      }
   }
}
