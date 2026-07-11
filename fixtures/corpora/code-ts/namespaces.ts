// Namespaces are scope containers (ADR-0028 ['ns','Type','member']).
export namespace Geo {
  export function distance(a: number, b: number): number {
    return Math.abs(a - b);
  }
  export class Point {
    constructor(public x: number, public y: number) {}
    norm(): number {
      return Math.hypot(this.x, this.y);
    }
  }
  export namespace Inner {
    export function tag(): string {
      return 'inner';
    }
  }
}
