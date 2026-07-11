// An illegal same-scope, same-signature duplicate (ADR-0028 case 4): ~<n> + flag.
export function twice(a: string): void {}
export function twice(a: string): void {}

class Repeated {}
class Repeated {}
