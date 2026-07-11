export class Vector {
  constructor(public x: number, public y: number) {}
  add(other: Vector): Vector {
    return new Vector(this.x + other.x, this.y + other.y);
  }
}

export function dot(a: Vector, b: Vector): number {
  return a.x * b.x + a.y * b.y;
}
