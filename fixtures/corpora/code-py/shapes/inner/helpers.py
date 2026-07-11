def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


lerp = lambda a, b, t: a + (b - a) * t
