# @meridian/view-model

The pure presentation waist introduced in Phase 5B. It turns an immutable graph
snapshot, resolved LOD cut, layout result, and identity selection into a flat,
structured-cloneable `RenderModel`. The renderer reads that value and nothing
upstream of it.

The package also owns the presentation geometry and layout I/O contracts moved
from `@meridian/layout` per ADR-0015/0022, pure geometric camera transforms, and
ADR-0020's exact CSS-pixel label-tier function. It has no DOM, Pixi, React,
zustand, graph-store, I/O, logging, or mutation.

`buildRenderModel` repairs hostile layout numbers into finite geometry and
returns located diagnostics as data. It never logs; the app shell chooses how to
surface those diagnostics.
