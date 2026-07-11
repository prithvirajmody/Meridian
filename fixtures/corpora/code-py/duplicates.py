# Same-scope redefinition duplicates (ADR-0028 case 4): ~<n> + code:duplicate flag.
# Legal in Python (the later binding wins at runtime); still flagged honestly.
def twice(a: str) -> None:
    pass


def twice(a: str) -> None:
    pass


class Repeated:
    pass


class Repeated:
    pass
