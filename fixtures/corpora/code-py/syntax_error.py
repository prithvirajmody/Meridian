# Error-tolerant: tree-sitter recovers; the module is flagged, graph partial.
def healthy() -> int:
    return 1


def broken(:
    return 2


class StillHere:
    def ok(self) -> bool:
        return True
