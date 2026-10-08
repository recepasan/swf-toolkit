package tests
{
   import flash.utils.Dictionary;

   // No constructor: field initialisers must still run.
   public class Bag
   {
      public var items:Array = [1, 2, 3];
      public var index:Dictionary = new Dictionary();
      public var name:String = "bag";
      public var count:int = items.length * 2;

      public function size():int
      {
         return items.length;
      }
   }
}
