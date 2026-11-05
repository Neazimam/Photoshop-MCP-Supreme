'use strict';
/**
 * Photoshop Supreme MCP — UXP plugin.
 * Connects OUT to the MCP server over WebSocket (push, no polling) and exposes
 * full Photoshop control: raw batchPlay, arbitrary UXP JS, state, preview,
 * event subscriptions and an action recorder.
 */
const { app, core, action, constants } = require('photoshop');
const uxp = require('uxp');
const fs = uxp.storage.localFileSystem;
const formats = uxp.storage.formats;

const PORT = 38460;
const URL = 'ws://127.0.0.1:' + PORT;
const VERSION = '0.9.0';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ---------------------------------------------------------------- UI helpers
// The plugin loads at Photoshop startup (manifest loadEvent=startup), possibly before any panel/DOM exists,
// so every DOM touch is guarded and state is kept in variables.
let statusText = 'Starting…';
let logText = '';
let uiBound = false;
function applyUI() {
  try {
    if (typeof document === 'undefined') return;
    const st = document.getElementById('status');
    if (st) st.textContent = statusText;
    const lg = document.getElementById('log');
    if (lg) lg.textContent = logText;
    const btn = document.getElementById('reconnect');
    if (btn && !uiBound) {
      uiBound = true;
      btn.addEventListener('click', () => {
        try {
          ws && ws.close();
        } catch (e) {
          /* ignore */
        }
        connect();
      });
    }
  } catch (e) {
    /* UI is optional */
  }
}
function setStatus(text) {
  statusText = text;
  applyUI();
}
function uiLog(text) {
  logText = text;
  applyUI();
}

// ------------------------------------------------------------------- helpers
function safe(value) {
  const seen = new WeakSet();
  const json = JSON.stringify(value === undefined ? null : value, (k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[shared-or-circular]';
      seen.add(v);
    }
    return v;
  });
  return json === undefined ? null : JSON.parse(json);
}

function resolveDoc(id, required) {
  let doc = null;
  if (id == null) {
    doc = app.documents.length ? app.activeDocument : null;
  } else {
    doc = Array.from(app.documents).find((d) => d.id === id) || null;
    if (!doc) throw new Error('No open document with id ' + id);
  }
  if (!doc && required) throw new Error('No active document. Open or create one first.');
  return doc;
}

function findLayer(layers, id) {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.layers && l.layers.length) {
      const f = findLayer(l.layers, id);
      if (f) return f;
    }
  }
  return null;
}

function boundsOf(l) {
  try {
    const b = l.bounds;
    return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null;
  } catch (e) {
    return null;
  }
}

function layerToJSON(l, depth) {
  const out = {
    id: l.id,
    name: l.name,
    kind: l.kind,
    visible: l.visible,
    opacity: l.opacity,
    blendMode: l.blendMode,
    locked: l.allLocked,
    bounds: boundsOf(l),
  };
  if (l.layers && l.layers.length) {
    out.childCount = l.layers.length;
    if (depth > 0) out.layers = l.layers.map((c) => layerToJSON(c, depth - 1));
  }
  return out;
}

function docToJSON(d) {
  return {
    id: d.id,
    title: d.title,
    path: d.path || null,
    width: d.width,
    height: d.height,
    resolution: d.resolution,
    mode: d.mode,
    bitsPerChannel: d.bitsPerChannel,
  };
}


/** Make batchPlay (which always targets the ACTIVE document) honour document_id pinning. */
function ensureActive(doc) {
  try {
    if (doc && app.documents.length && app.activeDocument.id !== doc.id) app.activeDocument = doc;
  } catch (e) {
    /* best effort */
  }
}

/** Reflect an object: type, properties (with values) and methods, walking the prototype chain. */
function describe(v, max) {
  const t = v === null ? 'null' : typeof v;
  const out = { type: t };
  if (t !== 'object' && t !== 'function') {
    out.value = v === undefined ? 'undefined' : v;
    return out;
  }
  out.constructor = (v.constructor && v.constructor.name) || null;
  try {
    if (typeof v.length === 'number' && t === 'object') out.length = v.length;
  } catch (e) {
    /* ignore */
  }
  const props = {};
  const methods = [];
  const seen = new Set();
  let n = 0;
  for (let o = v; o && o !== Object.prototype && n < max; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || seen.has(k)) continue;
      seen.add(k);
      if (++n > max) break;
      let val;
      try {
        val = v[k];
      } catch (e) {
        props[k] = { error: String((e && e.message) || e) };
        continue;
      }
      if (typeof val === 'function') methods.push(k + '(' + val.length + ')');
      else if (val === null || ['string', 'number', 'boolean'].includes(typeof val)) props[k] = val;
      else if (val === undefined) props[k] = 'undefined';
      else props[k] = '[' + ((val.constructor && val.constructor.name) || typeof val) + ']';
    }
  }
  out.properties = props;
  out.methods = methods;
  return out;
}

/** Run fn inside executeAsModal, optionally collapsing everything into ONE history state. */
function modal(name, fn, historyDocId) {
  return core.executeAsModal(
    async (ec) => {
      let hid = null;
      if (historyDocId != null) {
        try {
          hid = await ec.hostControl.suspendHistory({ documentID: historyDocId, name });
        } catch (e) {
          hid = null;
        }
      }
      try {
        return await fn(ec);
      } finally {
        if (hid != null) {
          try {
            await ec.hostControl.resumeHistory(hid, true);
          } catch (e) {
            /* ignore */
          }
        }
      }
    },
    { commandName: name }
  );
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? chars[n & 63] : '=';
  }
  return out;
}

// ----------------------------------------------------- HTML → layers helpers
// The server (src/htmlconvert.ts) parses HTML/CSS and sends a layer spec:
// groups/shapes/text/images with rects, fills, gradients, radii, shadows.
// This side builds REAL editable layers from it, bottom-up, in one modal state.

const pu = (v) => ({ _unit: 'pixelsUnit', _value: v });
const rgbDesc = (c) => ({ _obj: 'RGBColor', red: Math.round(c.r), grain: Math.round(c.g), blue: Math.round(c.b) });

/** CSS gradient angle (0 = to top, clockwise) → Photoshop gradient angle. */
function psGradientAngle(cssDeg) {
  return ((90 - cssDeg) % 360 + 360) % 360;
}

function gradientFillDesc(grad) {
  const radial = grad.type === 'radial';
  const d = {
    _obj: 'gradientLayer',
    type: { _enum: 'gradientType', _value: radial ? 'radial' : 'linear' },
    angle: { _unit: 'angleUnit', _value: radial ? 0 : psGradientAngle(grad.angle) },
    gradient: {
      _obj: 'gradientClassEvent',
      name: 'Supreme HTML',
      gradientForm: { _enum: 'gradientForm', _value: 'customEnum' },
      interfaceIconFrameDimmed: 4096,
      colors: grad.stops.map((st) => ({
        _obj: 'colorStop',
        color: rgbDesc(st.color),
        type: { _enum: 'colorStopType', _value: 'userStop' },
        location: Math.round((st.pos / 100) * 4096),
        midpoint: 50,
      })),
      transparent: grad.stops.map((st) => ({
        _obj: 'transferSpec',
        opacity: { _unit: 'percentUnit', _value: Math.round((st.color.a == null ? 1 : st.color.a) * 100) },
        location: Math.round((st.pos / 100) * 4096),
        midpoint: 50,
      })),
    },
  };
  if (radial) {
    d.scale = { _unit: 'percentUnit', _value: 100 };
    const cx = grad.cx == null ? 50 : grad.cx;
    const cy = grad.cy == null ? 50 : grad.cy;
    if (Math.abs(cx - 50) > 0.5 || Math.abs(cy - 50) > 0.5) {
      d.aligned = false;
      d.offset = {
        _obj: 'paint',
        horizontal: { _unit: 'percentUnit', _value: cx },
        vertical: { _unit: 'percentUnit', _value: cy },
      };
    }
  }
  return d;
}

function shapeDesc(node) {
  const r = node.rect;
  const using = {
    _obj: 'contentLayer',
    type: node.fill && node.fill.type === 'gradient' ? gradientFillDesc(node.fill.grad)
      : { _obj: 'solidColorLayer', color: rgbDesc((node.fill && node.fill.color) || { r: 204, g: 204, b: 204, a: 1 }) },
    shape: {
      _obj: 'rectangle',
      top: pu(r.y),
      left: pu(r.x),
      bottom: pu(r.y + r.h),
      right: pu(r.x + r.w),
      unitValueQuadVersion: 1,
    },
    _options: { dialogOptions: 'dontDisplay' },
  };
  if (node.radius && (node.radius.tl || node.radius.tr || node.radius.br || node.radius.bl)) {
    using.shape.topLeft = pu(node.radius.tl);
    using.shape.topRight = pu(node.radius.tr);
    using.shape.bottomRight = pu(node.radius.br);
    using.shape.bottomLeft = pu(node.radius.bl);
  }
  if (node.stroke && node.stroke.width > 0) {
    using.strokeStyle = {
      _obj: 'strokeStyle',
      strokeStyleVersion: 2,
      strokeEnabled: true,
      fillEnabled: true,
      strokeStyleLineWidth: pu(node.stroke.width),
      strokeStyleContent: { _obj: 'solidColorLayer', color: rgbDesc(node.stroke.color) },
      strokeStyleBlendMode: { _enum: 'blendMode', _value: 'normal' },
      strokeStyleOpacity: { _unit: 'percentUnit', _value: 100 },
    };
  }
  return { _obj: 'make', _target: [{ _ref: 'contentLayer' }], using };
}

function textDesc(node, resScale, font, contents, pickFont) {
  const t = node.text;
  const sizePt = Math.max(t.fontSize / resScale, 0.5);
  const shape = {
    _obj: 'textShape',
    textType: { _enum: 'textType', _value: t.boxWidth ? 'boxType' : 'pointType' },
    orientation: { _enum: 'orientation', _value: 'horizontal' },
    transform: { _obj: 'transform', xx: 1, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0 },
    fontSize: { _unit: 'pointsUnit', _value: sizePt },
  };
  if (t.boxWidth) {
    shape.bounds = {
      _obj: 'classFloatRect',
      Top: node.rect.y, Left: node.rect.x,
      Bottom: node.rect.y + node.rect.h, Right: node.rect.x + t.boxWidth,
    };
  }
  const baseStyle = {
    _obj: 'textStyle',
    fontPostScriptName: font.psName,
    fontName: font.familyName,
    fontStyleName: font.styleName,
    syntheticBold: !!font.syntheticBold,
    syntheticItalic: !!font.syntheticItalic,
    fontSize: { _unit: 'pointsUnit', _value: sizePt },
    color: rgbDesc(t.color),
    tracking: t.tracking || 0,
    autoLeading: false,
    useAutoLeading: false,
    leading: { _unit: 'pointsUnit', _value: Math.max(t.leading / resScale, sizePt) },
    ...(t.underline ? { underline: true } : {}),
    ...(t.lineThrough ? { strikethrough: true } : {}),
  };
  // mixed inline styles (<b>, <span style>, <a>) → per-range textStyle entries on top of the base
  const trs = [{ from: 0, to: contents.length, textStyle: baseStyle }];
  for (const r of Array.isArray(t.ranges) ? t.ranges : []) {
    const from = Math.max(0, Math.min(contents.length, Math.round(r.from || 0)));
    const to = Math.max(from, Math.min(contents.length, Math.round(r.to || 0)));
    if (to <= from) continue;
    const rf = r.weight != null || r.italic != null || r.family ? pickFont(r.family || t.family, r.weight || 400, !!r.italic) : font;
    const st = { ...baseStyle };
    if (rf !== font) {
      st.fontPostScriptName = rf.psName;
      st.fontName = rf.familyName;
      st.fontStyleName = rf.styleName;
      st.syntheticBold = !!rf.syntheticBold;
      st.syntheticItalic = !!rf.syntheticItalic;
    }
    if (r.fontSize) st.fontSize = { _unit: 'pointsUnit', _value: Math.max(r.fontSize / resScale, 0.5) };
    if (r.color) st.color = rgbDesc(r.color);
    if (r.underline != null) st.underline = !!r.underline;
    if (r.lineThrough != null) st.strikethrough = !!r.lineThrough;
    trs.push({ from, to, textStyle: st });
  }
  return {
    _obj: 'make',
    _target: [{ _ref: 'textLayer' }],
    using: {
      _obj: 'textLayer',
      textKey: contents,
      textShape: [shape],
      textStyleRange: trs,
      paragraphStyleRange: [{
        from: 0, to: contents.length,
        paragraphStyle: { _obj: 'paragraphStyle', alignment: { _enum: 'alignment', _value: t.align || 'left' } },
      }],
      antiAlias: { _enum: 'antiAliasType', _value: 'antiAliasSmooth' },
      _options: { dialogOptions: 'dontDisplay' },
    },
  };
}

function shadowEffectDesc(node) {
  const fx = { _obj: 'layerEffects' };
  const scaleFix = { _obj: 'scale', fxStyle: { _unit: 'percentUnit', _value: 100 }, useAccurateStyling: true };
  if (node.shadow) {
    const sh = node.shadow;
    fx.dropShadow = {
      _obj: 'dropShadow', enabled: true, present: true, shown: true,
      mode: { _enum: 'blendMode', _value: 'multiply' },
      color: rgbDesc(sh.color),
      opacity: { _unit: 'percentUnit', _value: Math.round((sh.color.a == null ? 0.5 : sh.color.a) * 100) },
      useGlobalAngle: false,
      angle: { _unit: 'angleUnit', _value: Math.round((Math.atan2(sh.dy, sh.dx) * 180) / Math.PI) },
      distance: pu(Math.hypot(sh.dx, sh.dy)),
      choke: pu(Math.max(sh.spread, 0)),
      size: pu(Math.max(sh.blur, 1)),
      noise: 0, layerConceals: true,
    };
  }
  if (node.innerShadow) {
    const sh = node.innerShadow;
    fx.innerShadow = {
      _obj: 'innerShadow', enabled: true, present: true, shown: true,
      mode: { _enum: 'blendMode', _value: 'normal' },
      color: rgbDesc(sh.color),
      opacity: { _unit: 'percentUnit', _value: Math.round((sh.color.a == null ? 0.5 : sh.color.a) * 100) },
      useGlobalAngle: false,
      angle: { _unit: 'angleUnit', _value: Math.round((Math.atan2(sh.dy, sh.dx) * 180) / Math.PI) },
      distance: pu(Math.hypot(sh.dx, sh.dy)),
      choke: pu(Math.max(sh.spread, 0)),
      size: pu(Math.max(sh.blur, 1)),
      noise: 0,
    };
  }
  if (!node.shadow && !node.innerShadow) return null;
  return { _obj: 'set', _target: [{ _property: 'layerEffects' }, { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], to: fx, ...scaleFix, _options: { dialogOptions: 'dontDisplay' } };
}

/** Weight+italic → best matching installed font (exact PS name → family style → regular → fallback). */
function makeFontPicker(report) {
  let list = [];
  try { list = Array.from(app.fontsList || []); } catch (e) { /* keep empty */ }
  const byPS = new Map();
  const byFamily = new Map();
  for (const f of list) {
    const ps = String(f.postScriptName || f.name || '').toLowerCase();
    if (ps) byPS.set(ps, f);
    const fam = String(f.family || '').toLowerCase().trim();
    if (fam) {
      if (!byFamily.has(fam)) byFamily.set(fam, []);
      byFamily.get(fam).push(f);
    }
  }
  const genericMap = {
    'sans-serif': ['Arial', 'Helvetica Neue', 'Segoe UI', 'Helvetica', 'Roboto'],
    'serif': ['Times New Roman', 'Times', 'Georgia'],
    'monospace': ['Courier New', 'Courier', 'Consolas'],
    'system-ui': ['Segoe UI', 'Arial', 'Helvetica Neue'],
  };
  // popular web fonts → their closest metric cousins that actually ship with Windows/macOS.
  // Makes pages built for Inter/Roboto/Playfair keep their look instead of falling to a random font.
  const FAMILY_ALIAS = {
    'inter': 'Segoe UI', 'roboto': 'Arial', 'opensans': 'Segoe UI', 'open-sans': 'Segoe UI',
    'lato': 'Segoe UI', 'montserrat': 'Arial', 'poppins': 'Segoe UI', 'nunito': 'Segoe UI',
    'nunitosans': 'Segoe UI', 'ptsans': 'Segoe UI', 'sourcesanspro': 'Segoe UI', 'sourcesans3': 'Segoe UI',
    'notosans': 'Segoe UI', 'ubuntu': 'Segoe UI', 'raleway': 'Segoe UI', 'worksans': 'Segoe UI',
    'figtree': 'Segoe UI', 'dmsans': 'Segoe UI', 'dm-sans': 'Segoe UI', 'manrope': 'Segoe UI',
    'outfit': 'Segoe UI', 'plusjakartasans': 'Segoe UI', 'rubik': 'Segoe UI', 'karla': 'Segoe UI',
    'mulish': 'Segoe UI', 'jost': 'Segoe UI', 'urbanist': 'Segoe UI', 'quicksand': 'Segoe UI',
    'helvetica': 'Arial', 'helveticaneue': 'Arial', 'arial': 'Arial', 'sfprodisplay': 'Segoe UI',
    'sfprotext': 'Segoe UI', 'neuehaasgroteskdisplaypro': 'Arial', 'univers': 'Arial',
    'playfairdisplay': 'Georgia', 'merriweather': 'Georgia', 'lora': 'Georgia', 'ptserif': 'Georgia',
    'librebaskerville': 'Georgia', 'crimsontext': 'Georgia', 'cormorantgaramond': 'Georgia',
    'ebgaramond': 'Georgia', 'spectral': 'Georgia', 'sourcecodepro': 'Consolas', 'jetbrainsmono': 'Consolas',
    'robotomono': 'Consolas', 'ibmplexmono': 'Consolas', 'spacemono': 'Consolas', 'menlo': 'Consolas',
  };
  const weightNames = (w) => (w >= 900 ? ['Black', 'Heavy'] : w >= 800 ? ['ExtraBold', 'Bold'] : w >= 700 ? ['Bold'] : w >= 600 ? ['SemiBold', 'DemiBold'] : w >= 500 ? ['Medium'] : ['Regular', 'Normal', 'Book']);
  const styleHasItalic = (f) => /italic|oblique/i.test(String(f.style || f.name || ''));
  const clean = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '');

  function pick(family, weight, italic) {
    let fam = String(family || 'Arial').replace(/["']/g, '').trim() || 'Arial';
    let famL = clean(fam);
    if (genericMap[famL]) {
      for (const cand of genericMap[famL]) {
        const hit = byFamily.get(cand.toLowerCase());
        if (hit) { fam = cand; famL = clean(cand); break; }
      }
    }
    // missing family but a known metric cousin is installed → use it (keeps the design's look)
    if (!byFamily.has(famL) && !byFamily.has(famL.replace(/-/g, '')) && FAMILY_ALIAS[famL]) {
      const alias = FAMILY_ALIAS[famL];
      if (byFamily.get(alias.toLowerCase())) {
        report(`Font "${fam}" is not installed — using ${alias} (closest installed match)`);
        fam = alias;
        famL = clean(alias);
      }
    }
    const wn = weightNames(weight);
    // 1. guessed PostScript names: Family-Style, FamilyStyle, Family Style
    for (const st of wn) {
      for (const italicSt of italic ? [st + 'Italic', st + 'Oblique'] : [st]) {
        for (const cand of [fam + '-' + italicSt, fam + italicSt, fam + ' ' + italicSt]) {
          const f = byPS.get(clean(cand));
          if (f) return { psName: f.postScriptName, familyName: f.family || fam, styleName: f.style || italicSt, syntheticBold: false, syntheticItalic: false };
        }
      }
    }
    // 2. any font of the family: score style by weight distance + italic match
    const famFonts = byFamily.get(famL) || byFamily.get(famL.replace(/-/g, ''));
    if (famFonts && famFonts.length) {
      const weightOf = (f) => {
        const s = String(f.style || f.name || '').toLowerCase();
        if (/thin|extralight/.test(s)) return 200;
        if (/light/.test(s)) return 300;
        if (/semibold|demibold/.test(s)) return 600;
        if (/extrabold|heavy|black/.test(s)) return 900;
        if (/bold/.test(s)) return 700;
        if (/medium/.test(s)) return 500;
        return 400;
      };
      let best = null, bestScore = 1e9;
      for (const f of famFonts) {
        if (italic !== styleHasItalic(f)) continue;
        const d = Math.abs(weightOf(f) - weight);
        if (d < bestScore) { bestScore = d; best = f; }
      }
      if (!best) best = famFonts[0];
      const syntheticBold = weight >= 600 && weightOf(best) < 600;
      const syntheticItalic = italic && !styleHasItalic(best);
      if (syntheticBold || syntheticItalic) {
        report(`Font "${fam}" ${weight >= 600 ? 'bold' : ''}${italic ? ' italic' : ''} not installed — using ${best.postScriptName || best.name} with ${[syntheticBold && 'faux bold', syntheticItalic && 'faux italic'].filter(Boolean).join(' + ')}`);
      }
      return { psName: best.postScriptName || best.name || fam, familyName: best.family || fam, styleName: best.style || 'Regular', syntheticBold, syntheticItalic };
    }
    // 3. regular of family by PS name
    for (const cand of [fam + '-Regular', fam + 'Regular', fam]) {
      const f = byPS.get(clean(cand));
      if (f) return { psName: f.postScriptName, familyName: f.family || fam, styleName: 'Regular', syntheticBold: weight >= 600, syntheticItalic: italic };
    }
    // 4. family missing entirely — fall back through popular system fonts before giving up
    const POPULAR = ['Segoe UI', 'Arial', 'Helvetica Neue', 'Helvetica', 'Roboto', 'Calibri', 'Verdana', 'Tahoma', 'Times New Roman', 'Georgia', 'Courier New'];
    for (const cand of POPULAR) {
      const fonts = byFamily.get(cand.toLowerCase());
      if (!fonts || !fonts.length) continue;
      const plain = fonts.find((f) => !styleHasItalic(f) && /regular|normal|book/i.test(String(f.style || f.name || '')))
        || fonts.find((f) => !styleHasItalic(f)) || fonts[0];
      report(`Font "${fam}" is not installed — using ${plain.family || cand} (closest available)`);
      return {
        psName: plain.postScriptName || plain.name || cand,
        familyName: plain.family || cand,
        styleName: plain.style || 'Regular',
        syntheticBold: weight >= 600 && !/bold|black|heavy|semibold|demibold/i.test(String(plain.style || '')),
        syntheticItalic: italic,
      };
    }
    // 5. give up: first installed font
    report(`Font "${fam}" is not installed — substituted with ${list.length ? (list[0].postScriptName || list[0].name) : 'Photoshop default'}`);
    const f0 = list[0];
    return { psName: f0 ? (f0.postScriptName || f0.name) : 'MyriadPro-Regular', familyName: f0 ? (f0.family || fam) : fam, styleName: f0 ? (f0.style || 'Regular') : 'Regular', syntheticBold: weight >= 600, syntheticItalic: italic };
  }
  return pick;
}


// ------------------------------------------------------------ events/recorder
let ws = null;
function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

let subHandler = null;
let subEvents = [];

let recHandler = null;
let recEvents = [{ event: 'all' }];
let recLog = [];
let recIgnore = [];
let recStartedAt = 0;

/** Create a document on ANY Photoshop version.
 * Newer builds accept documents.add({ fill }) with constants.NewDocumentFill; older builds
 * don't ship that enum (crashing with "Cannot read properties of undefined (reading 'TRANSPARENT')")
 * — for those we fall back to the classic batchPlay "make document" descriptor. */
async function createDocCompat(opts) {
  const ndf = constants.NewDocumentFill || null;
  const ndm = constants.NewDocumentMode || null;
  if (ndf && ndf.TRANSPARENT != null && ndf.WHITE != null && ndm && ndm.RGB != null) {
    return await app.documents.add({
      title: opts.title,
      width: opts.width,
      height: opts.height,
      resolution: 72,
      mode: ndm.RGB,
      fill: opts.transparent ? ndf.TRANSPARENT : ndf.WHITE,
    });
  }
  await action.batchPlay(
    [
      {
        _obj: 'make',
        _target: [{ _ref: 'document' }],
        using: {
          _obj: 'document',
          name: opts.title,
          mode: { _enum: 'colorSpace', _value: 'RGBColor' },
          resolution: { _unit: 'resolutionUnit', _value: 72 },
          width: { _unit: 'pixelsUnit', _value: opts.width },
          height: { _unit: 'pixelsUnit', _value: opts.height },
          fill: { _enum: 'fill', _value: opts.transparent ? 'transparent' : 'white' },
        },
        _options: { dialogOptions: 'dontDisplay' },
      },
    ],
    { synchronousExecution: true }
  );
  try {
    if (app.activeDocument) return app.activeDocument;
  } catch (e) {
    /* fall through */
  }
  return app.documents[app.documents.length - 1];
}

// ------------------------------------------------------------------ handlers
const handlers = {
  async ping() {
    return { pong: true, t: Date.now() };
  },

  async capabilities() {
    return {
      plugin: VERSION,
      photoshop: app.version,
      uxp: uxp.versions && uxp.versions.uxp,
      platform: uxp.host && uxp.host.name,
      documents: app.documents.length,
    };
  },

  async get_state({ document_id, depth }) {
    const docs = Array.from(app.documents);
    const doc = resolveDoc(document_id, false);
    const state = {
      photoshop: app.version,
      documents: docs.map(docToJSON),
      activeDocumentId: app.documents.length ? app.activeDocument.id : null,
    };
    if (doc) {
      state.document = docToJSON(doc);
      state.layers = doc.layers.map((l) => layerToJSON(l, depth == null ? 2 : depth));
      state.activeLayerIds = doc.activeLayers.map((l) => l.id);
      try {
        const b = doc.selection.bounds;
        state.selection = b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null;
      } catch (e) {
        state.selection = null;
      }
      try {
        state.historyStates = doc.historyStates.length;
        state.activeHistoryState = doc.activeHistoryState && doc.activeHistoryState.name;
      } catch (e) {
        /* optional */
      }
    }
    return safe(state);
  },

  async batch_play({ descriptors, options, document_id, single_history, name, read_only }) {
    const doc = resolveDoc(document_id, false);
    const run = () => {
      ensureActive(doc);
      return action.batchPlay(
        descriptors,
        Object.assign({ synchronousExecution: false }, options || {})
      );
    };
    const res = read_only
      ? await run()
      : await modal(name || 'Supreme: batchPlay', run, single_history !== false && doc ? doc.id : null);
    return safe(res);
  },

  async run_js({ code, args, document_id, read_only, name, single_history }) {
    const doc = resolveDoc(document_id, false);
    const exec = async (ec) => {
      ensureActive(doc);
      const ctx = {
        app,
        core,
        action,
        constants,
        fs,
        formats,
        storage: uxp.storage,
        doc,
        args: args || {},
        executionContext: ec,
        layer: (id) => {
          if (!doc) throw new Error('No active document');
          const l = findLayer(doc.layers, id);
          if (!l) throw new Error('Layer ' + id + ' not found');
          return l;
        },
        batchPlay: (d, o) =>
          action.batchPlay(d, Object.assign({ synchronousExecution: false }, o || {})),
      };
      return new AsyncFunction('ctx', code)(ctx);
    };
    const res = read_only
      ? await exec(null)
      : await modal(name || 'Supreme: script', exec, single_history !== false && doc ? doc.id : null);
    return safe(res);
  },

  async inspect({ expr, max_props, document_id }) {
    const doc = resolveDoc(document_id, false);
    const ctx = { app, core, action, constants, doc, uxp, fs, storage: uxp.storage };
    const val = await new AsyncFunction(
      'ctx',
      'const { app, core, action, constants, doc, uxp, fs, storage } = ctx; return (' + expr + ');'
    )(ctx);
    return safe(describe(val, max_props || 200));
  },

  async preview({ document_id, max_dim, quality }) {
    const doc = resolveDoc(document_id, true);
    const q = quality || 8;
    const tmp = await fs.getTemporaryFolder();
    const file = await tmp.createFile('supreme-preview.jpg', { overwrite: true });
    const limit = max_dim || 1024;
    await modal(
      'Supreme: preview',
      async () => {
        const big = Math.max(doc.width, doc.height) > limit;
        if (!big) {
          await doc.saveAs.jpg(file, { quality: q }, true);
          return;
        }
        const scale = limit / Math.max(doc.width, doc.height);
        const dup = await doc.duplicate('supreme-preview-copy', true);
        try {
          await dup.resizeImage(Math.round(doc.width * scale), Math.round(doc.height * scale));
          await dup.saveAs.jpg(file, { quality: q }, true);
        } finally {
          await dup.closeWithoutSaving();
          try {
            app.activeDocument = doc;
          } catch (e) {
            /* ignore */
          }
        }
      },
      null
    );
    const data = await file.read({ format: formats.binary });
    return { mimeType: 'image/jpeg', data: toBase64(data) };
  },

  async subscribe({ events }) {
    if (subHandler) action.removeNotificationListener(subEvents, subHandler);
    subEvents = events.map((e) => ({ event: e }));
    subHandler = (event, descriptor) => send({ type: 'event', event, descriptor: safe(descriptor) });
    action.addNotificationListener(subEvents, subHandler);
    return { subscribed: events };
  },

  async unsubscribe() {
    if (subHandler) action.removeNotificationListener(subEvents, subHandler);
    subHandler = null;
    subEvents = [];
    return { subscribed: [] };
  },

  async record_start({ ignore }) {
    if (recHandler) action.removeNotificationListener(recEvents, recHandler);
    recLog = [];
    recIgnore = ignore || [];
    recStartedAt = Date.now();
    recHandler = (event, descriptor) => {
      if (recIgnore.includes(event)) return;
      if (recLog.length < 5000) recLog.push({ t: Date.now() - recStartedAt, event, descriptor: safe(descriptor) });
    };
    action.addNotificationListener(recEvents, recHandler);
    return { recording: true };
  },

  async record_stop() {
    if (recHandler) action.removeNotificationListener(recEvents, recHandler);
    recHandler = null;
    const out = recLog;
    recLog = [];
    return { recording: false, count: out.length, events: out };
  },

  // ------------------------------------------------- detect everything
  async fonts() {
    let list = [];
    try { list = Array.from(app.fontsList || []); } catch (e) { /* keep empty */ }
    return {
      count: list.length,
      families: [...new Set(list.map((f) => String(f.family || '').trim()).filter(Boolean))].sort(),
      fonts: list.slice(0, 4000).map((f) => ({ postScriptName: f.postScriptName || f.name, family: f.family, style: f.style, name: f.name })),
    };
  },

  /** Full inspection of one layer: DOM properties + the raw batchPlay descriptor
   * (text contents & styles, effects, fill, smart-object info, masks, …). */
  async describe_layer({ layer_id, document_id }) {
    const doc = resolveDoc(document_id, true);
    const l = findLayer(doc.layers, layer_id);
    if (!l) throw new Error('Layer ' + layer_id + ' not found');
    ensureActive(doc);
    let descriptor = null;
    try {
      const res = await action.batchPlay(
        [{ _obj: 'get', _target: [{ _ref: 'layer', _id: layer_id }], _options: { dialogOptions: 'dontDisplay' } }],
        { synchronousExecution: true }
      );
      descriptor = safe(res && res[0]);
    } catch (e) {
      descriptor = { error: String((e && e.message) || e) };
    }
    let textItem = null;
    if (l.kind === 'textLayer') {
      try {
        const ti = l.textItem;
        textItem = {
          contents: String(ti.contents).slice(0, 2000),
          font: ti.font, size: ti.size, tracking: ti.tracking,
          useAutoLeading: ti.useAutoLeading, leading: ti.leading,
          just: ti.just,
          color: (() => { try { const c = ti.color.rgb; return { r: c.red, g: c.green, b: c.blue, hex: c.hex }; } catch (e) { return null; } })(),
        };
      } catch (e) { /* ignore */ }
    }
    return {
      dom: layerToJSON(l, 4),
      textItem,
      descriptor,
    };
  },

  async history({ document_id }) {
    const doc = resolveDoc(document_id, true);
    const states = Array.from(doc.historyStates || []);
    return {
      count: states.length,
      active: doc.activeHistoryState ? doc.activeHistoryState.name : null,
      states: states.slice(-200).map((h, i) => ({ index: states.length - Math.min(states.length, 200) + i, name: h.name })),
    };
  },

  async goto_history({ document_id, name, index }) {
    const doc = resolveDoc(document_id, true);
    const states = Array.from(doc.historyStates || []);
    let target = null;
    if (name != null) target = states.find((h) => h.name === name) || null;
    else if (index != null) target = states[index] || null;
    if (!target) throw new Error('No history state ' + (name != null ? '"' + name + '"' : '#' + index));
    doc.activeHistoryState = target;
    return { switched: target.name };
  },

  async colors() {
    const c = (sc) => {
      try {
        const rgb = sc.rgb;
        return { r: Math.round(rgb.red), g: Math.round(rgb.green), b: Math.round(rgb.blue), hex: rgb.hex };
      } catch (e) { return null; }
    };
    return { foreground: c(app.foregroundColor), background: c(app.backgroundColor) };
  },

  async set_colors({ foreground, background }) {
    const mk = (c) => {
      const col = new app.SolidColor();
      col.rgb.red = Math.max(0, Math.min(255, Math.round(c.r)));
      col.rgb.green = Math.max(0, Math.min(255, Math.round(c.g)));
      col.rgb.blue = Math.max(0, Math.min(255, Math.round(c.b)));
      return col;
    };
    if (foreground) app.foregroundColor = mk(foreground);
    if (background) app.backgroundColor = mk(background);
    return { ok: true };
  },

  // ------------------------------------------------------------ HTML → layers
  async html_layers({ spec, target = 'new', document_id, group_name }) {
    if (!spec || !spec.canvas || !Array.isArray(spec.elements)) throw new Error('Invalid HTML layer spec.');
    const result = {
      document_id: null,
      created: 0, groups: 0, shapes: 0, texts: 0, images: 0,
      warnings: Array.isArray(spec.warnings) ? spec.warnings.slice(0, 40) : [],
      fonts: [],
    };
    return modal(
      'Supreme: HTML convert',
      async (ec) => {
        // -- document
        let doc;
        if (target === 'active') {
          doc = resolveDoc(document_id, true);
        } else {
          const c = spec.canvas;
          doc = await createDocCompat({
            title: group_name || 'HTML Import',
            width: Math.max(Math.round(c.w), 1),
            height: Math.max(Math.round(c.h), 1),
            transparent: !!c.background,
          });
        }
        result.document_id = doc.id;
        const resScale = (doc.resolution || 72) / 72;

        let hid = null;
        try { hid = await ec.hostControl.suspendHistory({ documentID: doc.id, name: 'Supreme: HTML convert' }); } catch (e) { hid = null; }
        try {
          const pickFont = makeFontPicker((msg) => { if (!result.warnings.includes(msg)) result.warnings.push(msg); });
          const reportFont = (family, weight, italic, font) => {
            result.fonts.push({ requested: family, used: font.psName, weight, italic });
          };

          const bp = async (desc) => {
            const res = await action.batchPlay([desc], { synchronousExecution: false });
            return res;
          };
          const activeLayerId = () => {
            try {
              const l = doc.activeLayers && doc.activeLayers[0];
              return l ? l.id : null;
            } catch (e) { return null; }
          };

          /** Wrap freshly created (contiguous) layers into a named group. */
          async function groupFrom(layers, name) {
            if (!layers.length) return null;
            if (layers.length === 1) {
              try { layers[0].name = name; } catch (e) { /* ignore */ }
              return layers[0];
            }
            try {
              const g = await doc.createLayerGroup({ name, fromLayers: layers });
              try {
                const kids = (g.layers && g.layers.length) || 0;
                if (!kids) throw new Error('empty group');
              } catch (e2) { throw e2; }
              result.groups++;
              return g;
            } catch (e) {
              try {
                const ids = layers.map((l) => ({ _ref: 'layer', _id: l.id }));
                await bp({ _obj: 'select', _target: ids, makeVisible: false, layerID: ids.map((x) => x._id), _options: { dialogOptions: 'dontDisplay' } });
                await bp({ _obj: 'make', _target: [{ _ref: 'layerSection' }], from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }, name, _options: { dialogOptions: 'dontDisplay' } });
                result.groups++;
                return doc.activeLayers[0];
              } catch (e2) {
                result.warnings.push(`Could not group "${name}" — layers were kept flat`);
                return null;
              }
            }
          }

          async function applyProps(layer, node) {
            try { if (node.opacity != null && node.opacity < 100) layer.opacity = node.opacity; } catch (e) { /* ignore */ }
            if (node.blend) {
              try {
                const key = String(node.blend).toUpperCase();
                if (constants.BlendMode && constants.BlendMode[key] != null) layer.blendMode = constants.BlendMode[key];
              } catch (e) { /* ignore */ }
            }
            const fx = shadowEffectDesc(node);
            if (fx) { try { await bp(fx); } catch (e) { result.warnings.push('Layer effect could not be applied to "' + node.name + '"'); } }
          }

          /** CSS filters → real Photoshop pixel filters on the active layer.
           * Skipped on type layers: a pixel filter would rasterize editable text. */
          async function applyFilters(layer, node) {
            const fl = node.filters;
            if (!fl || !fl.length) return;
            if (node.kind === 'text') {
              result.warnings.push(`CSS filter on text "${node.name}" skipped — applying it would rasterize the editable type`);
              return;
            }
            for (const f of fl) {
              try {
                if (f.kind === 'blur') {
                  await bp({ _obj: 'gaussianBlur', radius: pu(f.value), _options: { dialogOptions: 'dontDisplay' } });
                } else if (f.kind === 'grayscale') {
                  await bp({ _obj: 'desaturate', _options: { dialogOptions: 'dontDisplay' } });
                } else if (f.kind === 'invert') {
                  await bp({ _obj: 'invert', _options: { dialogOptions: 'dontDisplay' } });
                } else if (f.kind === 'brightness' || f.kind === 'contrast') {
                  const v = Math.max(-150, Math.min(150, Math.round((f.value - 1) * 100)));
                  await bp({ _obj: 'brightnessEvent', brightnessLevel: f.kind === 'brightness' ? v : 0, contrastLevel: f.kind === 'contrast' ? v : 0, _options: { dialogOptions: 'dontDisplay' } });
                } else if (f.kind === 'saturate') {
                  const v = Math.max(-100, Math.min(100, Math.round((f.value - 1) * 100)));
                  await bp({ _obj: 'hueSaturation', hue: 0, saturation: v, lightness: 0, _options: { dialogOptions: 'dontDisplay' } });
                } else if (f.kind === 'hue-rotate') {
                  const hue = Math.max(-180, Math.min(180, Math.round(f.value)));
                  await bp({ _obj: 'hueSaturation', hue, saturation: 0, lightness: 0, _options: { dialogOptions: 'dontDisplay' } });
                } else if (f.kind === 'sepia') {
                  const p = Math.max(0, Math.min(1, f.value));
                  if (p > 0.01) {
                    await bp({ _obj: 'hueSaturation', hue: 0, saturation: Math.round(-100 * p), lightness: 0, _options: { dialogOptions: 'dontDisplay' } });
                    try {
                      await bp({ _obj: 'photoFilter', color: { _obj: 'RGBColor', red: 187, grain: 137, blue: 90 }, density: { _unit: 'percentUnit', _value: Math.round(80 * p) }, preserveLuminosity: true, _options: { dialogOptions: 'dontDisplay' } });
                    } catch (e2) { /* desaturated-only fallback is fine */ }
                  }
                }
              } catch (e) {
                result.warnings.push(`Filter ${f.kind} could not be applied to "${node.name}"`);
              }
            }
          }

          /** Build one spec node (and its subtree). Returns the top Layer(s) created. */
          async function buildNode(node) {
            const own = []; // own visual layers, bottom → top
            // 1. background shape (fill/stroke/radius) sits under everything of this node
            const wantsBg = node.kind === 'shape' || node.kind === 'group' || (node.kind === 'image' && node.fill);
            const hasBgVisual = node.fill || (node.stroke && node.stroke.width) || (node.kind !== 'text');
            if (wantsBg && hasBgVisual && (node.fill || (node.stroke && node.stroke.width))) {
              try {
                try {
                  await bp(shapeDesc(node));
                } catch (eGrad) {
                  if (node.fill && node.fill.type === 'gradient' && node.fill.grad && node.fill.grad.stops && node.fill.grad.stops.length) {
                    // exotic gradient (e.g. offset radial) this Photoshop rejects — keep the box, use the first stop color
                    await bp(shapeDesc({ ...node, fill: { type: 'solid', color: node.fill.grad.stops[0].color } }));
                    result.warnings.push(`Gradient on "${node.name}" not supported by this Photoshop — used the first stop color`);
                  } else {
                    throw eGrad;
                  }
                }
                const l = doc.activeLayers[0];
                try { l.name = node.name + (node.kind === 'group' || node.kind === 'image' ? ' bg' : ''); } catch (e) { /* ignore */ }
                await applyProps(l, { ...node, shadow: node.kind === 'group' || node.kind === 'shape' || node.kind === 'image' ? node.shadow : null, innerShadow: node.innerShadow });
                await applyFilters(l, node);
                own.push(l);
                result.shapes++;
              } catch (e) {
                result.warnings.push(`Shape "${node.name}" could not be created: ${String((e && e.message) || e).slice(0, 80)}`);
              }
            }

            // 2. children, bottom-up (spec arrays are top→bottom)
            const kidLayers = [];
            const kids = node.children || [];
            for (let i = kids.length - 1; i >= 0; i--) {
              const made = await buildNode(kids[i]);
              if (made && made.length) kidLayers.push(...made);
            }

            // 3. own content layer
            let contentLayer = null;
            if (node.kind === 'text' && node.text) {
              const t = node.text;
              const font = pickFont(t.family, t.weight || 400, !!t.italic);
              reportFont(t.family, t.weight, !!t.italic, font);
              const contents = String(t.content).replace(/\n/g, '\r');
              try {
                await bp(textDesc(node, resScale, font, contents, pickFont));
                const l = doc.activeLayers[0];
                // position: anchor via measured bounds → translate
                try {
                  const b = l.bounds;
                  const anchorX = t.align === 'center' ? node.rect.x + t.boxWidth / 2 : t.align === 'right' ? node.rect.x + (t.boxWidth || node.rect.w) : node.rect.x;
                  const baselineY = node.rect.y + Math.max((t.leading - t.fontSize) / 2, 0) + t.fontSize * 0.82;
                  if (t.boxWidth) {
                    // box text: align the frame, then compensate the half-leading so the first
                    // line sits exactly where the browser puts it
                    const halfLead = Math.max((t.leading - t.fontSize) / 2, 0);
                    await l.translate(node.rect.x - b.left, node.rect.y - b.top + halfLead);
                  } else {
                    await l.translate(anchorX - b.left, baselineY - (b.top + b.height / 2));
                  }
                } catch (ePos) { /* keep default position */ }
                try { if (node.opacity != null && node.opacity < 100) l.opacity = node.opacity; } catch (e) { /* ignore */ }
                const tShadow = node.shadow;
                if (tShadow) {
                  try { await bp(shadowEffectDesc({ ...node, innerShadow: null })); } catch (e) { /* ignore */ }
                }
                contentLayer = l;
                result.texts++;
              } catch (e) {
                result.warnings.push(`Text "${String(t.content).slice(0, 24)}" could not be created: ${String((e && e.message) || e).slice(0, 80)}`);
              }
            } else if (node.kind === 'image' && node.image) {
              try {
                const entry = await (async () => {
                  const p = String(node.image.value).replace(/\\/g, '/');
                  const cands = p.startsWith('/') ? ['file:' + p] : ['file:/' + p, 'file:' + p];
                  let entry = null, err = null;
                  for (const u of cands) { try { entry = await fs.getEntryWithUrl(u); break; } catch (e) { err = e; } }
                  if (!entry) throw err || new Error('file not found: ' + p);
                  return entry;
                })();
                const token = await fs.createSessionToken(entry);
                await bp({
                  _obj: 'placeEvent',
                  null: { _path: token, _kind: 'local' },
                  freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
                  _options: { dialogOptions: 'dontDisplay' },
                });
                const l = doc.activeLayers[0];
                try { l.name = node.name; } catch (e) { /* ignore */ }
                // fit into target rect
                const b = l.bounds;
                const bw = b.right - b.left, bh = b.bottom - b.top;
                const tx = node.rect.w / bw, ty = node.rect.h / bh;
                const fit = node.image.fit || 'stretch';
                const AnchorPos = (constants.AnchorPosition && constants.AnchorPosition.MIDDLECENTER) || undefined;
                if (fit === 'stretch') {
                  await l.scale(tx * 100, ty * 100, AnchorPos);
                } else {
                  const s = (fit === 'cover' ? Math.max(tx, ty) : Math.min(tx, ty)) * 100;
                  await l.scale(s, s, AnchorPos);
                }
                const b2 = l.bounds;
                await l.translate((node.rect.x + node.rect.w / 2) - (b2.left + (b2.right - b2.left) / 2), (node.rect.y + node.rect.h / 2) - (b2.top + (b2.bottom - b2.top) / 2));
                // rounded corners on the image itself → non-destructive layer mask
                if (node.radius && (node.radius.tl || node.radius.tr || node.radius.br || node.radius.bl)) {
                  try {
                    const rr = node.radius;
                    await bp({
                      _obj: 'set', _target: [{ _property: 'selection' }],
                      to: {
                        _obj: 'rectangle', unitValueQuadVersion: 1,
                        top: pu(node.rect.y), left: pu(node.rect.x),
                        bottom: pu(node.rect.y + node.rect.h), right: pu(node.rect.x + node.rect.w),
                        topLeft: pu(rr.tl || 0), topRight: pu(rr.tr || 0),
                        bottomRight: pu(rr.br || 0), bottomLeft: pu(rr.bl || 0),
                      },
                      _options: { dialogOptions: 'dontDisplay' },
                    });
                    await bp({
                      _obj: 'make',
                      _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
                      using: { _enum: 'userMaskEnabled', _value: 'revealSelection' },
                      _options: { dialogOptions: 'dontDisplay' },
                    });
                    await bp({ _obj: 'set', _target: [{ _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' }, _options: { dialogOptions: 'dontDisplay' } });
                  } catch (eMask) {
                    result.warnings.push(`Rounded corners on "${node.name}" could not be masked — add a layer mask in Photoshop`);
                  }
                }
                await applyProps(l, { ...node, shadow: null, innerShadow: null });
                await applyFilters(l, node);
                contentLayer = l;
                result.images++;
              } catch (e) {
                result.warnings.push(`Image "${node.name}" could not be placed: ${String((e && e.message) || e).slice(0, 80)}`);
              }
            }

            // 4. assemble: own bg under children under content
            const stack = [];
            if (contentLayer) stack.push(contentLayer);
            stack.push(...kidLayers);
            stack.push(...own);
            if (!stack.length) return null;
            result.created += stack.length;

            if (node.filters && node.filters.length && node.kind === 'group') {
              result.warnings.push(`CSS filter on group "${node.name}" skipped — apply it to the layers inside`);
            }

            const isContainer = (node.children && node.children.length) || (contentLayer && own.length);
            let out = stack;
            if (isContainer) {
              const g = await groupFrom(stack, node.name);
              if (g) {
                try { if (node.opacity != null && node.opacity < 100) g.opacity = node.opacity; } catch (e) { /* ignore */ }
                out = [g];
              }
            }
            // CSS transform scale + rotate → transform the layer (or whole group) around its center.
            // CSS applies functions right-to-left: scale first, then rotate (translate is already in the rect).
            if (node.scale && (node.scale.x !== 1 || node.scale.y !== 1)) {
              const anchor = (constants.AnchorPosition && constants.AnchorPosition.MIDDLECENTER) || undefined;
              const targets = Array.isArray(out) ? out : [out];
              let scaled = false;
              for (const l of targets) {
                try { await l.scale(node.scale.x * 100, node.scale.y * 100, anchor); scaled = true; } catch (e) { /* try remaining */ }
              }
              if (!scaled) result.warnings.push(`Could not scale "${node.name}" (${node.scale.x}x/${node.scale.y}y) — transform the layer in Photoshop`);
            }
            if (node.rotate) {
              const anchor = (constants.AnchorPosition && constants.AnchorPosition.MIDDLECENTER) || undefined;
              const targets = Array.isArray(out) ? out : [out];
              let rotated = false;
              for (const l of targets) {
                try { await l.rotate(node.rotate, anchor); rotated = true; } catch (e) { /* try remaining */ }
              }
              if (!rotated) result.warnings.push(`Could not rotate "${node.name}" (${Math.round(node.rotate)}°) — rotate the layer in Photoshop`);
            }
            return out;
          }

          // page background (bottom-most)
          if (spec.canvas.background) {
            try {
              const bgNode = {
                kind: 'shape', name: 'Page background',
                rect: { x: 0, y: 0, w: spec.canvas.w, h: spec.canvas.h },
                fill: spec.canvas.background, radius: null, stroke: null,
              };
              await bp(shapeDesc(bgNode));
              const l = doc.activeLayers[0];
              try { l.name = 'Page background'; } catch (e) { /* ignore */ }
              result.shapes++;
              result.created++;
            } catch (e) { /* background is cosmetic */ }
          }

          // top-level elements, bottom-up
          const topLayers = [];
          const els = spec.elements;
          for (let i = els.length - 1; i >= 0; i--) {
            const made = await buildNode(els[i]);
            if (made && made.length) topLayers.push(...made);
          }

          // wrap everything in one group when importing into an existing document
          if (target === 'active' && topLayers.length) {
            const g = await groupFrom(topLayers, group_name || 'HTML Import');
            return g ? [g] : topLayers;
          }
          return topLayers;
        } finally {
          if (hid != null) {
            try { await ec.hostControl.resumeHistory(hid, true); } catch (e) { /* ignore */ }
          }
        }
      },
      null
    ).then((layers) => {
      // collapse repeats: "font X missing" from 30 layers should read once as "… (×30)"
      const counts = new Map();
      for (const w of result.warnings) counts.set(w, (counts.get(w) || 0) + 1);
      result.warnings = [...counts.entries()].map(([w, n]) => (n > 1 ? w + ' (×' + n + ')' : w)).slice(0, 60);
      return { ...result, topLayers: (layers || []).map((l) => ({ id: l.id, name: l.name })) };
    });
  },
};

// ------------------------------------------------------- connection / queue
// Photoshop allows one modal operation at a time, so serialize all calls.
let queue = Promise.resolve();
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  setStatus('Connecting…');
  try {
    ws = new WebSocket(URL);
  } catch (e) {
    uiLog(String(e));
    retryTimer = setTimeout(connect, 2000);
    return;
  }
  ws.onopen = () => {
    setStatus('Connected ✓');
    uiLog(URL);
    send({
      type: 'hello',
      info: { plugin: VERSION, photoshop: app.version, uxp: uxp.versions && uxp.versions.uxp },
    });
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.type !== 'call') return;
    queue = queue.then(async () => {
      try {
        const h = handlers[msg.action];
        if (!h) throw new Error('Unknown action: ' + msg.action);
        const data = await h(msg.params || {});
        send({ type: 'result', id: msg.id, ok: true, data });
      } catch (e) {
        send({
          type: 'result',
          id: msg.id,
          ok: false,
          error: { message: String((e && e.message) || e), stack: e && e.stack },
        });
      }
    });
  };
  ws.onclose = () => {
    setStatus('Disconnected — retrying…');
    retryTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => {
    uiLog('Cannot reach ' + URL + ' (is the MCP server running?)');
  };
}

uxp.entrypoints.setup({ panels: { supremePanel: { show() { applyUI(); } } } });
try {
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', applyUI);
} catch (e) {
  /* ignore */
}
connect();
