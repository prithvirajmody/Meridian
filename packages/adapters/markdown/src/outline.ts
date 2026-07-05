/**
 * CommonMark → outline tree. Pure structure (the deterministic exemplar,
 * ARCHITECTURE.md §7.3): headings nest sections by depth (ragged depths
 * welcome — an h3 under an h1 is simply its child), every other top-level
 * block becomes a leaf. Inline content is flattened to labels; internal
 * anchor links are collected for edge derivation, never resolved here.
 *
 * Parser: markdown-it in strict `commonmark` preset. Chosen over the
 * micromark/mdast stack for throughput — the Phase 2 perf budget (5MB book
 * < 2s) is a CI gate, and micromark measured ~40× slower on it. Spans are
 * line-aligned byte offsets from token maps, identical to exact block spans
 * for CommonMark's line-oriented blocks.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

export type BlockType = 'paragraph' | 'code' | 'list' | 'quote' | 'html' | 'break';

export interface OutlineBlock {
  readonly kind: 'block';
  readonly type: BlockType;
  readonly label: string;
  readonly span?: readonly [number, number];
  readonly attrs: Readonly<Record<string, string | number | boolean>>;
  /** In-document anchor targets (`#slug`) linked from inside this block. */
  readonly anchors: readonly string[];
}

export interface OutlineSection {
  readonly kind: 'section';
  readonly title: string;
  /** Heading depth as written (1–6). */
  readonly depth: number;
  /** Per-parent unique ID segment (`sec-slug` or `sec-slug~n` for repeats). */
  readonly segment: string;
  /** Document-global GitHub-style anchor slug. */
  readonly anchor: string;
  readonly span?: readonly [number, number];
  readonly anchors: readonly string[];
  readonly children: readonly OutlineChild[];
}

export type OutlineChild = OutlineSection | OutlineBlock;

export interface Outline {
  /** First heading's text, if the document has one. */
  readonly title?: string;
  readonly children: readonly OutlineChild[];
}

const MAX_LABEL = 80;

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_LABEL ? `${collapsed.slice(0, MAX_LABEL - 1)}…` : collapsed;
}

/** GitHub-style anchor slug of a heading's text (before de-duplication). */
function githubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/** Flatten one `inline` token's children to plain text. */
function inlineText(tokens: readonly Token[]): string {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'code_inline':
        out += t.content;
        break;
      case 'image':
        out += t.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      default:
        break;
    }
  }
  return out;
}

function inlineAnchors(tokens: readonly Token[], into: string[]): void {
  for (const t of tokens) {
    if (t.type === 'link_open') {
      const href = t.attrGet('href');
      if (href !== null && href.startsWith('#')) into.push(href.slice(1));
    }
  }
}

interface MutableSection {
  kind: 'section';
  title: string;
  depth: number;
  segment: string;
  anchor: string;
  span?: readonly [number, number];
  anchors: readonly string[];
  children: (MutableSection | OutlineBlock)[];
}

/** Deterministic outline of one CommonMark text. */
export function buildOutline(text: string): Outline {
  const md = new MarkdownIt('commonmark');
  const tokens = md.parse(text, {});

  // Line-start offsets, so token maps ([startLine, endLine)) become byte
  // spans; the end excludes the final newline.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const spanOf = (map: [number, number] | null): readonly [number, number] | undefined => {
    if (map === null) return undefined;
    const [startLine, endLine] = map;
    const start = lineStarts[startLine];
    if (start === undefined) return undefined;
    const end = endLine < lineStarts.length ? lineStarts[endLine]! - 1 : text.length;
    return [start, Math.max(start, end)];
  };

  const top: (MutableSection | OutlineBlock)[] = [];
  const stack: MutableSection[] = [];
  const anchorCounts = new Map<string, number>();
  const segmentCounts = new Map<string, number>();
  let title: string | undefined;

  const siblings = (): (MutableSection | OutlineBlock)[] =>
    stack.length === 0 ? top : stack[stack.length - 1]!.children;

  const pushBlock = (
    type: BlockType,
    label: string,
    span: readonly [number, number] | undefined,
    attrs: Record<string, string | number | boolean>,
    anchors: readonly string[],
  ): void => {
    siblings().push({
      kind: 'block',
      type,
      label,
      ...(span !== undefined ? { span } : {}),
      attrs,
      anchors,
    });
  };

  /** Collect every `inline` token until the matching `…_close` at this
   * nesting level; returns [plainText, anchors, directItemCount, nextIndex]. */
  const consumeContainer = (
    from: number,
    closeType: string,
    openLevel: number,
  ): { text: string; anchors: string[]; items: number; next: number } => {
    let textAcc = '';
    const anchors: string[] = [];
    let items = 0;
    let i = from + 1;
    for (; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type === closeType && t.level === openLevel) break;
      if (t.type === 'inline' && t.children !== null) {
        if (textAcc.length < MAX_LABEL * 4) textAcc += `${inlineText(t.children)} `;
        inlineAnchors(t.children, anchors);
      }
      if (t.type === 'list_item_open' && t.level === openLevel + 1) items += 1;
    }
    return { text: textAcc, anchors, items, next: i };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.level !== 0) continue;

    switch (token.type) {
      case 'heading_open': {
        const inline = tokens[i + 1];
        const children = inline?.type === 'inline' ? (inline.children ?? []) : [];
        const headingText = inlineText(children);
        title ??= excerpt(headingText);
        const depth = Number(token.tag.slice(1));
        while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();

        const slugBase = githubSlug(headingText);
        const anchorSeen = anchorCounts.get(slugBase) ?? 0;
        anchorCounts.set(slugBase, anchorSeen + 1);
        const anchor = anchorSeen === 0 ? slugBase : `${slugBase}-${anchorSeen}`;

        const parentKey = `${stack.map((s) => s.segment).join(' ')} ${slugBase}`;
        const segmentSeen = segmentCounts.get(parentKey) ?? 0;
        segmentCounts.set(parentKey, segmentSeen + 1);
        const segment = segmentSeen === 0 ? `sec-${slugBase}` : `sec-${slugBase}~${segmentSeen}`;

        const anchors: string[] = [];
        inlineAnchors(children, anchors);
        const span = spanOf(token.map);
        const section: MutableSection = {
          kind: 'section',
          title: excerpt(headingText),
          depth,
          segment,
          anchor,
          ...(span !== undefined ? { span } : {}),
          anchors,
          children: [],
        };
        siblings().push(section);
        stack.push(section);
        i += 2; // skip inline + heading_close
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        const children = inline?.type === 'inline' ? (inline.children ?? []) : [];
        const anchors: string[] = [];
        inlineAnchors(children, anchors);
        pushBlock('paragraph', excerpt(inlineText(children)), spanOf(token.map), {}, anchors);
        i += 2;
        break;
      }
      case 'fence': {
        const lang = token.info.trim().split(/\s+/, 1)[0] ?? '';
        pushBlock(
          'code',
          excerpt(token.content.split('\n', 1)[0] ?? ''),
          spanOf(token.map),
          lang.length > 0 ? { 'doc:lang': lang } : {},
          [],
        );
        break;
      }
      case 'code_block': {
        pushBlock('code', excerpt(token.content.split('\n', 1)[0] ?? ''), spanOf(token.map), {}, []);
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const closeType =
          token.type === 'bullet_list_open' ? 'bullet_list_close' : 'ordered_list_close';
        const c = consumeContainer(i, closeType, token.level);
        pushBlock(
          'list',
          excerpt(c.text),
          spanOf(token.map),
          { 'doc:items': c.items, 'doc:ordered': token.type === 'ordered_list_open' },
          c.anchors,
        );
        i = c.next;
        break;
      }
      case 'blockquote_open': {
        const c = consumeContainer(i, 'blockquote_close', token.level);
        pushBlock('quote', excerpt(c.text), spanOf(token.map), {}, c.anchors);
        i = c.next;
        break;
      }
      case 'hr': {
        pushBlock('break', '···', spanOf(token.map), {}, []);
        break;
      }
      case 'html_block': {
        pushBlock('html', excerpt(token.content), spanOf(token.map), {}, []);
        break;
      }
      default:
        break;
    }
  }

  return {
    ...(title !== undefined ? { title } : {}),
    children: top,
  };
}
