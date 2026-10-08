package tests
{
   public class Square extends Base implements IShape
   {
      private var _side:Number;

      public function Square(side:Number)
      {
         super("square");
         _side = side;
      }

      public function area():Number
      {
         return _side * _side;
      }

      public function get side():Number
      {
         return _side;
      }

      public function set side(v:Number):void
      {
         _side = v;
      }

      override public function describe():String
      {
         return "Square(" + _side + ") " + super.describe();
      }
   }
}
