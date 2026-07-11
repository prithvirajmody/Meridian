# @overload stubs (ADR-0028 case 2): #signatureHash discriminators, code:overload flag.
from typing import overload


@overload
def parse(value: int) -> str: ...
@overload
def parse(value: str) -> int: ...
@overload
def parse(value: bool) -> bytes: ...
def parse(value):
    return value


# Distinct return annotations are distinct overloads (return type in the hash).
@overload
def read() -> str: ...
@overload
def read(flag: bool) -> int: ...
def read(flag=False):
    return 1 if flag else "x"
