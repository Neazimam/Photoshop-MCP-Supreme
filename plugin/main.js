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
const VERSION = '0.2.2';
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
