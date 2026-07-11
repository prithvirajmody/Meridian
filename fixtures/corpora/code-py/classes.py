# Classes: methods, staticmethod, classmethod, property, nested class (eager members).
import math


class Circle:
    PI = 3.141592653589793  # plain class attribute — not in the eager level chain.

    def __init__(self, radius: float):
        self.radius = radius

    def area(self) -> float:
        return Circle.PI * self.radius * self.radius

    @staticmethod
    def unit() -> "Circle":
        return Circle(1)

    @classmethod
    def of_diameter(cls, d: float) -> "Circle":
        return cls(d / 2)

    @property
    def diameter(self) -> float:
        return self.radius * 2

    @diameter.setter
    def diameter(self, value: float) -> None:
        self.radius = value / 2

    class Meta:
        # A nested class is an eager member of its enclosing class.
        def describe(self) -> str:
            return "circle"


class Shape:
    def area(self) -> float:
        raise NotImplementedError
