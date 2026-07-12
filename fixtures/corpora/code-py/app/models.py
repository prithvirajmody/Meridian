# 7E fixture — self.method() (tier 1 self) and a same-module class call.
class Box:
    def __init__(self, v: int):
        self.value = v

    def get(self) -> int:
        return self.value

    # Two `self.get()` call-sites collapse to ONE code:calls edge, weight 2.
    def doubled(self) -> int:
        return self.get() + self.get()


# A same-module call to the class `Box` (its constructor) → tier 1.
def make() -> Box:
    return Box(0)
