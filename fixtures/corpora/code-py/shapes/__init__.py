# A directory with __init__.py is a Python package (a code:package via the
# directory-node rule); this __init__.py is an ordinary code:module named
# __init__.py whose declarations are its own children.
from .vectors import Vector


def package_hello() -> str:
    return "shapes"
