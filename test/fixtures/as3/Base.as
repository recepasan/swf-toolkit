package tests
{
   public class Base
   {
      protected var label:String;

      public function Base(label:String)
      {
         this.label = label;
      }

      public function describe():String
      {
         return "shape";
      }
   }
}
