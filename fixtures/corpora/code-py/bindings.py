# Module-level bindings (ADR-0028 case 1): identity is the binding name.
# A lambda bound to a name is a function; a plain value binding is not eager.
scale = lambda value, factor: value * factor

VERSION = "1.0.0"  # plain binding — not in the eager level chain, not emitted.

compose = lambda f: lambda g: lambda x: f(g(x))
