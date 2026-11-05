/**
 * Minimal CSS value parsing + selector matching for the HTML→layers converter.
 * Deliberately small: covers the "AI-page subset" (colors, lengths, gradients,
 * shadows, radii, borders, fonts). Everything it cannot understand is reported
 * so the caller can surface a warning instead of silently mis-rendering.
 */

export interface RGBA {
  r: number; // 0-255
  g: number;
  b: number;
  a: number; // 0-1
}

export interface GradientStop {
  pos: number; // 0-100
  color: RGBA;
}

export interface LinearGradient {
  angle: number; // CSS degrees (0 = to top, 90 = to right)
  stops: GradientStop[];
  /** Photoshop gradient type: linear (default) or radial */
  type?: 'linear' | 'radial';
  /** radial center in % of the shape box (default 50/50) */
  cx?: number;
  cy?: number;
}

export interface Shadow {
  dx: number;
  dy: number;
  blur: number;
  spread: number;
  inset: boolean;
  color: RGBA;
}

export interface Radii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

// --------------------------------------------------------------------- utils

/** Split on top-level separators (ignores separators inside parentheses). */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// -------------------------------------------------------------- named colors

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
  silver: '#c0c0c0', gray: '#808080', grey: '#808080', maroon: '#800000', olive: '#808000',
  green: '#008000', purple: '#800080', teal: '#008080', navy: '#000080', orange: '#ffa500',
  pink: '#ffc0cb', gold: '#ffd700', brown: '#a52a2a', beige: '#f5f5dc', ivory: '#fffff0',
  khaki: '#f0e68c', lavender: '#e6e6fa', salmon: '#fa8072', coral: '#ff7f50', tomato: '#ff6347',
  orangeRed: '#ff4500', crimson: '#dc143c', firebrick: '#b22222', indigo: '#4b0082',
  violet: '#ee82ee', plum: '#dda0dd', orchid: '#da70d6', turquoise: '#40e0d0',
  skyblue: '#87ceeb', steelblue: '#4682b4', royalblue: '#4169e1', slateblue: '#6a5acd',
  dodgerblue: '#1e90ff', deepskyblue: '#00bfff', midnightblue: '#191970', lightblue: '#add8e6',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', lightgreen: '#90ee90', lightyellow: '#ffffe0',
  lightpink: '#ffb6c1', whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', dimgray: '#696969',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', darkgreen: '#006400', darkblue: '#00008b',
  darkred: '#8b0000', darkviolet: '#9400d3', darkorange: '#ff8c00', goldenrod: '#daa520',
  seagreen: '#2e8b57', limegreen: '#32cd32', springgreen: '#00ff7f', mediumseagreen: '#3cb371',
  forestgreen: '#228b22', oliveDrab: '#6b8e23', chartreuse: '#7fff00', lawngreen: '#7cfc00',
  paleturquoise: '#afeeee', powderblue: '#b0e0e6', lightskyblue: '#87cefa', cornflowerblue: '#6495ed',
  slategray: '#708090', slategrey: '#708090', lightslategray: '#778899', aliceblue: '#f0f8ff',
  ghostwhite: '#f8f8ff', mintcream: '#f5fffa', honeydew: '#f0fff0', azure: '#f0ffff',
  snow: '#fffafa', floralwhite: '#fffaf0', oldlace: '#fdf5e6', linen: '#faf0e6',
  papayawhip: '#ffefd5', blanchedalmond: '#ffebcd', bisque: '#ffe4c4', wheat: '#f5deb3',
  moccasin: '#ffe4b5', navajowhite: '#ffdead', peachpuff: '#ffdab9', mistyrose: '#ffe4e1',
  seashell: '#fff5ee', antiquewhite: '#faebd7', burlywood: '#deb887', tan: '#d2b48c',
  rosybrown: '#bc8f8f', sandybrown: '#f4a460', peru: '#cd853f', chocolate: '#d2691e',
  saddlebrown: '#8b4513', sienna: '#a0522d', darkslategray: '#2f4f4f', mediumslateblue: '#7b68ee',
  mediumpurple: '#9370db', blueviolet: '#8a2be2', darkmagenta: '#8b008b', darkslateblue: '#483d8b',
  mediumaquamarine: '#66cdaa', aquamarine: '#7fffd4', mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc', lightseagreen: '#20b2aa', darkcyan: '#008b8b', darkturquoise: '#00ced1',
  palegreen: '#98fb98', darkseagreen: '#8fbc8f', yellowgreen: '#9acd32', darkolivegreen: '#556b2f',
  hotpink: '#ff69b4', deeppink: '#ff1493', palevioletred: '#db7093', mediumvioletred: '#c71585',
  thistle: '#d8bfd8', lightsalmon: '#ffa07a', lightslategrey: '#778899', dimgrey: '#696969',
  transparent: 'rgba(0,0,0,0)',
};

// -------------------------------------------------------------------- colors

export function parseColor(v: string): RGBA | null {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();
  if (s === 'currentcolor' || s === 'none' || s === 'inherit' || s === 'initial' || s === 'unset') return null;
  if (NAMED[s]) {
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    s = NAMED[s];
  }
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const hx = (i: number, n = 2) => parseInt(h.slice(i, i + n), 16);
    if (h.length === 3) return { r: hx(0, 1) * 17, g: hx(1, 1) * 17, b: hx(2, 1) * 17, a: 1 };
    if (h.length === 4) return { r: hx(0, 1) * 17, g: hx(1, 1) * 17, b: hx(2, 1) * 17, a: round2(hx(3, 1) * 17 / 255) };
    if (h.length === 6) return { r: hx(0), g: hx(2), b: hx(4), a: 1 };
    if (h.length === 8) return { r: hx(0), g: hx(2), b: hx(4), a: round2(hx(6) / 255) };
    return null;
  }
  const m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (!m) return null;
  const parts = splitTopLevel(m[2].replace(/\//g, ' ,'), ',');
  if (m[1].startsWith('rgb')) {
    const c = parts.slice(0, 3).map((p) => {
      p = p.trim();
      if (p.endsWith('%')) return (parseFloat(p) / 100) * 255;
      return parseFloat(p);
    });
    const a = parts[3] !== undefined ? pct(parts[3]) : 1;
    if (c.some((x) => !isFinite(x))) return null;
    return { r: clamp255(c[0]), g: clamp255(c[1]), b: clamp255(c[2]), a };
  }
  // hsl/hsla
  const h = parseFloat(parts[0]);
  const sat = pct(parts[1] ?? '0%');
  const lig = pct(parts[2] ?? '0%');
  const a = parts[3] !== undefined ? pct(parts[3]) : 1;
  if (!isFinite(h) || !isFinite(sat) || !isFinite(lig)) return null;
  return hslToRgb(((h % 360) + 360) % 360, sat, lig, a);
}

const pct = (p: string): number => {
  p = p.trim();
  if (p.endsWith('%')) return parseFloat(p) / 100;
  const n = parseFloat(p);
  return isFinite(n) && n <= 1 ? n : isFinite(n) ? n / 100 : 0; // "0.5" or "50%"
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function hslToRgb(h: number, s: number, l: number, a: number): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number] = [0, 0, 0];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: clamp255((rgb[0] + m) * 255), g: clamp255((rgb[1] + m) * 255), b: clamp255((rgb[2] + m) * 255), a: round2(a) };
}

export const cssColor = (c: RGBA) => `rgb(${c.r} ${c.g} ${c.b}${c.a < 1 ? ' / ' + c.a : ''})`;

// ------------------------------------------------------------------- lengths

export interface LenCtx {
  /** base for percentages (e.g. parent width) */
  base?: number;
  /** font-size this length is relative to (em) */
  fontSize?: number;
  /** root font-size (rem) */
  rootFontSize?: number;
  /** canvas width for vw units */
  viewportW?: number;
  /** canvas height for vh units */
  viewportH?: number;
}

/** Parse a CSS length to px. Returns null for auto/unknown. */
export function parseLength(v: string | undefined | null, ctx: LenCtx = {}): number | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'auto' || s === 'inherit' || s === 'initial' || s === 'unset') return null;
  const m = s.match(/^(-?[\d.]+)(px|pt|em|rem|%|vw|vh|vmin|vmax)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  switch (m[2] ?? 'px') {
    case 'px': return n;
    case 'pt': return (n * 96) / 72;
    case 'em': return ctx.fontSize != null ? n * ctx.fontSize : n * 16;
    case 'rem': return n * (ctx.rootFontSize ?? 16);
    case '%': return ctx.base != null ? (n / 100) * ctx.base : null;
    case 'vw': return ctx.viewportW != null ? (n / 100) * ctx.viewportW : null;
    case 'vh': return ctx.viewportH != null ? (n / 100) * ctx.viewportH : null;
    case 'vmin': {
      const v = Math.min(ctx.viewportW ?? NaN, ctx.viewportH ?? NaN);
      return isFinite(v) ? (n / 100) * v : null;
    }
    case 'vmax': {
      const v = Math.max(ctx.viewportW ?? NaN, ctx.viewportH ?? NaN);
      return isFinite(v) ? (n / 100) * v : null;
    }
    default: return n;
  }
}

// ------------------------------------------------------------------ gradients

/** Parse the color/position stop list shared by every gradient flavor. */
function parseStops(stopParts: string[]): GradientStop[] {
  const stops: GradientStop[] = [];
  stopParts.forEach((sp, i) => {
    // a stop is: color [pos]
    const segs = splitTopLevel(sp, ' ');
    const colorSeg = segs.find((x) => parseColor(x) !== null);
    if (!colorSeg) return;
    const color = parseColor(colorSeg)!;
    const posSeg = segs.filter((x) => x !== colorSeg)[0];
    let pos: number;
    if (posSeg != null && posSeg.endsWith('%') && isFinite(parseFloat(posSeg))) pos = parseFloat(posSeg);
    else if (posSeg != null && isFinite(parseFloat(posSeg))) pos = parseFloat(posSeg);
    else pos = stopParts.length > 1 ? (i / (stopParts.length - 1)) * 100 : 50;
    stops.push({ pos: Math.max(0, Math.min(100, pos)), color });
  });
  stops.sort((a, b) => a.pos - b.pos);
  return stops;
}

/** Parse linear-gradient / radial-gradient (including repeating-, which is expanded
 * into explicit stops so Photoshop renders the true pattern). Returns null for other image types. */
export function parseGradient(v: string): { grad: LinearGradient } | { unsupported: string } | null {
  if (!v || v === 'none') return null;
  const s = v.trim();
  const repeating = /^repeating-(linear|radial)-gradient\(/i.test(s);
  if (/^(conic|repeating-conic)-gradient\(/i.test(s)) return { unsupported: s.split('(')[0] };
  const inner = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
  const parts = splitTopLevel(inner, ',');
  if (!parts.length) return null;

  // ---- radial-gradient: [shape/size] [at x y]? , stops…
  if (/^radial-gradient\(/i.test(s) || /^repeating-radial-gradient\(/i.test(s)) {
    let cx = 50;
    let cy = 50;
    let stopStart = 0;
    const first = (parts[0] ?? '').trim();
    const firstIsColor = parseColor(first) !== null;
    if (!firstIsColor) {
      stopStart = 1; // the first part is the shape/size/position line
      const atM = first.match(/at\s+(.+)$/i);
      if (atM) {
        const pos = atM[1].trim().split(/\s+/);
        const px = parseLength(pos[0], { base: 100 });
        const py = pos[1] ? parseLength(pos[1], { base: 100 }) : px;
        if (px != null) cx = Math.max(0, Math.min(100, px));
        if (py != null) cy = Math.max(0, Math.min(100, py));
      }
    }
    const stops = expandRepeating(parseStops(parts.slice(stopStart)), repeating);
    if (stops.length < 2) return null;
    return { grad: { type: 'radial', angle: 0, stops, cx, cy } };
  }

  // ---- linear-gradient: [angle | to dir]? , stops…
  if (!/^(-?repeating-)?linear-gradient\(/i.test(s)) return null; // url() etc handled elsewhere
  let angle = 180; // CSS default: to bottom
  let start = 0;
  const first = parts[0].toLowerCase().trim();
  if (/^-?[\d.]+deg$/.test(first)) {
    angle = ((parseFloat(first) % 360) + 360) % 360;
    start = 1;
  } else if (first.startsWith('to ')) {
    const dir = first.slice(3).trim();
    const map: Record<string, number> = {
      'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
      'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
      'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315,
    };
    if (map[dir] !== undefined) {
      angle = map[dir];
      start = 1;
    }
  }
  const stops = expandRepeating(parseStops(parts.slice(start)), repeating);
  if (stops.length < 2) return null;
  return { grad: { angle, stops } };
}

/** A repeating gradient repeats its stop pattern forever; Photoshop has no repeating
 * mode, so bake one full period per cycle across 0–100 % (colors clamp at the edges). */
function expandRepeating(stops: GradientStop[], repeating: boolean): GradientStop[] {
  if (!repeating || stops.length < 2) return stops;
  const p0 = stops[0].pos;
  const period = stops[stops.length - 1].pos - p0;
  if (!(period > 0.5)) return stops;
  const kMin = Math.floor((0 - p0) / period);
  const kMax = Math.ceil((100 - p0) / period);
  const out: GradientStop[] = [];
  for (let k = kMin; k <= kMax; k++) {
    for (const st of stops) {
      const pos = st.pos + k * period;
      if (pos < -0.01 || pos > 100.01) continue;
      out.push({ pos: Math.max(0, Math.min(100, Math.round(pos * 100) / 100)), color: st.color });
    }
  }
  out.sort((a, b) => a.pos - b.pos);
  return out.filter((st, i) => i === 0 || st.pos > out[i - 1].pos + 0.01);
}

// -------------------------------------------------------------------- shadows

/** Parse box-shadow / text-shadow (comma list). */
export function parseShadows(v: string): Shadow[] {
  if (!v || v === 'none') return [];
  return splitTopLevel(v, ',')
    .map((one) => {
      let inset = false;
      let color: RGBA | null = null;
      const nums: number[] = [];
      for (const tok of splitTopLevel(one.replace(/(rgba?|hsla?)\([^)]*\)/gi, (m) => `\u0000${m}\u0000`), ' ').map((t) => t.replace(/\u0000/g, ''))) {
        const c = parseColor(tok);
        if (c && color == null) {
          color = c;
          continue;
        }
        const n = parseLength(tok);
        if (n != null) nums.push(n);
        else if (/^inset$/i.test(tok.trim())) inset = true;
      }
      if (nums.length < 2 || !color) return null;
      return { dx: nums[0], dy: nums[1], blur: nums[2] ?? 0, spread: nums[3] ?? 0, inset, color } as Shadow;
    })
    .filter((x): x is Shadow => x !== null);
}

// ---------------------------------------------------------------------- misc

export function parseRadii(v: string, base: number): Radii | null {
  if (!v || v === '0') return null;
  const vals = splitTopLevel(v, '/'); // elliptical → use horizontal only
  const nums = splitTopLevel(vals[0], ' ').map((x) => parseLength(x, { base }));
  if (nums.some((n) => n == null)) return null;
  const n = nums.map((x) => Math.max(0, x as number));
  const r = (i: number) => n[i] ?? n[Math.max(0, n.length - 1 - i)] ?? 0;
  const tl = n[0] ?? 0, tr = r(1), br = r(2), bl = r(3);
  const cap = base / 2;
  const cl = (x: number) => Math.min(x, cap);
  if (!tl && !tr && !br && !bl) return null;
  return { tl: cl(tl), tr: cl(tr), br: cl(br), bl: cl(bl) };
}

/** First font family of a CSS font-family list, quotes stripped. */
export function parseFontFamily(v: string | undefined): string | null {
  if (!v) return null;
  const first = splitTopLevel(v, ',')[0]?.trim().replace(/^["']|["']$/g, '');
  return first || null;
}

// ------------------------------------------------------- stylesheets + cascade

export interface CssRule {
  selectors: string[];
  decls: Record<string, string>;
  /** sum of (id*100 + class*10 + tag) of the matching selector, computed per element */
  order: number;
}

/** Parse raw CSS text into rules. @-blocks (media/font-face/keyframes) are skipped. */
export function parseCssText(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let order = 0;
  const walk = (text: string) => {
    // strip comments
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
    let i = 0;
    while (i < text.length) {
      const brace = text.indexOf('{', i);
      if (brace < 0) break;
      const prelude = text.slice(i, brace).trim();
      // find matching close brace (nested for @media)
      let depth = 1;
      let j = brace + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(brace + 1, j - 1);
      if (prelude.startsWith('@')) {
        if (/^@media|^@supports/i.test(prelude)) walk(body); // flatten media (desktop-ish)
        // @font-face, @keyframes, @import → ignored
      } else if (prelude) {
        const decls: Record<string, string> = {};
        for (const decl of body.split(';')) {
          const ci = decl.indexOf(':');
          if (ci < 0) continue;
          const name = decl.slice(0, ci).trim().toLowerCase();
          const val = decl.slice(ci + 1).trim();
          if (name && val) decls[name] = val;
        }
        const selectors = prelude.split(',').map((s) => s.trim()).filter(Boolean);
        rules.push({ selectors, decls, order: order++ });
      }
      i = j;
    }
  };
  walk(css);
  return rules;
}

/** Specificity of one selector against an element (id/class/tag counts). Returns -1 if no match. */
export function selectorMatches(sel: string, tag: string, classes: string[], id: string | null): number {
  // supports compound selectors "tag.class#id" chained with combinators (descendant only, last part decides)
  const parts = sel.split(/\s+>|>\s*|\s+/).filter(Boolean); // descendant/child — last part must match
  const last = parts[parts.length - 1];
  if (!last) return -1;
  const m = last.match(/^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/);
  if (!m) return -1;
  const tagSel = (m[1] ?? '*').toLowerCase();
  const rest = m[2] ?? '';
  const idSel: string[] = [];
  const classSel: string[] = [];
  const re = /[.#][\w-]+/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(rest))) {
    if (mm[0][0] === '#') idSel.push(mm[0].slice(1));
    else classSel.push(mm[0].slice(1));
  }
  if (tagSel !== '*' && tagSel !== tag.toLowerCase()) return -1;
  if (idSel.length && (!id || !idSel.every((x) => x === id))) return -1;
  if (classSel.length && !classSel.every((c) => classes.includes(c))) return -1;
  // Specificity counts ALL compounds of the selector (`.hero h1` = class + tag),
  // but only the last compound is required to match — verifying ancestor chains
  // needs a DOM walk, and AI pages rarely depend on it.
  let spec = idSel.length * 100 + classSel.length * 10 + (tagSel !== '*' ? 1 : 0);
  for (const anc of parts.slice(0, -1)) {
    const ids = (anc.match(/#[\w-]+/g) ?? []).length;
    const cls = (anc.match(/[.][\w-]+/g) ?? []).length;
    const tgs = /^([a-zA-Z][\w-]*|\*)/.test(anc.trim()) && !/^[.#]/.test(anc.trim()) ? 1 : 0;
    spec += ids * 100 + cls * 10 + tgs;
  }
  return spec;
}

export interface MatchInput {
  tag: string;
  classes: string[];
  id: string | null;
  styleAttr: string | null;
}

/** Cascade rules + inline style → one flat declaration map. */
export function computeDecls(rules: CssRule[], el: MatchInput): Record<string, string> {
  const scored: { spec: number; order: number; decls: Record<string, string> }[] = [];
  for (const r of rules) {
    let best = -1;
    for (const s of r.selectors) best = Math.max(best, selectorMatches(s, el.tag, el.classes, el.id));
    if (best >= 0) scored.push({ spec: best, order: r.order, decls: r.decls });
  }
  scored.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const out: Record<string, string> = {};
  for (const s of scored) Object.assign(out, s.decls);
  if (el.styleAttr) {
    for (const decl of el.styleAttr.split(';')) {
      const ci = decl.indexOf(':');
      if (ci < 0) continue;
      const name = decl.slice(0, ci).trim().toLowerCase();
      const val = decl.slice(ci + 1).trim();
      if (name && val) out[name] = val;
    }
  }
  return out;
}
