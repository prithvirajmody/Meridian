# 7E fixture — local calls and a dynamic dispatch.
def add(a: int, b: int) -> int:
    return a + b


# A same-module (tier 1) call: `add` binds to the module-level function above.
def twice(n: int) -> int:
    return add(n, n)


# A dynamic call: the callee is a subscript, not an identifier → unresolved.
def first(fns: list) -> int:
    return fns[0]()
