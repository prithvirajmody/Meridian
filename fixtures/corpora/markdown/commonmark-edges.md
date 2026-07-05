Setext Title
============

Preamble paragraph with an [external link](https://example.org) and an
autolink <https://example.net>.

Setext Section
--------------

#### Skipped Levels

A depth-4 heading directly under a depth-2 section.

# Fences & Code

```typescript
const x: number = 1;
```

```
no language fence
```

    indented code block
    second line

# Lists

- unordered one
- unordered two
  - nested a
  - nested b
    - deeper
1. ordered one
2. ordered two

# Quotes & Rules

> A blockquote with a [reference link][ref].
>
> > Nested quote.

---

<div class="raw">
an HTML block
</div>

# Unicode: café, 東京, עברית, é

Paragraph with combining characters: café vs café, emoji 🗺️, and RTL עִבְרִית.

# Duplicate

first

# Duplicate

second — its anchor gets a suffix.

[ref]: #setext-section
