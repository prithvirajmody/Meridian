# 7E fixture — relative imports (submodule + names), absolute-external, and
# the honest treatment of a namespace-member call.
import math
from . import util
from .util import add, twice
from .models import Box, make


# Import-bound (tier 2) calls: `add`/`twice` resolve to app/util's functions;
# the two `twice` call-sites collapse to one edge, weight 2.
def compute(a: int, b: int) -> int:
    s = add(a, b)
    return twice(s) + twice(s)


# A tier-2 call resolving to app/models.make.
def build() -> Box:
    return make()


# `math.pi` is not a call; `math` itself is import-bound to an external module.
def area(r: float) -> float:
    return math.pi * r * r


# A namespace-member call `util.twice(...)`: a call on a value of unknown type,
# left unresolved (ADR-0026 does not infer that `util` is the module).
def indirect(n: int) -> int:
    return util.twice(n)
