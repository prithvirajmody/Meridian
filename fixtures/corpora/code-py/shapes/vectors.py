class Vector:
    def __init__(self, x: float, y: float):
        self.x = x
        self.y = y

    def add(self, other: "Vector") -> "Vector":
        return Vector(self.x + other.x, self.y + other.y)


def dot(a: Vector, b: Vector) -> float:
    return a.x * b.x + a.y * b.y
