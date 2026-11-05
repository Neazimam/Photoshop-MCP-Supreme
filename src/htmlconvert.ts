/**
 * HTML/CSS → Photoshop layer-spec converter (server side).
 *
 * Parses an AI-generated HTML page, cascades its CSS, runs a pragmatic layout
 * pass (absolute positioning, block flow, basic flex) and emits a flat-serializable
 * spec the UXP plugin turns into real editable layers (shape/text/image/group).
 *
 * Convention: `children` arrays are ordered paint-order TOP→BOTTOM; the plugin
 * creates layers from the END of the array first (bottom-up), so later DOM
 * elements end up on top exactly like a browser paints them.
 *
 * Philosophy: never silently mis-render. Anything unsupported becomes a warning
 * the user sees in the dashboard / tool result.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse, type HTMLElement } from 'node-html-parser';
import {
  computeDecls, parseColor, parseCssText, parseFontFamily, parseGradient, parseLength,
  parseRadii, parseShadows, splitTopLevel,
  type CssRule, type LinearGradient, type RGBA, type Radii, type Shadow,
} from './htmlcss.js';

// ---------------------------------------------------------------- spec types

export interface SpecFill {
  type: 'solid' | 'gradient';
  color?: RGBA;
  grad?: LinearGradient;
}

export interface SpecRect { x: number; y: number; w: number; h: number }

export interface SpecTextNode {
  content: string;
  fontSize: number;
  weight: number;
  italic: boolean;
  family: string;
  color: RGBA;
  tracking: number; // 1/1000 em
  leading: number; // px
  align: 'left' | 'center' | 'right';
  underline?: boolean;
  lineThrough?: boolean;
  /** set when the CSS width forces wrapping — plugin creates a paragraph (box) text layer */
  boxWidth?: number;
}

/** Per-character style override inside a text layer (mixed inline styles, e.g. <b> inside a heading). */
export interface SpecTextRange {
  from: number; // UTF-16 offset into content (inclusive)
  to: number; // exclusive
  weight?: number;
  italic?: boolean;
  color?: RGBA;
  underline?: boolean;
  lineThrough?: boolean;
  fontSize?: number;
  family?: string;
}

export interface SpecImageNode {
  kind: 'path' | 'url' | 'data';
  value: string;
  fit: 'stretch' | 'cover' | 'contain';
}

export interface SpecFilter {
  kind: 'blur' | 'grayscale' | 'brightness' | 'contrast' | 'saturate' | 'invert' | 'sepia' | 'hue-rotate';
  /** px for blur; multiplier for brightness/contrast/saturate (1 = unchanged); 0-1 for grayscale/sepia; degrees for hue-rotate */
  value: number;
}

export interface SpecNode {
  kind: 'group' | 'shape' | 'text' | 'image';
  name: string;
  rect: SpecRect;
  opacity: number; // 0-100
  blend?: string; // Photoshop BlendMode key
  /** CSS transform rotation, degrees clockwise around the node center */
  rotate?: number;
  /** CSS transform scale around the node center (1 = unchanged) */
  scale?: { x: number; y: number };
  /** CSS filter subset the plugin can apply as real Photoshop filters */
  filters?: SpecFilter[];
  fill?: SpecFill | null;
  stroke?: { width: number; color: RGBA } | null;
  radius?: Radii | null;
  shadow?: Shadow | null;
  innerShadow?: Shadow | null;
  children?: SpecNode[];
  text?: SpecTextNode;
  image?: SpecImageNode;
}

export interface HtmlSpec {
  canvas: { w: number; h: number; background: SpecFill | null };
  elements: SpecNode[];
  stats: { nodes: number; images: number };
  warnings: string[];
}

// ------------------------------------------------------------ block elements

const BLOCK = new Set(['div','p','h1','h2','h3','h4','h5','h6','section','header','footer','nav','main','article','aside','ul','ol','li','table','thead','tbody','tr','td','th','form','fieldset','figure','figcaption','blockquote','pre','hr','address','dl','dt','dd','button','label']);
const SKIP = new Set(['script','style','link','meta','title','head','noscript','template','br','svg','iframe','canvas','video','audio','source','path','circle','rect','g','defs']);
const INLINE_TEXT = new Set(['span','a','b','strong','i','em','small','sub','sup','u','s','mark','code','abbr','time','cite','q','kbd','samp','var','del','ins']);

/** Minimal UA stylesheet so margins/heading sizes match a browser roughly. */
const UA_CSS = `
body{margin:8px}
h1{font-size:2em;font-weight:700;margin:.67em 0}
h2{font-size:1.5em;font-weight:700;margin:.83em 0}
h3{font-size:1.17em;font-weight:700;margin:1em 0}
h4{font-size:1em;font-weight:700;margin:1.33em 0}
h5{font-size:.83em;font-weight:700;margin:1.67em 0}
h6{font-size:.67em;font-weight:700;margin:2.33em 0}
p,ul,ol,blockquote,figure,pre{margin:1em 0}
ul,ol{padding-left:40px}
b,strong{font-weight:700}
i,em,cite,var{font-style:italic}
`;

const BLEND: Record<string, string> = {
  normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', darken: 'DARKEN',
  lighten: 'LIGHTEN', 'color-dodge': 'COLORDODGE', 'color-burn': 'COLORBURN', 'hard-light': 'HARDLIGHT',
  'soft-light': 'SOFTLIGHT', difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
  saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY',
};

interface Box {
  el: HTMLElement;
  tag: string;
  classes: string[];
  decls: Record<string, string>;
  children: Box[];
  parent: Box | null;
  rect: SpecRect;
  text: string | null;
  style: TextStyle | null;
  image: { kind: 'path' | 'url' | 'data'; value: string; fit: 'stretch' | 'cover' | 'contain' } | null;
  clipChildren: boolean;
  zIndex: number;
  /** true when the box shrunk to fit content (inline-level) — block boxes always use box text */
  inlineShrink?: boolean;
  /** per-character style overrides collected while reading the leaf text (mixed inline styles) */
  ranges?: SpecTextRange[];
}

interface TextStyle {
  fontSize: number; weight: number; italic: boolean; family: string; color: RGBA;
  tracking: number; leading: number; align: 'left' | 'center' | 'right';
  underline: boolean; lineThrough: boolean;
}

interface Ctx {
  rules: CssRule[]; // author rules (win)
  uaRules: CssRule[]; // UA defaults (fill gaps only)
  rootFontSize: number;
  warnings: string[];
  /** canvas size that vw/vh/vmin/vmax resolve against (probe first, final later) */
  vpW: number;
  vpH: number;
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

/** Viewport fields for parseLength so vw/vh resolve against the real canvas. */
const vpOf = (ctx: Ctx): { viewportW: number; viewportH: number } => ({ viewportW: ctx.vpW, viewportH: ctx.vpH });

function warn(ctx: Ctx, msg: string): void {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}

function tagOf(el: HTMLElement): string {
  const anyEl = el as unknown as { rawTagName?: string; tagName?: string };
  return (anyEl.rawTagName ?? anyEl.tagName ?? 'div').toLowerCase();
}

// ------------------------------------------------------------------ walk DOM

function collectStyleText(root: HTMLElement): string {
  let css = '';
  for (const s of root.querySelectorAll('style')) css += '\n' + (s.textContent ?? '');
  return css;
}

/** true if all element descendants are inline tags (leaf text block candidate) */
function isLeafTextBlock(box: Box): boolean {
  const walk = (b: Box): boolean => {
    for (const c of b.children) {
      if (BLOCK.has(c.tag) || c.tag === 'img') return false;
      if (!walk(c)) return false;
    }
    return true;
  };
  return walk(box);
}

/** true when an inline subtree draws its own box (background/border/shadow/padding/size) —
 * those must become real layers, not be merged into the parent's text run. */
function isVisualInline(b: Box): boolean {
  const d = b.decls;
  if (['background', 'background-color', 'background-image', 'box-shadow', 'padding', 'width', 'height', 'border-radius', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left'].some((k) => d[k] != null)) return true;
  return b.children.some(isVisualInline);
}

type Node2 = { nodeType: number; childNodes: Node2[]; text?: string };

/** Read a leaf text block WITH its mixed inline styles: every <b>/<i>/<span style>/…
 * becomes a SpecTextRange (offsets into the collapsed, trimmed string). */
function collectStyledText(box: Box, pre: boolean): { text: string; ranges: SpecTextRange[] } {
  type Seg = { ch: string; box: Box | null };
  const out: Seg[] = [];
  const pushText = (t: string, b: Box | null) => {
    for (const ch of t) out.push({ ch, box: b });
  };
  const walkEl = (el: HTMLElement, b: Box | null): void => {
    let ci = 0; // buildTree pushed a Box for every non-skipped element child, in order
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        pushText(pre ? ((node as unknown as { text?: string }).text ?? '').replace(/\n/g, '\r') : (node as unknown as { text?: string }).text ?? '', b);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const childEl = node as unknown as HTMLElement;
      const tg = tagOf(childEl);
      if (tg === 'br') {
        pushText('\r', b);
        continue;
      }
      if (SKIP.has(tg)) continue;
      const cb = b && ci < b.children.length ? b.children[ci] : null;
      ci++;
      walkEl(childEl, cb);
    }
  };
  walkEl(box.el, box);
  // collapse whitespace (CSS white-space processing) while keeping per-char styles
  const fin: Seg[] = [];
  for (const seg of out) {
    const ch = seg.ch;
    if (ch === '\r') {
      if (fin.length && fin[fin.length - 1].ch === '\r') continue;
      fin.push(seg);
      continue;
    }
    if (/\s/.test(ch)) {
      if (!pre) {
        if (!fin.length || fin[fin.length - 1].ch === ' ' || fin[fin.length - 1].ch === '\r') continue;
        fin.push({ ch: ' ', box: seg.box });
      } else fin.push(seg);
      continue;
    }
    fin.push(seg);
  }
  while (fin.length && /\s|\r/.test(fin[0].ch)) fin.shift();
  while (fin.length && /\s|\r/.test(fin[fin.length - 1].ch)) fin.pop();
  const text = fin.map((s) => s.ch).join('');
  const base = box.style!;
  const ranges: SpecTextRange[] = [];
  let i = 0;
  while (i < fin.length) {
    const b = fin[i].box;
    let j = i;
    while (j < fin.length && fin[j].box === b) j++;
    if (b && b !== box && b.style) {
      const st = b.style;
      const d: SpecTextRange = { from: i, to: j };
      if (st.weight !== base.weight) d.weight = st.weight;
      if (st.italic !== base.italic) d.italic = st.italic;
      if (st.color.r !== base.color.r || st.color.g !== base.color.g || st.color.b !== base.color.b || st.color.a !== base.color.a) d.color = st.color;
      if (st.underline !== base.underline) d.underline = st.underline;
      if (st.lineThrough !== base.lineThrough) d.lineThrough = st.lineThrough;
      if (Math.abs(st.fontSize - base.fontSize) > 0.5) d.fontSize = st.fontSize;
      if (st.family !== base.family) d.family = st.family;
      if (d.weight != null || d.italic != null || d.color != null || d.underline != null || d.lineThrough != null || d.fontSize != null || d.family != null) ranges.push(d);
    }
    i = j;
  }
  return { text, ranges };
}

function applyTransform(text: string, tt: string | undefined): string {
  switch ((tt ?? '').toLowerCase()) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'capitalize': return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default: return text;
  }
}

function buildTree(el: HTMLElement, parent: Box | null, ctx: Ctx, depth: number): Box | null {
  const tag = tagOf(el);
  if (SKIP.has(tag) || depth > 24) return null;
  const classes: string[] = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const match = { tag, classes, id: el.id ?? null, styleAttr: el.getAttribute('style') ?? null };
  // author CSS wins over UA defaults property-by-property
  const decls = { ...computeDecls(ctx.uaRules, match), ...computeDecls(ctx.rules, match) };
  const display = (decls['display'] ?? '').toLowerCase();
  if (display === 'none' || el.getAttribute('hidden') != null) return null;

  const box: Box = {
    el, tag, classes, decls, children: [], parent,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    text: null, style: null, image: null,
    clipChildren: (decls['overflow'] ?? '').trim() === 'hidden',
    zIndex: isFinite(parseFloat(decls['z-index'] ?? '')) ? parseFloat(decls['z-index']) : 0,
  };

  // compute inherited style FIRST so children can inherit from it
  const fontSize = parseLength(decls['font-size'], { rootFontSize: ctx.rootFontSize, base: num(parent?.style?.fontSize), ...vpOf(ctx) })
    ?? parent?.style?.fontSize ?? 16;
  const weightRaw = decls['font-weight'] ?? '';
  const parentWeight = parent?.style?.weight ?? 400;
  const weight = /^(bold|[6-9]00)$/i.test(weightRaw) ? 700 : /^[1-5]00$/.test(weightRaw) ? parseInt(weightRaw, 10) : parentWeight;
  const italic = /^(italic|oblique)$/i.test(decls['font-style'] ?? '') || ['i', 'em', 'cite', 'var'].includes(tag) || !!parent?.style?.italic;
  const lhRaw = decls['line-height'];
  const lhNum = parseFloat(lhRaw ?? '');
  const leading = isFinite(lhNum) && !String(lhRaw).trim().endsWith('px')
    ? lhNum * fontSize
    : parseLength(lhRaw, { fontSize, rootFontSize: ctx.rootFontSize }) ?? fontSize * 1.25;

  const ls = parseLength(decls['letter-spacing'], { fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  // text-decoration: underline / line-through (plain or as text-decoration-line; inherits)
  const deco = ((decls['text-decoration'] ?? '') + ' ' + (decls['text-decoration-line'] ?? '')).toLowerCase();

  box.style = {
    fontSize,
    weight: ['b', 'strong'].includes(tag) ? 700 : weight,
    italic,
    family: parseFontFamily(decls['font-family']) ?? parent?.style?.family ?? 'Arial',
    color: parseColor(decls['color']) ?? parent?.style?.color ?? { r: 0, g: 0, b: 0, a: 1 },
    tracking: 0,
    leading,
    align: ((decls['text-align'] ?? 'left').toLowerCase()) as TextStyle['align'],
    underline: /underline/.test(deco) || !!(parent?.style?.underline),
    lineThrough: /line-through/.test(deco) || !!(parent?.style?.lineThrough),
  };
  if (ls) box.style.tracking = Math.round((ls / fontSize) * 1000);

  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const b = buildTree(child as HTMLElement, box, ctx, depth + 1);
    if (b) box.children.push(b);
  }

  const isFlexContainer = display.includes('flex') || display === 'grid';
  if (
    !box.children.length ||
    (!isFlexContainer && box.children.every((c) => INLINE_TEXT.has(c.tag) && !isVisualInline(c)) && isLeafTextBlock(box))
  ) {
    const pre = /^(pre|pre-line|pre-wrap)$/i.test(decls['white-space'] ?? '');
    const rich = collectStyledText(box, pre);
    if (rich.text.trim()) {
      box.text = applyTransform(rich.text.trim(), decls['text-transform']);
      if (rich.ranges.length) box.ranges = rich.ranges;
    }
  }

  const bgImg = decls['background-image'] ?? '';
  const urlM = bgImg.match(/url\((['"]?)([^)'"]+)\1\)/i);
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? el.getAttribute('data-src') ?? '';
    if (src) box.image = { kind: imgKind(src), value: src, fit: fitOf(decls) };
    else warn(ctx, '<img> without src was skipped');
  } else if (urlM) {
    box.image = { kind: imgKind(urlM[2]), value: urlM[2].trim(), fit: fitOf(decls) };
  }
  return box;
}

function imgKind(src: string): 'path' | 'url' | 'data' {
  if (/^data:/i.test(src)) return 'data';
  if (/^https?:\/\//i.test(src)) return 'url';
  return 'path';
}

function fitOf(decls: Record<string, string>): 'stretch' | 'cover' | 'contain' {
  const f = (decls['object-fit'] ?? decls['background-size'] ?? '').toLowerCase();
  if (f.startsWith('cover')) return 'cover';
  if (f.startsWith('contain')) return 'contain';
  return 'stretch';
}

// ------------------------------------------------------------------- layout

interface Pad { top: number; right: number; bottom: number; left: number }

/** CSS default is content-box: explicit width/height exclude padding+border, so the real
 * border-box is bigger. Pages with *{box-sizing:border-box} (most) are unchanged. */
function isBorderBox(decls: Record<string, string>): boolean {
  return ((decls['box-sizing'] ?? '').toLowerCase().trim() || 'content-box') === 'border-box';
}

/** Extra px an explicit content-box width/height must add (padding + per-side border). */
function contentBoxExtra(decls: Record<string, string>, fs: number, ctx: Ctx): { w: number; h: number } {
  if (isBorderBox(decls)) return { w: 0, h: 0 };
  const pad = padOf(decls, fs, ctx.rootFontSize, vpOf(ctx));
  const bs = borderSides(decls, fs, ctx);
  return {
    w: pad.left + pad.right + (bs.left?.width ?? 0) + (bs.right?.width ?? 0),
    h: pad.top + pad.bottom + (bs.top?.width ?? 0) + (bs.bottom?.width ?? 0),
  };
}

function padOf(decls: Record<string, string>, fs: number, root: number, vp?: { viewportW: number; viewportH: number }): Pad {
  const one = (v: string | undefined) => parseLength(v, { fontSize: fs, rootFontSize: root, ...vp }) ?? 0;
  if (decls['padding'] != null) {
    const vals = splitTopLevel(decls['padding'], ' ').map((x) => one(x));
    return {
      top: vals[0] ?? 0,
      right: vals[1] ?? vals[0] ?? 0,
      bottom: vals[2] ?? vals[0] ?? 0,
      left: vals[3] ?? vals[1] ?? vals[0] ?? 0,
    };
  }
  return {
    top: one(decls['padding-top']), right: one(decls['padding-right']),
    bottom: one(decls['padding-bottom']), left: one(decls['padding-left']),
  };
}

function marginOf(decls: Record<string, string>, fs: number, root: number, vp?: { viewportW: number; viewportH: number }): Pad {
  const one = (v: string | undefined) => parseLength(v, { fontSize: fs, rootFontSize: root, ...vp }) ?? 0;
  if (decls['margin'] != null) {
    const vals = splitTopLevel(decls['margin'], ' ').map((x) => one(x));
    return {
      top: vals[0] ?? 0,
      right: vals[1] ?? vals[0] ?? 0,
      bottom: vals[2] ?? vals[0] ?? 0,
      left: vals[3] ?? vals[1] ?? vals[0] ?? 0,
    };
  }
  return {
    top: one(decls['margin-top']), right: one(decls['margin-right']),
    bottom: one(decls['margin-bottom']), left: one(decls['margin-left']),
  };
}

/** Per-character advance widths (fraction of font-size, ~Helvetica/Arial averages). */
const charW = (ch: string): number => {
  if ("iIl1jft!.,:;|'`".includes(ch)) return 0.3;
  if ('mwMW@'.includes(ch)) return 0.86;
  if (ch === ' ') return 0.28;
  if (ch >= '0' && ch <= '9') return 0.556;
  if (ch >= 'A' && ch <= 'Z') return /[BDERVHKNTUWX]/.test(ch) ? 0.7 : 0.68;
  if (ch === '—' || ch === '–') return 1.0;
  if (ch.codePointAt(0)! > 0x2e80) return 1.0; // CJK / full-width
  return 0.53;
};

/** Estimate rendered text width in px — drives auto-sizing and wrap decisions. */
const estimateTextW = (text: string, fs: number, weight: number): number => {
  const lines = text.split('\r');
  const boldMul = weight >= 600 ? 1.04 : 1;
  const w = (line: string) => [...line].reduce((s, ch) => s + charW(ch), 0) * fs * boldMul;
  return Math.max(...lines.map(w), 1);
};

/** Shift a laid-out Box subtree by (dx, dy) — used for position:relative offsets. */
function shiftBox(b: Box, dx: number, dy: number): void {
  if (!dx && !dy) return;
  b.rect.x += dx;
  b.rect.y += dy;
  for (const k of b.children) shiftBox(k, dx, dy);
}

/** position: relative — top/left/right/bottom shift the laid-out subtree. */
function relativeOffset(decls: Record<string, string>, rect: SpecRect, fs: number, ctx: Ctx): { dx: number; dy: number } {
  if (!/^relative$/i.test((decls['position'] ?? '').trim())) return { dx: 0, dy: 0 };
  const l = parseLength(decls['left'], { base: rect.w, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const r = parseLength(decls['right'], { base: rect.w, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const t = parseLength(decls['top'], { base: rect.h, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const b = parseLength(decls['bottom'], { base: rect.h, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  return { dx: l ?? (r != null ? -r : 0), dy: t ?? (b != null ? -b : 0) };
}

/** Enforce min-/max-width and min-/max-height after a box is sized. */
function clampSize(box: Box, ctx: Ctx): void {
  const fs = box.style?.fontSize ?? 16;
  const minW = parseLength(box.decls['min-width'], { fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const maxW = parseLength(box.decls['max-width'], { fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const minH = parseLength(box.decls['min-height'], { fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const maxH = parseLength(box.decls['max-height'], { fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  if (minW != null) box.rect.w = Math.max(box.rect.w, minW);
  if (maxW != null) box.rect.w = Math.min(box.rect.w, maxW);
  if (minH != null) box.rect.h = Math.max(box.rect.h, minH);
  if (maxH != null) box.rect.h = Math.min(box.rect.h, maxH);
}

/** true if the margin shorthand/longhand for this side contains `auto`. */
function autoMargin(decls: Record<string, string>, side: 'left' | 'right'): boolean {
  const has = (v: string | undefined) => v != null && v.trim().split(/\s+/).some((x) => /^auto$/i.test(x));
  return side === 'left' ? has(decls['margin-left']) || has(decls['margin']) : has(decls['margin-right']) || has(decls['margin']);
}

function hasPositionedDescendant(b: Box): boolean {
  return b.children.some((c) => /^(absolute|fixed)$/i.test(c.decls['position'] ?? '') || hasPositionedDescendant(c));
}

/** Lay out one box inside `content`; `pc` = containing block for absolutely-positioned descendants.
 *  `forced` pins the border-box size (used by flex, where the parent resolved the main axis). */
function layoutBox(box: Box, content: SpecRect, ctx: Ctx, pc: SpecRect = content, forced?: { w?: number | null; h?: number | null }): void {
  const decls = box.decls;
  const pos = (decls['position'] ?? 'static').toLowerCase();
  const fs = box.style?.fontSize ?? 16;
  const vp = vpOf(ctx);

  if (pos === 'absolute' || pos === 'fixed') {
    const pw = content.w, ph = content.h;
    const m = marginOf(decls, fs, ctx.rootFontSize, vp);
    const left = parseLength(decls['left'], { base: pw, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
    const top = parseLength(decls['top'], { base: ph, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
    const right = parseLength(decls['right'], { base: pw, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
    const bottom = parseLength(decls['bottom'], { base: ph, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
    let w = parseLength(decls['width'], { base: pw, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
    let h = parseLength(decls['height'], { base: ph, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
    if (w != null) w += contentBoxExtra(decls, fs, ctx).w;
    if (h != null) h += contentBoxExtra(decls, fs, ctx).h;
    if (w == null && left != null && right != null) w = pw - left - right;
    if (h == null && top != null && bottom != null) h = ph - top - bottom;
    let x = left != null ? content.x + left + m.left : content.x + m.left;
    let y = top != null ? content.y + top + m.top : content.y + m.top;
    box.rect = { x, y, w: w ?? 1, h: h ?? 1 };
    sizeFromContent(box, ctx, w == null, h == null, content);
    clampSize(box, ctx);
    if (right != null && left == null) x = content.x + pw - right - box.rect.w - m.right;
    if (bottom != null && top == null) y = content.y + ph - bottom - box.rect.h - m.bottom;
    box.rect.x = x;
    box.rect.y = y;
    layoutChildren(box, ctx, content);
    return;
  }

  const wRaw = forced && forced.w != null ? forced.w : parseLength(decls['width'], { base: content.w, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
  const hRaw = forced && forced.h != null ? forced.h : parseLength(decls['height'], { base: content.h, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vp });
  const extra = contentBoxExtra(decls, fs, ctx);
  const w = wRaw != null && !forced?.w ? wRaw + extra.w : wRaw;
  const h = hRaw != null && !forced?.h ? hRaw + extra.h : hRaw;
  box.rect = { x: content.x, y: content.y, w: w ?? 1, h: h ?? 1 };
  sizeFromContent(box, ctx, w == null, h == null, pc);
  clampSize(box, ctx);
  // position: relative — top/left/right/bottom nudge the box and everything inside it
  const rel = relativeOffset(decls, box.rect, fs, ctx);
  if (rel.dx || rel.dy) {
    box.rect.x += rel.dx;
    box.rect.y += rel.dy;
  }
  layoutChildren(box, ctx, pc);
}

/** Auto-size estimation before children are laid out. */
function estimateSize(box: Box, ctx?: Ctx): { w: number; h: number } {
  const fs = box.style?.fontSize ?? 16;
  const vp = ctx ? vpOf(ctx) : undefined;
  const pad = padOf(box.decls, fs, ctx?.rootFontSize ?? 16, vp);
  if (box.text) {
    return { w: estimateTextW(box.text, fs, box.style?.weight ?? 400) + pad.left + pad.right, h: box.text.split('\r').length * (box.style?.leading ?? fs * 1.25) + pad.top + pad.bottom };
  }
  if (box.tag === 'img' || box.image) return { w: 320, h: 240 };
  if (box.children.length === 0) return { w: pad.left + pad.right + 4, h: pad.top + pad.bottom + fs * 1.25 };
  return { w: 0, h: 0 };
}

/** After children have rects, auto width/height can be derived from content. */
function sizeFromContent(box: Box, ctx: Ctx, needW: boolean, needH: boolean, pc: SpecRect): void {
  if (!needW && !needH) {
    layoutChildrenIfPositioned(box, ctx, pc);
    return;
  }
  const decls = box.decls;
  const fs = box.style?.fontSize ?? 16;
  const pad = padOf(decls, fs, ctx.rootFontSize, vpOf(ctx));
  const flex = (decls['display'] ?? '').toLowerCase().includes('flex');
  const positionedKids = hasPositionedDescendant(box);

  if (box.text) {
    const lines = box.text.split('\r');
    if (needW) box.rect.w = estimateTextW(box.text, fs, box.style?.weight ?? 400) + pad.left + pad.right;
    if (needH) box.rect.h = lines.length * (box.style?.leading ?? fs * 1.25) + pad.top + pad.bottom;
    return;
  }
  if (box.tag === 'img' || (box.image && box.children.length === 0)) {
    if (needW) box.rect.w = 320;
    if (needH) box.rect.h = 240;
    warn(ctx, 'An image has no CSS width/height — assumed 320x240 (declare size in CSS for exact placement)');
    return;
  }
  if (!box.children.length) {
    if (needW) box.rect.w = pad.left + pad.right + 4;
    if (needH) box.rect.h = pad.top + pad.bottom + fs * 1.25;
    return;
  }
  // lay out children into a provisional content box, measure, then finalize
  const contentW = Math.max(box.rect.w - pad.left - pad.right, 1);
  const contentH = Math.max(box.rect.h - pad.top - pad.bottom, 1);
  const measureArea = {
    x: box.rect.x + pad.left,
    y: box.rect.y + pad.top,
    w: positionedKids && !flex && needW ? Math.max(contentW, 2000) : contentW,
    h: positionedKids && !flex && needH ? Math.max(contentH, 2000) : contentH,
  };
  layoutChildrenIn(box, measureArea, ctx, pc, true);
  let maxR = 0, maxB = 0;
  for (const c of box.children) {
    maxR = Math.max(maxR, c.rect.x + c.rect.w);
    maxB = Math.max(maxB, c.rect.y + c.rect.h);
  }
  if (needW) box.rect.w = Math.max((maxR - box.rect.x) + pad.right, pad.left + pad.right + 1);
  if (needH) box.rect.h = Math.max((maxB - box.rect.y) + pad.bottom, pad.top + pad.bottom + 1);
  // final pass with the true content rect (so %-based children resolve correctly)
  layoutChildrenIn(box, {
    x: box.rect.x + pad.left, y: box.rect.y + pad.top,
    w: Math.max(box.rect.w - pad.left - pad.right, 1), h: Math.max(box.rect.h - pad.top - pad.bottom, 1),
  }, ctx, pc, false);
}

function layoutChildrenIfPositioned(box: Box, ctx: Ctx, pc: SpecRect): void {
  if (!hasPositionedDescendant(box)) return;
  const fs = box.style?.fontSize ?? 16;
  const pad = padOf(box.decls, fs, ctx.rootFontSize, vpOf(ctx));
  layoutChildrenIn(box, {
    x: box.rect.x + pad.left, y: box.rect.y + pad.top,
    w: Math.max(box.rect.w - pad.left - pad.right, 1), h: Math.max(box.rect.h - pad.top - pad.bottom, 1),
  }, ctx, pc);
}

function layoutChildren(box: Box, ctx: Ctx, pc: SpecRect): void {
  const fs = box.style?.fontSize ?? 16;
  const pad = padOf(box.decls, fs, ctx.rootFontSize, vpOf(ctx));
  layoutChildrenIn(box, {
    x: box.rect.x + pad.left, y: box.rect.y + pad.top,
    w: Math.max(box.rect.w - pad.left - pad.right, 1), h: Math.max(box.rect.h - pad.top - pad.bottom, 1),
  }, ctx, pc);
}

type WithMain = Box & { __main?: number };

function layoutChildrenIn(box: Box, content: SpecRect, ctx: Ctx, pc: SpecRect = content, measuring = false): void {
  const decls = box.decls;
  const isFlex = (decls['display'] ?? '').toLowerCase().includes('flex');
  // absolutely-positioned children anchor to the nearest positioned ancestor
  const inherited: SpecRect = /^(relative|absolute|fixed|sticky)$/i.test(decls['position'] ?? '') ? content : pc;

  // paint order bottom→top for layout (stable: DOM order within same z-index)
  const order = box.children.map((c, i) => ({ c, i }));
  order.sort((a, b) => (a.c.zIndex - b.c.zIndex) || (a.i - b.i));

  // positioned children are laid out first, against the inherited containing block
  const flowKids = order.filter(({ c }) => {
    const p = (c.decls['position'] ?? 'static').toLowerCase();
    if (p === 'absolute' || p === 'fixed') {
      layoutBox(c, inherited, ctx, inherited);
      return false;
    }
    return true;
  });

  if (isFlex) {
    layoutFlex(box, flowKids.map((o) => o.c), content, ctx, measuring, inherited);
    return;
  }

  // block flow — block children fill the content width; consecutive inline-level children
  // flow horizontally on shared lines and wrap like a browser's inline formatting.
  const isInlineLevel = (c: Box): boolean => {
    const cDisp = (c.decls['display'] ?? '').toLowerCase();
    return cDisp.includes('inline') || ['button', 'img', 'input', 'select', 'textarea'].includes(c.tag);
  };
  const textAlign = (box.decls['text-align'] ?? '').toLowerCase();
  /** Lay out a run of consecutive inline-level children on shared, wrapping rows. */
  function placeInlineRun(run: Box[], startY: number): number {
    // pass 1 — measure each item (auto sizes from content)
    const items = run.map((c) => {
      const fs = c.style?.fontSize ?? 16;
      const m = marginOf(c.decls, fs, ctx.rootFontSize, vpOf(ctx));
      const explicitW = parseLength(c.decls['width'], { base: content.w, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
      const hDecl = parseLength(c.decls['height'], { base: content.h, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
      c.inlineShrink = explicitW == null;
      c.rect = { x: 0, y: 0, w: Math.max(explicitW != null ? explicitW + contentBoxExtra(c.decls, fs, ctx).w : estimateSize(c, ctx).w, 1), h: hDecl != null ? hDecl + contentBoxExtra(c.decls, fs, ctx).h : 1 };
      sizeFromContent(c, ctx, explicitW == null, hDecl == null, inherited);
      clampSize(c, ctx);
      return { c, m };
    });
    // pass 2 — wrap into rows
    const rows: { items: typeof items; w: number }[] = [];
    let x = content.x;
    let row: typeof items = [];
    for (const it of items) {
      const adv = it.m.left + it.c.rect.w + it.m.right;
      if (row.length && x - content.x + adv > content.w + 0.5) {
        rows.push({ items: row, w: x - content.x });
        row = [];
        x = content.x;
      }
      row.push(it);
      x += adv;
    }
    if (row.length) rows.push({ items: row, w: x - content.x });
    // pass 3 — position rows (bottom-aligned like inline baselines) and lay out children
    let y = startY;
    for (const r of rows) {
      let rowH = 0;
      for (const it of r.items) rowH = Math.max(rowH, it.c.rect.h + it.m.top + it.m.bottom);
      const dx = textAlign.includes('center') ? Math.max((content.w - r.w) / 2, 0) : textAlign === 'right' || textAlign.includes('end') ? Math.max(content.w - r.w, 0) : 0;
      const rowBottom = y + rowH;
      let cx = content.x + dx;
      for (const it of r.items) {
        const c = it.c;
        const fs = c.style?.fontSize ?? 16;
        c.rect.x = cx + it.m.left;
        c.rect.y = rowBottom - it.m.bottom - c.rect.h;
        const rel = relativeOffset(c.decls, c.rect, fs, ctx);
        if (rel.dx || rel.dy) {
          c.rect.x += rel.dx;
          c.rect.y += rel.dy;
        }
        layoutChildren(c, ctx, inherited);
        cx = c.rect.x + c.rect.w + it.m.right;
      }
      y = rowBottom;
    }
    return y;
  }

  const flow = flowKids.map((o) => o.c);
  let y = content.y;
  let i = 0;
  while (i < flow.length) {
    const c = flow[i];
    if (isInlineLevel(c)) {
      let j = i;
      while (j < flow.length && isInlineLevel(flow[j])) j++;
      y = placeInlineRun(flow.slice(i, j), y);
      i = j;
      continue;
    }
    const fs = c.style?.fontSize ?? 16;
    const m = marginOf(c.decls, fs, ctx.rootFontSize, vpOf(ctx));
    y += Math.max(m.top, 0);
    const explicitW = parseLength(c.decls['width'], { base: content.w, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
    const w = explicitW != null ? explicitW + contentBoxExtra(c.decls, fs, ctx).w : Math.max(content.w - m.left - m.right, 1);
    const h = parseLength(c.decls['height'], { base: content.h, fontSize: fs, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
    c.rect = { x: content.x + m.left, y, w, h: h != null ? h + contentBoxExtra(c.decls, fs, ctx).h : 1 };
    sizeFromContent(c, ctx, false, h == null, inherited);
    clampSize(c, ctx);
    // margin: auto horizontal centering (browser: auto margins absorb the free space)
    if (explicitW != null && (autoMargin(c.decls, 'left') || autoMargin(c.decls, 'right'))) {
      const free = Math.max(content.w - c.rect.w, 0);
      let dx = 0;
      if (autoMargin(c.decls, 'left') && autoMargin(c.decls, 'right')) dx = free / 2;
      else if (autoMargin(c.decls, 'left')) dx = free;
      if (dx) shiftBox(c, dx, 0);
    }
    // position: relative — nudge the box, then lay out its children inside the shifted rect
    const rel = relativeOffset(c.decls, c.rect, fs, ctx);
    if (rel.dx || rel.dy) {
      c.rect.x += rel.dx;
      c.rect.y += rel.dy;
    }
    layoutChildren(c, ctx, inherited);
    y += (h ?? c.rect.h) + Math.max(m.bottom, 0);
    i++;
  }
}

function layoutFlex(box: Box, kids: Box[], content: SpecRect, ctx: Ctx, measuring = false, pc: SpecRect = content): void {
  const decls = box.decls;
  const dir = (decls['flex-direction'] ?? 'row').toLowerCase().startsWith('column') ? 'column' : 'row';
  const lenCtx = { fontSize: box.style?.fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) };
  const gapMain = parseLength((dir === 'row' ? decls['column-gap'] : decls['row-gap']) ?? decls['gap'], lenCtx) ?? 0;
  const gapCross = parseLength((dir === 'row' ? decls['row-gap'] : decls['column-gap']) ?? decls['gap'], lenCtx) ?? 0;
  const gap = gapMain; // main-axis spacing (rows in a column flex use row-gap via gapCross)
  // While measuring an auto-sized container the provisional area is tiny; centering against it
  // shifts children to negative offsets and clips the measured extent — measure from the start edge.
  const justify = measuring ? 'flex-start' : (decls['justify-content'] ?? 'flex-start').toLowerCase();
  const align = measuring ? 'flex-start' : (decls['align-items'] ?? 'stretch').toLowerCase();
  const wrapDecl = (decls['flex-wrap'] ?? 'nowrap').toLowerCase();
  const wrap = !measuring && /wrap/i.test(wrapDecl);
  const main = dir === 'row' ? content.w : content.h;
  const cross = dir === 'row' ? content.h : content.w;

  const margins = kids.map((c) => marginOf(c.decls, c.style?.fontSize ?? 16, ctx.rootFontSize, vpOf(ctx)));
  const explicitMain = kids.map((c) => dir === 'row'
    ? parseLength(c.decls['width'], { base: content.w, fontSize: c.style?.fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) })
    : parseLength(c.decls['height'], { base: content.h, fontSize: c.style?.fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) }));
  const grow = kids.map((c, i) => {
    const f = (c.decls['flex'] ?? '').trim().split(/\s+/).filter(Boolean);
    if (f.length && isFinite(parseFloat(f[0]))) return parseFloat(f[0]);
    return parseFloat(c.decls['flex-grow'] ?? '0') || 0;
  });
  // flex-basis: explicit basis > flex shorthand (single number = 0) > explicit size > natural estimate
  const basis = kids.map((c, i) => {
    const f = (c.decls['flex'] ?? '').trim().split(/\s+/).filter(Boolean);
    const shorthand = f.length > 0 && isFinite(parseFloat(f[0]));
    const basisDecl = c.decls['flex-basis'] ?? (f.length >= 3 ? f[2] : shorthand && f.length === 1 ? '0%' : null);
    if (basisDecl != null && !/^auto$/i.test(basisDecl) && basisDecl !== 'content') {
      const v = parseLength(basisDecl, { base: dir === 'row' ? content.w : content.h, fontSize: c.style?.fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
      if (v != null) return Math.max(v, 0);
    }
    const est = estimateSize(c, ctx);
    return explicitMain[i] ?? Math.max(dir === 'row' ? est.w : est.h, 0);
  });
  const outerOf = (i: number, size: number): number =>
    size + (dir === 'row' ? margins[i].left + margins[i].right : margins[i].top + margins[i].bottom);

  // ---- wrap: partition kid indexes into lines that fit the main axis
  const lines: number[][] = [];
  if (!wrap) {
    lines.push(kids.map((_, i) => i));
  } else {
    let cur: number[] = [];
    let acc = 0;
    for (let i = 0; i < kids.length; i++) {
      const outer = outerOf(i, basis[i]);
      if (cur.length && acc + outer > main + 0.5) {
        lines.push(cur);
        cur = [];
        acc = 0;
      }
      cur.push(i);
      acc += outer + gap;
    }
    if (cur.length) lines.push(cur);
  }

  let crossCursor = 0; // offset of the current line from the content start, cross axis
  for (const line of lines) {
    const gaps = gap * Math.max(line.length - 1, 0);
    const basisTotal = line.reduce((s, i) => s + basis[i], 0);
    const free = Math.max(main - basisTotal - gaps, 0);
    const growSum = line.reduce((s, i) => s + grow[i], 0);
    const finalMain = line.map((i) => basis[i] + (growSum > 0 && grow[i] > 0 ? (grow[i] / growSum) * free : 0));
    const outerMain = finalMain.map((s, k) => outerOf(line[k], s));
    const totalMain = outerMain.reduce((s, x) => s + x, 0) + gaps;
    let cursor = 0;
    let slot = 0;
    if (justify.includes('center')) cursor = (main - totalMain) / 2;
    else if (justify.includes('flex-end') || justify === 'end') cursor = main - totalMain;
    else if (justify.includes('space-between') && line.length > 1) slot = Math.max(main - totalMain + gaps, 0) / (line.length - 1);

    // per-line cross sizes
    const natural = line.map((i) => { const e = estimateSize(kids[i], ctx); return dir === 'row' ? e.h : e.w; });
    const crossExplicit = line.map((i) => dir === 'row'
      ? parseLength(kids[i].decls['height'], { base: content.h, fontSize: kids[i].style?.fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) })
      : parseLength(kids[i].decls['width'], { base: content.w, fontSize: kids[i].style?.fontSize, rootFontSize: ctx.rootFontSize, ...vpOf(ctx) }));
    const isStretch = line.map((i, k) => align === 'stretch' && crossExplicit[k] == null);
    let lineCross: number;
    if (measuring) lineCross = Math.max(...line.map((_, k) => crossExplicit[k] ?? natural[k]), 1);
    else if (!wrap && isStretch.some(Boolean)) lineCross = cross;
    else lineCross = Math.max(...line.map((_, k) => crossExplicit[k] ?? natural[k]), 1);
    // nowrap keeps the historical container-relative alignment; wrap aligns within the line
    const alignRef = wrap ? lineCross : cross;
    const alignBase = wrap ? crossCursor : 0;

    line.forEach((gi, k) => {
      const c = kids[gi];
      const m = margins[gi];
      const mainPos = (dir === 'row' ? content.x : content.y) + cursor + (dir === 'row' ? m.left : m.top);
      // while measuring an auto-sized container, stretched items keep their natural cross size
      const crossSize = crossExplicit[k] ?? (isStretch[k] ? (measuring ? natural[k] : lineCross) : 0);
      let crossPos = (dir === 'row' ? content.y : content.x) + alignBase;
      if (!isStretch[k] || measuring) {
        if (align.includes('center')) crossPos = (dir === 'row' ? content.y : content.x) + alignBase + (alignRef - (crossSize || cross)) / 2;
        else if (align === 'flex-end' || align === 'end') crossPos = (dir === 'row' ? content.y : content.x) + alignBase + alignRef - (crossSize || cross);
      }
      const r: SpecRect = dir === 'row'
        ? { x: mainPos, y: crossPos + (isStretch[k] && !measuring ? m.top : 0), w: Math.max(finalMain[k], 1), h: Math.max(crossSize || 1, 1) }
        : { x: crossPos + (isStretch[k] && !measuring ? m.left : 0), y: mainPos, w: Math.max(crossSize || 1, 1), h: Math.max(finalMain[k], 1) };
      c.rect = { ...r };
      // pin the resolved main axis so children lay out inside the real box
      const forced = dir === 'row'
        ? { w: Math.max(finalMain[k], 1), h: crossSize > 0 ? crossSize : null }
        : { w: crossSize > 0 ? crossSize : null, h: Math.max(finalMain[k], 1) };
      layoutBox(c, r, ctx, pc, forced);
      if (!isStretch[k] && align.includes('center') && crossExplicit[k] == null) {
        // re-centre now that the auto cross size is measured
        const measured = dir === 'row' ? c.rect.h : c.rect.w;
        const off = (alignRef - measured) / 2;
        if (dir === 'row') c.rect.y = content.y + alignBase + off;
        else c.rect.x = content.x + alignBase + off;
      }
      cursor += outerMain[k] + gap + (slot > 0 && k < line.length - 1 ? slot - gap : 0);
    });
    crossCursor += lineCross + gapCross;
  }
}

// ------------------------------------------------------------------- emit

function fillOf(decls: Record<string, string>, ctx: Ctx): SpecFill | null {
  const bg = decls['background'] ?? decls['background-color'] ?? '';
  const bi = decls['background-image'] ?? '';
  const gradSrcRaw = bi && /gradient\(/i.test(bi) ? bi : bg && /gradient\(/i.test(bg) ? bg : '';
  if (gradSrcRaw) {
    // a background-image can stack several comma-separated layers; keep the first, say the rest
    const layers = splitTopLevel(gradSrcRaw, ',').filter((l) => l.trim());
    const gradSrc = layers[0] ?? '';
    if (layers.length > 1) warn(ctx, `${layers.length} stacked background layers — only the first (${gradSrc.split('(')[0]}) is converted`);
    const g = parseGradient(gradSrc);
    if (g && 'grad' in g) return { type: 'gradient', grad: g.grad };
    if (g && 'unsupported' in g) {
      warn(ctx, `${g.unsupported} gradient converted as a solid fill of its first color (Photoshop has no ${g.unsupported.replace(/-gradient/i, '')} fill) — for the real look, rasterize the area or place an image`);
      const first = (gradSrc.match(/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-fA-F]{3,8})/) ?? [])[1];
      const c = first ? parseColor(first) : null;
      return c ? { type: 'solid', color: c } : null;
    }
  }
  const colorSrc = !/gradient\(/i.test(bg) ? bg : '';
  const c = colorSrc ? parseColor(colorSrc) : null;
  if (c) return c.a === 0 ? null : { type: 'solid', color: c };
  return null;
}

export interface BorderSideSpec { width: number; color: RGBA }

/** Per-side borders: reads border, border-width/color/style (4-value shorthands),
 * border-<side> and border-<side>-width/color. A side with style none/hidden or width 0 is absent. */
function borderSides(decls: Record<string, string>, fs: number, ctx: Ctx): { top: BorderSideSpec | null; right: BorderSideSpec | null; bottom: BorderSideSpec | null; left: BorderSideSpec | null } {
  const one = (v: string | undefined): number | null => parseLength(v, { fontSize: fs, rootFontSize: ctx.rootFontSize });
  const quad = (v: string | undefined): (number | null)[] => {
    if (v == null) return [null, null, null, null];
    const xs = splitTopLevel(v, ' ').map((x) => one(x));
    return [xs[0] ?? null, xs[1] ?? xs[0] ?? null, xs[2] ?? xs[0] ?? null, xs[3] ?? xs[1] ?? xs[0] ?? null];
  };
  const colorQuad = (v: string | undefined): (RGBA | null)[] => {
    if (v == null) return [null, null, null, null];
    const xs = splitTopLevel(v, ' ').map((x) => parseColor(x));
    return [xs[0] ?? null, xs[1] ?? xs[0] ?? null, xs[2] ?? xs[0] ?? null, xs[3] ?? xs[1] ?? xs[0] ?? null];
  };
  const styleQuad = (v: string | undefined): string[] => {
    if (v == null) return ['', '', '', ''];
    const xs = splitTopLevel(v, ' ').map((x) => x.toLowerCase());
    return [xs[0] ?? '', xs[1] ?? xs[0] ?? '', xs[2] ?? xs[0] ?? '', xs[3] ?? xs[1] ?? xs[0] ?? ''];
  };
  const sh = (decls['border'] ?? '').trim();
  const shW = one(sh.split(/\s+/)[0] ?? '');
  const shC = parseColor(sh.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/)?.[0] ?? '');
  const shStyle = (sh.split(/\s+/)[1] ?? '').toLowerCase();
  const wq = quad(decls['border-width']);
  const cq = colorQuad(decls['border-color']);
  const sq = styleQuad(decls['border-style']);
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const out: Record<(typeof sides)[number], BorderSideSpec | null> = { top: null, right: null, bottom: null, left: null };
  for (const side of sides) {
    const long = decls['border-' + side] ?? '';
    const lW = one(long.split(/\s+/)[0] ?? '');
    const lC = parseColor(long.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/)?.[0] ?? '');
    const lStyle = (long.split(/\s+/)[1] ?? '').toLowerCase();
    const width = one(decls['border-' + side + '-width']) ?? lW ?? wq[sides.indexOf(side)] ?? shW;
    const style = (decls['border-' + side + '-style'] ?? (lStyle || sq[sides.indexOf(side)] || shStyle || 'solid')).toLowerCase();
    const color = parseColor(decls['border-' + side + '-color']) ?? lC ?? cq[sides.indexOf(side)] ?? shC;
    if (!width || width <= 0 || style === 'none' || style === 'hidden') continue;
    out[side] = { width, color: color ?? { r: 0, g: 0, b: 0, a: 1 } };
  }
  return out;
}

/** True when every side exists with the same width + color — one PS stroke can render it exactly. */
function uniformBorder(b: ReturnType<typeof borderSides>): boolean {
  const t = b.top, r = b.right, bo = b.bottom, l = b.left;
  if (!t || !r || !bo || !l) return false;
  const same = (a: BorderSideSpec, c: BorderSideSpec) =>
    Math.abs(a.width - c.width) < 0.01 && a.color.r === c.color.r && a.color.g === c.color.g && a.color.b === c.color.b && a.color.a === c.color.a;
  return same(t, r) && same(r, bo) && same(bo, l);
}

/** Thin bar shapes that draw non-uniform CSS borders (e.g. only a bottom accent line). */
function borderBarNodes(b: ReturnType<typeof borderSides>, rect: SpecRect): SpecNode[] {
  const bar = (name: string, x: number, y: number, w: number, h: number, color: RGBA): SpecNode => ({
    kind: 'shape', name, rect: { x, y, w: Math.max(w, 0.5), h: Math.max(h, 0.5) }, opacity: 100,
    fill: { type: 'solid', color }, stroke: null, radius: null, shadow: null, innerShadow: null, children: [],
  });
  const out: SpecNode[] = [];
  if (b.top) out.push(bar('border top', rect.x, rect.y, rect.w, b.top.width, b.top.color));
  if (b.bottom) out.push(bar('border bottom', rect.x, rect.y + rect.h - b.bottom.width, rect.w, b.bottom.width, b.bottom.color));
  if (b.left) out.push(bar('border left', rect.x, rect.y, b.left.width, rect.h, b.left.color));
  if (b.right) out.push(bar('border right', rect.x + rect.w - b.right.width, rect.y, b.right.width, rect.h, b.right.color));
  return out;
}

function nameFor(box: Box): string {
  const t = (box.text ?? '').replace(/\s+/g, ' ').trim();
  let n = box.tag + (box.classes.length ? '.' + box.classes[0] : '');
  if (t) n += ' — ' + (t.length > 32 ? t.slice(0, 32) + '…' : t);
  else if (box.tag === 'img' && box.image) n = 'img — ' + (box.image.value.split('/').pop()?.slice(0, 24) ?? 'image');
  return (n.slice(0, 64) || box.tag);
}

// ------------------------------------------------------- transform & filter

export interface TransformInfo {
  rotate: number; // degrees clockwise (around center)
  tx: number; // px
  ty: number; // px
  sx: number; // scale factor x (1 = unchanged)
  sy: number; // scale factor y
  unsupported: boolean; // skew / 3d / perspective parts present
}

const angleDeg = (tok: string): number => {
  const m = tok.trim().match(/^(-?[\d.]+)(deg|grad|rad|turn)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? 'deg').toLowerCase();
  if (unit === 'grad') return n * 0.9;
  if (unit === 'rad') return (n * 180) / Math.PI;
  if (unit === 'turn') return n * 360;
  return n;
};

/** Parse the CSS transform subset we can really reproduce: rotate + translate + scale.
 * Skew/3d/perspective are reported via `unsupported` so the UI can say exactly what to do by hand. */
export function parseTransform(v: string, boxW: number, boxH: number, fontSize: number, rootFontSize: number): TransformInfo | null {
  if (!v || /^none$/i.test(v.trim())) return null;
  const out: TransformInfo = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, unsupported: false };
  let handled = false;
  for (const fn of splitTopLevel(v.replace(/\s*,\s*/g, ','), ' ').map((x) => x.trim()).filter(Boolean)) {
    const m = fn.match(/^([a-zA-Z0-9]+)\((.*)\)$/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const args = splitTopLevel(m[2], ',').map((x) => x.trim());
    if (name === 'rotate' || name === 'rotatez') {
      out.rotate += angleDeg(args[0] ?? '0deg');
      handled = true;
    } else if (name === 'translate' || name === 'translatex' || name === 'translatey') {
      const len = (tok: string, base: number) => parseLength(tok, { base, fontSize, rootFontSize }) ?? 0;
      if (name === 'translatex') out.tx += len(args[0] ?? '0', boxW);
      else if (name === 'translatey') out.ty += len(args[0] ?? '0', boxH);
      else {
        out.tx += len(args[0] ?? '0', boxW);
        out.ty += args[1] != null ? len(args[1], boxH) : 0;
      }
      handled = true;
    } else if (name === 'scale' || name === 'scalex' || name === 'scaley' || name === 'scale3d') {
      const nums = args.map((x) => parseFloat(x));
      const n1 = isFinite(nums[0]) ? nums[0] : 1;
      const n2 = isFinite(nums[1]) ? nums[1] : n1;
      if (name === 'scalex') { out.sx *= n1; }
      else if (name === 'scaley') { out.sy *= n1; }
      else { out.sx *= n1; out.sy *= n2; } // scale(a) and scale3d(a, b, …)
      handled = true;
    } else if (name === 'matrix') {
      const n = args.map((x) => parseFloat(x));
      if (n.length >= 6 && n.every((x) => isFinite(x))) {
        out.rotate += (Math.atan2(n[1], n[0]) * 180) / Math.PI;
        out.tx += n[4];
        out.ty += n[5];
        out.sx *= Math.hypot(n[0], n[1]);
        out.sy *= Math.hypot(n[2], n[3]);
        // rows pointing in different directions means a real skew, not scale+rotate
        const rowA = Math.atan2(n[1], n[0]);
        const rowB = Math.atan2(-n[2], n[3]);
        let diff = Math.abs(rowA - rowB) * (180 / Math.PI);
        if (diff > 180) diff = 360 - diff;
        if (diff > 1.5) out.unsupported = true;
        handled = true;
      }
    } else {
      // skew/rotateX/Y/Z/3d/perspective/…
      out.unsupported = true;
    }
  }
  return handled || out.unsupported ? out : null;
}

/** Parse the CSS filter subset we can apply as real Photoshop filters.
 * Returns filters, an optional drop-shadow (feeds the layer effect), an opacity
 * multiplier (filter:opacity), and the kinds we cannot reproduce. */
export function parseFilters(v: string, fontSize: number, rootFontSize: number): {
  filters: SpecFilter[];
  dropShadow: Shadow | null;
  opacityMul: number;
  unsupportedKinds: string[];
} {
  const filters: SpecFilter[] = [];
  const unsupportedKinds: string[] = [];
  let dropShadow: Shadow | null = null;
  let opacityMul = 1;
  if (!v || /^none$/i.test(v.trim())) return { filters, dropShadow, opacityMul, unsupportedKinds };
  const pct = (tok: string | undefined, def: number): number => {
    if (tok == null) return def;
    const t = tok.trim();
    if (t.endsWith('%')) return (parseFloat(t) || 0) / 100;
    const n = parseFloat(t);
    return isFinite(n) ? n : def;
  };
  for (const fn of splitTopLevel(v, ' ').map((x) => x.trim()).filter(Boolean)) {
    const m = fn.match(/^([a-zA-Z-]+)\((.*)\)$/);
    const name = m ? m[1].toLowerCase() : fn.toLowerCase();
    const arg = m ? m[2].trim() : '';
    if (name === 'blur') {
      const px = parseLength(arg, { fontSize, rootFontSize });
      if (px != null && px > 0.05) filters.push({ kind: 'blur', value: px });
    } else if (name === 'brightness') filters.push({ kind: 'brightness', value: Math.max(0, pct(arg, 1)) });
    else if (name === 'contrast') filters.push({ kind: 'contrast', value: Math.max(0, pct(arg, 1)) });
    else if (name === 'saturate') filters.push({ kind: 'saturate', value: Math.max(0, pct(arg, 1)) });
    else if (name === 'grayscale') { if (pct(arg, 1) > 0.01) filters.push({ kind: 'grayscale', value: pct(arg, 1) }); }
    else if (name === 'invert') { if (pct(arg, 1) > 0.01) filters.push({ kind: 'invert', value: pct(arg, 1) }); }
    else if (name === 'opacity') opacityMul = Math.min(opacityMul, Math.max(0, pct(arg, 1)));
    else if (name === 'sepia') { if (pct(arg, 1) > 0.01) filters.push({ kind: 'sepia', value: Math.min(1, pct(arg, 1)) }); }
    else if (name === 'hue-rotate') {
      const deg = angleDeg(arg); // 90deg / 1.57rad / 0.25turn
      const norm = ((deg % 360) + 540) % 360 - 180; // → -180..180
      if (Math.abs(norm) > 0.5) filters.push({ kind: 'hue-rotate', value: Math.round(norm * 10) / 10 });
    }
    else if (name === 'drop-shadow') {
      const sh = parseShadows(arg);
      dropShadow = sh.find((x) => !x.inset) ?? dropShadow;
    } else if (name !== 'none') unsupportedKinds.push(name);
  }
  return { filters, dropShadow, opacityMul, unsupportedKinds };
}

function emitNode(box: Box, ctx: Ctx, scale: number, clip?: { x: number; y: number; w: number; h: number } | null): SpecNode | null {
  const decls = box.decls;
  let r = box.rect;
  if (clip) {
    const nx = Math.max(r.x, clip.x), ny = Math.max(r.y, clip.y);
    const nr = Math.min(r.x + r.w, clip.x + clip.w), nb = Math.min(r.y + r.h, clip.y + clip.h);
    if (nr - nx <= 0 || nb - ny <= 0) return null;
    if (nr - nx < r.w - 0.5 || nb - ny < r.h - 0.5) {
      if (box.text) warn(ctx, `Text "${(box.text ?? '').slice(0, 24)}…" sits in an overflow:hidden container — it may overflow the layer bounds`);
      else if (box.tag === 'img' || box.image) warn(ctx, 'Image extends past an overflow:hidden container — crop it with a layer mask in Photoshop if needed');
      else r = { x: nx, y: ny, w: nr - nx, h: nb - ny };
    }
  }
  const s = (n: number) => Math.round(n * scale * 100) / 100;
  const rect = { x: s(r.x), y: s(r.y), w: Math.max(s(r.w), 1), h: Math.max(s(r.h), 1) };
  const opacityDecl = parseFloat(decls['opacity'] ?? '1');
  let opacity = isFinite(opacityDecl) ? Math.round(Math.max(0, Math.min(1, opacityDecl)) * 100) : 100;
  const blend = BLEND[(decls['mix-blend-mode'] ?? 'normal').toLowerCase()];

  // CSS transform: rotate → real layer rotation, translate → shift, scale → layer scale;
  // skew/3d reported
  const elFs = box.style?.fontSize ?? 16;
  const tr = parseTransform(decls['transform'] ?? '', r.w || 1, r.h || 1, elFs, ctx.rootFontSize);
  if (tr && (tr.tx || tr.ty)) {
    rect.x += s(tr.tx);
    rect.y += s(tr.ty);
  }
  if (tr && tr.unsupported) {
    warn(ctx, 'CSS transform: ' + (tr.rotate || tr.sx !== 1 || tr.sy !== 1 ? 'rotation/scale IS applied — ' : '') + 'skew/3d parts are not converted (do them on the layer in Photoshop)');
  }

  // CSS filter: blur/grayscale/brightness/contrast/saturate/invert → real Photoshop filters;
  // drop-shadow → live layer effect; opacity() → layer opacity. The rest is reported.
  const flt = parseFilters(decls['filter'] ?? '', elFs, ctx.rootFontSize);
  if (flt.opacityMul < 1) opacity = Math.round(opacity * flt.opacityMul);
  if (flt.unsupportedKinds.length) {
    warn(ctx, `CSS filter ${flt.unsupportedKinds.slice(0, 3).join(', ')} not converted — apply it as a Photoshop filter`);
  }

  const shadowList = parseShadows(decls['box-shadow'] ?? decls['text-shadow'] ?? '');
  const outer = shadowList.find((sh) => !sh.inset) ?? flt.dropShadow;
  const inner = shadowList.find((sh) => sh.inset) ?? null;
  if (shadowList.length > 2) warn(ctx, 'More than 2 shadows on one element — only the first of each kind is converted');
  const rot = tr && tr.rotate ? Math.round(tr.rotate * 100) / 100 : null;
  const scl = tr && (Math.abs(tr.sx - 1) > 0.004 || Math.abs(tr.sy - 1) > 0.004)
    ? { x: Math.round(tr.sx * 1000) / 1000, y: Math.round(tr.sy * 1000) / 1000 }
    : null;
  const fxList = flt.filters.length ? flt.filters : null;
  const motion = {
    ...(rot ? { rotate: rot } : {}),
    ...(scl ? { scale: scl } : {}),
    ...(fxList ? { filters: fxList } : {}),
  };

  const sides = borderSides(decls, box.style?.fontSize ?? 16, ctx);
  const uniform = uniformBorder(sides);
  const border = uniform ? { width: sides.top!.width, color: sides.top!.color } : { width: 0, color: null as RGBA | null };
  const bars = uniform ? [] : borderBarNodes(sides, rect);
  const radius = parseRadii(decls['border-radius'] ?? '', Math.min(r.w, r.h) || 0);
  const fill = fillOf(decls, ctx);
  const radiusObj = radius ? { tl: s(radius.tl), tr: s(radius.tr), br: s(radius.br), bl: s(radius.bl) } : null;
  const scaledShadow = (sh: Shadow | null) => (sh ? { ...sh, dx: s(sh.dx), dy: s(sh.dy), blur: s(sh.blur), spread: s(sh.spread) } : null);
  const isVisual = !!fill || !!border.width || bars.length > 0 || !!outer || !!inner;

  // ---- leaf text block
  if (box.text && box.style) {
    const fsS = Math.max(s(box.style.fontSize), 1);
    const padE = padOf(decls, box.style.fontSize, ctx.rootFontSize);
    // content box for the glyphs (bg shape keeps the full border-box rect)
    const textRect = {
      x: rect.x + s(padE.left), y: rect.y + s(padE.top),
      w: Math.max(rect.w - s(padE.left) - s(padE.right), 1), h: Math.max(rect.h - s(padE.top) - s(padE.bottom), 1),
    };
    // flex centering of inline content: honour justify-content for text-only flex boxes
    let align = box.style.align;
    const jc = (decls['justify-content'] ?? '').toLowerCase();
    if (align === 'left' && jc.includes('center')) align = 'center';
    else if (align === 'left' && (jc.includes('flex-end') || jc === 'end')) align = 'right';
    // box (paragraph) text whenever the block is wider than the glyphs: reproduces wrapping
    // AND makes text-align:center/right behave exactly like the browser
    const estW = estimateTextW(box.text, box.style.fontSize, box.style.weight);
    const useBoxText = textRect.w > 4 && (estW > textRect.w * 1.04 || align !== 'left' || !box.inlineShrink);
    const textNode: SpecNode = {
      kind: 'text',
      name: nameFor(box) + (isVisual ? ' text' : ''),
      rect: textRect,
      opacity,
      ...(blend ? { blend } : {}),
      ...motion,
      text: {
        content: box.text,
        fontSize: fsS,
        weight: box.style.weight,
        italic: box.style.italic,
        family: box.style.family,
        color: box.style.color,
        tracking: box.style.tracking,
        leading: s(box.style.leading),
        align,
        ...(box.style.underline ? { underline: true } : {}),
        ...(box.style.lineThrough ? { lineThrough: true } : {}),
        // wrap case: wrap exactly at the CSS box. Auto-sized box: add ~6% slack so Photoshop
        // (whose real glyph widths differ from the estimate) does not wrap earlier than the browser
        ...(useBoxText ? { boxWidth: estW > textRect.w ? textRect.w : Math.max(textRect.w, estW * 1.06) } : {}),
        ...(box.ranges && box.ranges.length ? { ranges: box.ranges } : {}),
      },
    };
    if (!isVisual) return textNode;
    const bgShape: SpecNode = {
      kind: 'shape',
      name: nameFor(box) + ' bg',
      rect,
      opacity,
      ...(blend ? { blend } : {}),
      ...motion,
      fill,
      stroke: border.width ? { width: s(border.width), color: border.color! } : null,
      radius: radiusObj,
      shadow: scaledShadow(outer),
      innerShadow: scaledShadow(inner),
      children: [],
    };
    return { kind: 'group', name: nameFor(box), rect, opacity, ...(blend ? { blend } : {}), ...motion, children: [textNode, ...bars, bgShape] };
  }

  // ---- collect children (paint order top→bottom)
  const kids: SpecNode[] = [];
  const childClip = box.clipChildren ? { x: r.x, y: r.y, w: r.w, h: r.h } : clip;
  for (const c of [...box.children].reverse()) {
    const k = emitNode(c, ctx, scale, childClip);
    if (k) kids.push(k);
  }

  // ---- image leaf
  if (box.image && !kids.length) {
    const imgNode: SpecNode = {
      kind: 'image',
      name: nameFor(box),
      rect,
      opacity,
      ...(blend ? { blend } : {}),
      ...motion,
      image: { ...box.image },
      ...(radiusObj ? { radius: radiusObj } : {}),
    };
    if (!isVisual) return imgNode;
    // image + frame: fill/border bars under/over the pixels, grouped so they move together
    const bgShape: SpecNode = {
      kind: 'shape', name: nameFor(box) + ' bg', rect, opacity, ...(blend ? { blend } : {}), ...motion,
      fill, stroke: border.width ? { width: s(border.width), color: border.color! } : null,
      radius: radiusObj, shadow: scaledShadow(outer), innerShadow: scaledShadow(inner), children: [],
    };
    return { kind: 'group', name: nameFor(box), rect, opacity, ...(blend ? { blend } : {}), ...motion, children: [imgNode, ...bars, bgShape] };
  }
  if (box.image && kids.length) {
    kids.unshift({ kind: 'image', name: nameFor(box), rect, opacity, ...(blend ? { blend } : {}), ...motion, image: { ...box.image } });
  }

  const wrapName = nameFor(box);
  if (!kids.length) {
    if (!isVisual && !bars.length) return null;
    if (!bars.length) {
      return {
        kind: 'shape',
        name: wrapName,
        rect,
        opacity,
        ...(blend ? { blend } : {}),
        ...motion,
        fill,
        stroke: border.width ? { width: s(border.width), color: border.color! } : null,
        radius: radiusObj,
        shadow: scaledShadow(outer),
        innerShadow: scaledShadow(inner),
        children: [],
      };
    }
    // non-uniform borders: bg shape underneath, thin bars above it
    const bgShape: SpecNode = {
      kind: 'shape', name: wrapName + ' bg', rect, opacity, ...(blend ? { blend } : {}), ...motion,
      fill, stroke: null, radius: radiusObj, shadow: scaledShadow(outer), innerShadow: scaledShadow(inner), children: [],
    };
    return { kind: 'group', name: wrapName, rect, opacity, ...(blend ? { blend } : {}), ...motion, children: [...bars, bgShape] };
  }
  if (kids.length === 1 && !isVisual && kids[0].kind !== 'group') return kids[0];
  // groups keep their visuals: the plugin draws a background shape under the group's children
  return {
    kind: 'group', name: wrapName, rect, opacity, ...(blend ? { blend } : {}),
    ...motion,
    fill,
    stroke: border.width ? { width: s(border.width), color: border.color! } : null,
    radius: radiusObj,
    shadow: scaledShadow(outer),
    innerShadow: scaledShadow(inner),
    children: [...kids, ...bars],
  };
}

// ------------------------------------------------------------------- public

/** 1×1 neutral PNG used when huge embedded images must be dropped to fit the size budget. */
const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export interface SlimResult {
  html: string;
  replaced: number;
  savedChars: number;
}

/**
 * AI-generated pages often embed multi-megabyte base64 photos, which blows past the upload
 * budget. When a document is over `maxChars` this swaps the largest data URLs (bigger than
 * `keepChars`) for a tiny placeholder so the conversion can still run; the caller surfaces
 * what happened. Images below `keepChars` always survive untouched.
 */
export function slimHtmlForConvert(html: string, maxChars: number, keepChars = 1_500_000): SlimResult {
  if (html.length <= maxChars) return { html, replaced: 0, savedChars: 0 };
  let replaced = 0;
  let savedChars = 0;
  const out = html.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (m) => {
    if (m.length <= keepChars) return m;
    replaced++;
    savedChars += m.length - PLACEHOLDER_PNG.length;
    return PLACEHOLDER_PNG;
  });
  return { html: out, replaced, savedChars };
}

export interface ConvertOptions {
  sourcePath?: string;
  scale?: number;
  /** Document preset (px). The body inherits it when CSS gives no explicit size; the canvas grows if content is bigger. */
  docW?: number;
  docH?: number;
}

export function convertHtmlToSpec(html: string, opts: ConvertOptions = {}): HtmlSpec {
  const warnings: string[] = [];
  const ctx: Ctx = { rules: [], uaRules: [], rootFontSize: 16, warnings, vpW: 1440, vpH: 900 };

  const root = parse(html, { blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  ctx.rules = parseCssText(collectStyleText(root));
  ctx.uaRules = parseCssText(UA_CSS);
  ctx.rules.forEach((r) => {
    if (r.selectors.some((sel) => sel.toLowerCase() === 'html')) {
      const fs = parseLength(r.decls['font-size'], {});
      if (fs) ctx.rootFontSize = fs;
    }
  });

  const body = root.querySelector('body') ?? (root as unknown as HTMLElement);
  const bodyBox = buildTree(body, null, ctx, 0);
  if (!bodyBox) {
    return { canvas: { w: 1440, h: 900, background: null }, elements: [], stats: { nodes: 0, images: 0 }, warnings: ['No <body> content found in the HTML.'] };
  }

  const pageBg = fillOf(bodyBox.decls, ctx);

  const cssW = parseLength(bodyBox.decls['width'], { rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const cssH = parseLength(bodyBox.decls['height'], { rootFontSize: ctx.rootFontSize, ...vpOf(ctx) });
  const presetW = opts.docW && opts.docW >= 16 ? Math.round(opts.docW) : null;
  const presetH = opts.docH && opts.docH >= 16 ? Math.round(opts.docH) : null;
  const bw = cssW ?? presetW;
  const bh = cssH ?? presetH;
  const bodyMargin = marginOf(bodyBox.decls, 16, ctx.rootFontSize, vpOf(ctx));
  bodyBox.rect = { x: bodyMargin.left, y: bodyMargin.top, w: bw ?? 0, h: bh ?? 0 };
  // vw/vh/vmin/vmax resolve against the DOCUMENT PRESET (the "browser window"), falling back
  // to the 1440x900 default viewport — never against the computed canvas (that is circular).
  ctx.vpW = presetW ?? 1440;
  ctx.vpH = presetH ?? 900;
  const probe = { x: 0, y: 0, w: 1440, h: 900 };
  sizeFromContent(bodyBox, ctx, bw == null, bh == null, probe);
  const canvasW = Math.min(Math.max(Math.round(bw ?? bodyBox.rect.w), 1), 300000);
  const canvasH = Math.min(Math.max(Math.round(bh ?? bodyBox.rect.h), 1), 300000);
  const pad0 = padOf(bodyBox.decls, bodyBox.style?.fontSize ?? 16, ctx.rootFontSize, vpOf(ctx));
  layoutChildrenIn(
    bodyBox,
    {
      x: bodyBox.rect.x + pad0.left, y: bodyBox.rect.y + pad0.top,
      w: Math.max(bodyBox.rect.w - pad0.left - pad0.right, 1), h: Math.max(bodyBox.rect.h - pad0.top - pad0.bottom, 1),
    },
    ctx,
    { x: 0, y: 0, w: canvasW, h: canvasH }
  );

  const scale = opts.scale ?? 1;
  const elements: SpecNode[] = [];
  for (const c of [...bodyBox.children].reverse()) {
    const n = emitNode(c, ctx, scale);
    if (n) elements.push(n);
  }

  // A preset is a minimum canvas, not just a body size: CSS/content can make it larger, never smaller.
  // If content sticks out past that, grow further so nothing is cut.
  let finalW = Math.max(canvasW, presetW ?? 0);
  let finalH = Math.max(canvasH, presetH ?? 0);
  if (presetW || presetH) {
    let maxR = 0;
    let maxB = 0;
    const scan = (n: SpecNode) => {
      maxR = Math.max(maxR, n.rect.x + n.rect.w);
      maxB = Math.max(maxB, n.rect.y + n.rect.h);
      for (const k of n.children ?? []) scan(k);
    };
    elements.forEach(scan);
    // emitted rects are already in scaled units — bring them back to canvas units before comparing
    const grewW = Math.ceil(maxR / scale) > finalW;
    const grewH = Math.ceil(maxB / scale) > finalH;
    if (grewW || grewH) {
      finalW = Math.min(Math.max(finalW, Math.ceil(maxR / scale)), 300000);
      finalH = Math.min(Math.max(finalH, Math.ceil(maxB / scale)), 300000);
      warnings.push(
        `Content extends beyond the ${presetW ?? 'auto'}×${presetH ?? 'auto'} preset — canvas grew to ${finalW}×${finalH} so nothing is cut off.`
      );
    }
  }

  // resolve relative image paths against the source folder now
  const srcDir = opts.sourcePath ? dirname(resolve(opts.sourcePath)) : null;
  const resolveImg = (n: SpecNode) => {
    if (n.image && n.image.kind === 'path' && srcDir && !isAbsolute(n.image.value) && !/^[a-zA-Z]:[\\/]/.test(n.image.value)) {
      n.image.value = resolve(srcDir, n.image.value.replace(/^file:\/\//i, ''));
    }
    for (const k of n.children ?? []) resolveImg(k);
  };
  elements.forEach(resolveImg);

  const stats = { nodes: 0, images: 0 };
  const count = (n: SpecNode) => {
    stats.nodes++;
    if (n.kind === 'image') stats.images++;
    for (const k of n.children ?? []) count(k);
  };
  elements.forEach(count);

  return {
    canvas: { w: Math.round(finalW * scale), h: Math.round(finalH * scale), background: pageBg },
    elements,
    stats,
    warnings,
  };
}

// ------------------------------------------------------------ image fetching

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function sniffExt(b: Buffer): string {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.subarray(0, 4).toString('latin1') === '8BPS') return 'psd';
  if (b.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
  if (b.subarray(0, 4).toString('latin1') === 'II*\0' || b.subarray(0, 4).toString('latin1') === 'MM\0*') return 'tif';
  return 'bin';
}

/** Resolve every data:/http image in the spec to a local file path the plugin can place. */
export async function prepareSpecImages(spec: HtmlSpec): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = join(tmpdir(), 'photoshop-supreme', 'html-import');
  await mkdir(dir, { recursive: true });

  const walk = async (n: SpecNode): Promise<void> => {
    const img = n.image;
    if (img && img.kind !== 'path') {
      try {
        let bytes: Buffer;
        if (img.kind === 'data') {
          bytes = Buffer.from(img.value.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''), 'base64');
        } else {
          if (!/^https?:\/\//i.test(img.value)) throw new Error('Only http(s) URLs are supported');
          const res = await fetch(img.value, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const len = Number(res.headers.get('content-length') ?? 0);
          if (len > MAX_IMAGE_BYTES) throw new Error('Image larger than 50 MB');
          bytes = Buffer.from(await res.arrayBuffer());
        }
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image empty or larger than 50 MB');
        const ext = sniffExt(bytes);
        if (ext === 'bin') throw new Error('Unrecognized image data');
        const p = join(dir, `htmlimg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.${ext}`);
        await writeFile(p, bytes);
        img.kind = 'path';
        img.value = p;
      } catch (e) {
        const msg = String((e as Error).message ?? e).slice(0, 80);
        spec.warnings.push(`Image could not be loaded (${msg}): ${img.value.slice(0, 60)} — replaced with a grey placeholder`);
        n.image = undefined;
        n.kind = n.children?.length ? 'group' : 'shape';
        n.fill = n.fill ?? { type: 'solid', color: { r: 204, g: 204, b: 204, a: 1 } };
      }
    }
    for (const k of n.children ?? []) await walk(k);
  };
  for (const n of spec.elements) await walk(n);
}
