package tests
{
   public class Helper
   {
      public static const NAME:String = "helper";

      public static function twice(n:int):int
      {
         return n * 2;
      }

      public static function sum(...values):int
      {
         var t:int = 0;
         for each (var v:int in values) t += v;
         return t;
      }

      public static function greet(who:String = "world"):String
      {
         return "hi " + who;
      }
   }
}
