# Function definitions: plain, async, decorated, nested (body-lazy).
import os


def add(a: int, b: int) -> int:
    return a + b


async def fetch_all(urls: list[str]) -> list[str]:
    return urls


@staticmethod
def free_static(x: int) -> int:
    return x


def outer() -> None:
    # Nested declarations are body-internal (ADR-0028 case 3): NOT eager.
    def inner() -> None:
        pass

    helper = lambda n: n + 1
    del inner, helper
