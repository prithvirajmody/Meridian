// Classes, methods, accessors, static, generator, abstract (eager: class + methods).
export class Circle {
  #hidden = 0;
  radius: number;
  constructor(radius: number) {
    this.radius = radius;
  }
  area(): number {
    return 3.141592653589793 * this.radius * this.radius;
  }
  get diameter(): number {
    return this.radius * 2;
  }
  set diameter(value: number) {
    this.radius = value / 2;
  }
  static unit(): Circle {
    return new Circle(1);
  }
  async *samples(): AsyncGenerator<number> {
    yield this.radius;
  }
  private scale = (k: number): Circle => new Circle(this.radius * k);
}

export abstract class Shape {
  abstract area(): number;
  describe(): string {
    return `area=${this.area()}`;
  }
}
