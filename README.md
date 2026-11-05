# Photoshop Supreme MCP

Full-control MCP server for Adobe Photoshop. A UXP plugin inside Photoshop connects **out** to a local daemon over
WebSocket (push, no polling) and exposes the whole Photoshop DOM, raw `batchPlay`, events, a recorder, image placement,
and typed tools.

```
Claude Desktop / Cursor --stdio--> supreme.mjs (thin shim) --http 127.0.0.1:38461--> DAEMON --ws 127.0.0.1:38460--> UXP plugin --> Photoshop
Any HTTP MCP client ---------------------------------------- POST /mcp (bearer token) --^
```

## Install (Windows) - one double-click, silent

Put `PhotoshopSupremeMCP-Setup.exe` in this folder's root (next to `server\`, `plugin\`, `plugin.ccx`) and run it. No console window, no admin rights.
Every run is a **clean reinstall**: it removes the old version, then installs the new one:

1. Stops the old daemon; detects Photoshop (registry + Program Files).
2. Finds Node.js >= 18, or downloads a private portable copy (SHA-256 verified against nodejs.org).
3. Removes the previous plugin (any version) from Photoshop's plugin folder and `PluginsInfo\v1\PS.json`, and the old files.
4. Copies the new version to `%LOCALAPPDATA%\PhotoshopSupremeMCP` (you can delete the zip afterwards).
5. Registers the MCP server in Claude Desktop and Cursor configs (backs up originals, never overwrites invalid JSON).
6. Installs the Photoshop plugin **directly** (copy to `%APPDATA%\Adobe\UXP\Plugins\External` + register in `PS.json`; no Creative Cloud, no Adobe prompt). If that fails it falls back to Creative Cloud's installer.
7. Registers a hidden auto-start daemon (HKCU Run key) and starts it.

A single message box tells you the result. Then just **open Photoshop and your AI app** - the plugin loads with Photoshop and connects to the
daemon by itself (no panel to open). If either app was already running, restart it once. Log: `%LOCALAPPDATA%\PhotoshopSupremeMCP\install.log`.

**Drop-in updates:** the watchdog watches the `server\` folder - replace `supreme.mjs` (or run a newer installer's file copy) and the daemon hot-restarts with the new build within seconds.

Flags: `--silent` (no message box), `--use-cc` (prefer Creative Cloud's installer for the plugin), `--uninstall`.

## Dashboard - `http://127.0.0.1:38461/`

| Tab | What you get |
| --- | --- |
| **Overview** | Health summary with "needs attention" items, plugin status + Photoshop version, total calls, success rate, avg/p95 latency, uptime, calls-per-minute chart, **who is calling** (per AI app), busiest tools, active document + layer tree + live preview |
| **Calls** | Every call: time, **client** (e.g. `Claude Desktop/1.x`, `cursor-vscode/..`), tool, duration, ok/error. Click a row for arguments, error text, the suggested fix and the plugin stack. Filter by text/client/errors-only; download JSON; clear history |
| **Errors** | Most frequent errors, each with a plain-language **how to fix** (plugin not connected, dialog open, timeout, stale layer id, missing permission...) |
| **Convert** | **HTML → editable Photoshop layers**: drop an AI-generated `.html` file (or browse, or paste source) and get a new document (or insert into the active one) where every element is a real layer — text as editable text layers (fonts auto-matched, substitutions reported), boxes as shape layers with fills/strokes/corner radii, `linear-gradient` as gradient fill layers, `box-shadow` as live Drop Shadow layer effects, `<img>`/`background-image` as placed smart objects (data URIs, http(s) URLs, or paths relative to the HTML file). Live preview, size presets, samples, conversion history. See the Convert section below for the supported CSS subset |
| **Connect AI apps** | Detects Claude Desktop / Cursor config state, and shows **ready-to-copy config** (using the exact Node + server paths) for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Cline/Roo, Gemini CLI, Codex CLI, any HTTP-capable client, plus what ChatGPT needs and why it is not recommended |
| **Tools** | All registered tools with description, call count, errors, avg time; flags the ones that execute code |
| **Diagnostics** | One-click **self-test** (plugin link, round-trip speed, Photoshop version, document read, raw batchPlay, script permission, modal rights), environment/paths/ports/mode, plugin connect/disconnect history |

Who is calling: stdio apps (Claude Desktop, Cursor, ...) report the name/version they announce when they connect; HTTP clients are identified from their
`initialize` message or User-Agent. Every call is also appended to an audit log `~/.photoshop-supreme-mcp/calls.jsonl` (tool, client, duration, result, truncated arguments; auto-rotated at 5 MB).
The page is served only to `127.0.0.1`/`localhost` hosts (other sites and DNS-rebinding are blocked); all displayed text is inserted safely (no HTML injection from layer names or error messages).

### Convert tab — HTML/CSS → editable Photoshop layers

The Overview tab carries a **Dynamic control** row — one-click Undo / Redo / Snapshot straight from the browser plus **Detect all** (colors, fonts, history, document state read live from Photoshop).

Open `http://127.0.0.1:38461/` → **Convert** → drop an `.html` file (or click to browse, or paste the source) → **Convert to layers**. The page is parsed and laid out server-side, then the plugin builds
real layers inside one undo step: groups per container, shape layers for boxes, text layers for copy, placed smart objects for images.

**Workflow niceties:** drag & drop, a live preview that re-renders as you edit the source, three built-in samples (business card, social post, pricing section) to try the pipeline instantly, document size presets (Square 1080×1080, Story 1080×1920, Full HD, A4 @300 dpi, or custom), scale %, target/group-name options, and a recent-conversions history with one-click restore.

| CSS → Photoshop | How it lands |
| --- | --- |
| Text (`h1`-`h6`, `p`, `span`, `a`, bare text, `text-transform`, `letter-spacing`, `line-height`, `text-align`) | Editable **text layers** (point type; paragraph/box type when the CSS width forces wrapping). **Mixed inline styles** (`<b>`, `<i>`, colored `<span>`, `<u>`) become real per-range text styles inside one editable layer. Fonts: exact PostScript name → family + weight style → faux bold/italic → known web-font aliases (Inter → Segoe UI, Roboto → Arial, Playfair → Georgia…) → closest installed fallback; every substitution is listed in the result |
| Boxes with `background`/`background-color` | **Shape layers** (solid or gradient fill), incl. corner radii from `border-radius`; uniform `border` becomes a live stroke, **per-side borders** (`border-bottom: 3px solid red`, …) become exact bar shapes |
| `linear-gradient(...)`, `radial-gradient(...)`, `repeating-linear-gradient(...)` | Real **gradient fill layer** with the CSS stops; angle mapped CSS → Photoshop; repeating gradients are baked out stop-by-stop so the pattern survives. Only `conic` gradients fall back to a solid fill of the first color (clearly warned) |
| `box-shadow` / `text-shadow` | Live **Drop Shadow** layer effect (offset/blur/spread/opacity mapped); `inset` → Inner Shadow |
| `<img>`, `background-image: url(...)` | Placed as **smart object**, scaled to the CSS box (`object-fit: cover/contain` honoured, default stretch). Sources: data URIs, http(s) URLs, or local paths resolved relative to the HTML file |
| Layout | Absolute positioning (incl. `right`/`bottom` anchoring), block flow, **inline flow** (inline-blocks/links/images sit side by side, wrap, and follow `text-align: center/right`), flexbox (row/column, `gap`/`column-gap`/`row-gap`, `justify-content`, `align-items`, `flex: n`, wrap), `box-sizing: content-box` honoured, page background from `html`/`body`, `overflow: hidden` clips children geometrically |
| `opacity`, `mix-blend-mode` | Layer opacity / Photoshop blend mode |

Options: **New document** (sized to the design, default) or **into the active document** (everything wrapped in a named group), plus a scale percentage and a document size preset. A preset acts as the
minimum canvas — CSS `body` sizes still win per axis, and if content sticks out past the preset the canvas grows so nothing is clipped (reported in the result panel).
Everything unsupported (CSS transforms, filters, pseudo-elements, inline SVG, @media responsive variants beyond the desktop pass) is reported in the
result panel instead of silently mis-rendering. The HTML is parsed by the local daemon only — nothing is uploaded anywhere; remote image URLs are
downloaded by the daemon with a 50 MB cap.

**Large files:** AI-generated pages often embed multi-megabyte base64 photos. Embedded images up to 1.5 MB always keep their real pixels; only when the whole page passes 12 MB are the largest
images swapped for clearly-marked placeholders (and reported); the hard stop is 25 MB (the error shows the actual size and how to fix it).

### Config for each AI app (also shown, with your real paths, on the Connect tab)

| App | Where | Shape |
| --- | --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` -> `{command, args}` (installer does this) |
| Claude Code | terminal | `claude mcp add photoshop-supreme -- <node> <supreme.mjs>` |
| Cursor | `~\.cursor\mcp.json` | `mcpServers` (installer does this) |
| VS Code | `.vscode/mcp.json` | `servers` -> `{type:"stdio", command, args}` |
| Windsurf | `~\.codeium\windsurf\mcp_config.json` | `mcpServers` |
| Cline / Roo | MCP Servers panel | `mcpServers` (+ `disabled`, `autoApprove`) |
| Gemini CLI | `~\.gemini\settings.json` | `mcpServers` |
| Codex CLI | `~\.codex\config.toml` | `[mcp_servers.photoshop-supreme]` |
| HTTP clients | client setting | `http://127.0.0.1:38461/mcp` + `Authorization: Bearer <token>` |
| ChatGPT | - | needs a public **HTTPS** remote server; cannot run local stdio or reach localhost. Not recommended (would expose Photoshop + files). |

Config formats follow each app's documented conventions as of my knowledge; check the app's docs if one rejects a snippet.

### Building the installer

Build it as a **Windows-subsystem** app (no console). `installer\build.bat` (MSVC x64 Native Tools prompt) does this; in a Visual Studio project set
Linker > System > SubSystem = **Windows** and Linker > Advanced > Entry Point = **mainCRTStartup**, C++17, Release x64, `/MT`, no precompiled headers.
`installer/build-mingw.sh` also works. Output lands in the project root.
The server bundle is rebuilt with `./build-server.sh` (needs `npm install` first); sources are in `src/`.

### Plugin not showing in Photoshop?
1. Restart Photoshop once after installing (it reads its plugin list at startup). Photoshop 2023 (24.2)+ required.
2. Check `%APPDATA%\Adobe\UXP\Plugins\External\com.eagle.photoshop-supreme-mcp_*` exists and `%APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json` lists `com.eagle.photoshop-supreme-mcp`.
3. Read `%LOCALAPPDATA%\PhotoshopSupremeMCP\install.log`.
4. Run the installer with `--use-cc` (Creative Cloud route), or load `plugin\manifest.json` in UXP Developer Tool (Preferences > Plugins > Enable Developer Mode).
The plugin manifest needs icons and `allowCodeGenerationFromStrings`; both are set (v0.2.2). The direct-install method follows the community-documented layout and has not been verified on every Photoshop version.

## Can ChatGPT / Claude Desktop push an image into Photoshop?

Yes - with `ps_place_image` (path, URL, or base64). Practical notes:

- **Claude Desktop / Cursor** (local stdio): fully supported. An image you merely *attach* to the chat is seen by the model but is not a file on disk
  that a tool can read, so give it a file path or URL (or let it generate/download the image to disk first). Base64 works only for small images.
- **ChatGPT** only connects to *remote HTTPS* MCP servers (Developer Mode), not local stdio. The daemon exposes a Streamable-HTTP endpoint
  (`http://127.0.0.1:38461/mcp`, bearer token in `%USERPROFILE%\.photoshop-supreme-mcp\token`), but ChatGPT's servers cannot reach localhost -
  you would need your own authenticated HTTPS tunnel. Not set up by the installer on purpose: it would expose Photoshop (and file access) to the internet.

## Tools

| Group | Tools |
| --- | --- |
| Status / state | `ps_status`, `ps_get_state`, `ps_preview` (returns a JPEG) |
| **Full control** | `ps_batch_play` (raw ActionDescriptors), `ps_run_uxp` (any UXP JS), `ps_get_descriptor` |
| Discovery | `ps_record_start` / `ps_record_stop`, `ps_subscribe` / `ps_get_events` / `ps_unsubscribe` |
| Images | `ps_place_image` |
| **God mode** | `ps_inspect` (explore the live Photoshop API), `ps_cookbook` (recipes + method), `ps_snapshot` (safety net), `ps_play_action`, `ps_run_extendscript` (legacy JSX via COM, Windows) |
| **Self-extending** | `ps_save_script`, `ps_list_scripts`, `ps_run_script`, `ps_delete_script` - the AI saves working code and re-uses it in later sessions |
| Documents | `ps_new_document`, `ps_open_document`, `ps_save_document`, `ps_close_document`, `ps_undo`, `ps_redo` |
| Layers | `ps_create_layer`, `ps_set_layer_props`, `ps_delete_layer`, `ps_duplicate_layer`, `ps_transform_layer` (move/scale/rotate/absolute place), `ps_create_text_layer`, `ps_edit_text` (edit existing type), `ps_reorder_layer`, `ps_group_layers`, `ps_smart_object`, `ps_rasterize`, `ps_create_fill_layer` (solid/gradient) |
| Selection / filters | `ps_select`, `ps_fill_selection`, `ps_gaussian_blur`, `ps_layer_effects` (drop/inner shadow, glow, stroke, overlay), `ps_adjustment` (brightness/contrast, hue/sat, vibrance, photo filter…), `ps_filter` (blur, motion, unsharp, noise, median, high pass…) |
| **Detect everything** | `ps_describe_layer` (DOM + raw descriptor dump of one layer), `ps_list_fonts`, `ps_get_colors` / `ps_set_colors`, `ps_get_history` / `ps_goto_history` (undo-timeline time travel) |
| **Control everything** | `ps_export_layer` (isolate + trim + save one layer), `ps_merge_layers` / flatten, `ps_align_layer` (to canvas or another layer), `ps_flip_layer`, `ps_add_mask` (reveal/hide/from selection), `ps_set_clipping` (clipping mask), `ps_set_shape_fill` (recolor or re-gradient an existing shape) |

Every mutation runs in `executeAsModal` as **one undo step**; mutating tools take `document_id`; calls are serialized.
Add a tool = a `js(code, args, opts)` call in `src/tools.ts` (parameters travel in `ctx.args`, never string-interpolated).

## How "anything" works

Photoshop can do far more than any fixed tool list, so the server gives the AI a method instead of a menu:

1. `ps_cookbook` - ready recipes (smart objects, Select Subject, masks, Content-Aware Fill, layer styles, bulk loops...).
2. `ps_inspect` - walk the live DOM (`app`, `app.activeDocument`, ...) to see exactly which properties/methods exist.
3. `ps_record_start` -> do it by hand once in Photoshop -> `ps_record_stop` - captures the exact descriptors for *any* UI feature (filters, Neural Filters, generative tools, ...).
4. `ps_snapshot` before experimenting; restore if it goes wrong.
5. `ps_batch_play` / `ps_run_uxp` / `ps_run_extendscript` execute whatever was learned.
6. `ps_save_script` keeps it; `ps_run_script` replays it. Over time the AI builds its own toolbox.

`document_id` pinning now also applies to raw `batchPlay` (the plugin activates the target document first).

## Security

- **Mode switch:** set `PS_SUPREME_MODE=safe` (in the MCP host's `env`) to hide the code-execution tools (`ps_run_uxp`, `ps_inspect`, `ps_run_extendscript`, saved scripts) from that client. This is a convenience, not a sandbox: `ps_batch_play` is still raw Photoshop access, and anything holding the daemon token can still reach the plugin.
- **Prompt-injection risk:** an AI that reads untrusted content (a document's text layers, a downloaded image's metadata, a web page) can be tricked into calling these tools. `ps_run_extendscript` can execute system commands. Keep your MCP host's per-tool approval on, and use `safe` mode for untrusted workflows.

- `ps_run_uxp` / `ps_batch_play` run arbitrary code in Photoshop; the plugin has full file access (`localFileSystem: fullAccess`).
- Daemon listens on `127.0.0.1` only. Its HTTP API requires a random bearer token (file readable by your user) and rejects any request carrying a browser `Origin`;
  the plugin WebSocket also rejects browser origins. Other programs running as you can still read the token - use on a machine you trust.
- `ps_place_image` fetches only `http(s)` URLs, max 50 MB.
- The installer downloads only Node.js from nodejs.org and verifies its SHA-256. The exe is unsigned, so Windows SmartScreen may warn.

## Changelog

**0.9.0**
- Convert fidelity: per-side borders (`border-bottom: 4px solid red` etc.) become exact bar shapes — accent lines, dividers and outlined buttons finally match the browser; uniform borders stay a live stroke
- Convert fidelity: `box-sizing: content-box` (the CSS default) is honoured — explicit width/height now correctly grow by padding + border on pages without the `*{box-sizing:border-box}` reset
- Convert fidelity: inline-level elements (inline-blocks, links, images, buttons) flow horizontally on shared lines, wrap like a browser, and follow the container's `text-align`
- Convert fidelity: mixed inline styles — `<b>`, `<i>`, colored/sized `<span>`, `<u>`, `<s>` inside one paragraph — become real per-range text styles in ONE editable text layer (PS `textStyleRange`)
- Convert fidelity: `repeating-linear-gradient` / `repeating-radial-gradient` are baked into explicit stops, so striped/animated patterns survive; stacked `background-image` layers keep the first and say so
- Convert fidelity: known web fonts map to their closest installed metric cousins (Inter → Segoe UI, Roboto → Arial, Playfair Display → Georgia, JetBrains Mono → Consolas, …) before falling back generically
- Convert fidelity: duplicate warnings are collapsed with a ×count, so a 30-layer font miss reads once
- New detect tools: `ps_describe_layer` (everything Photoshop knows about a layer: DOM + text item + raw batchPlay descriptor), `ps_list_fonts` (with filter), `ps_get_colors`/`ps_set_colors`, `ps_get_history`/`ps_goto_history`
- New control tools: `ps_export_layer` (one layer → PNG/JPG, isolated + trimmed), `ps_merge_layers`/flatten, `ps_align_layer` (canvas- or layer-relative), `ps_flip_layer`, `ps_add_mask` (reveal all/hide all/from selection), `ps_set_clipping` (clipping masks), `ps_set_shape_fill` (solid or multi-stop gradient on an existing shape)
- Dashboard: **Dynamic control** row on the Overview tab — Undo / Redo / Snapshot buttons and a **Detect all** panel (colors + fonts + history + document state, live from Photoshop)

**0.8.0**
- Convert accuracy: `vw`/`vh`/`vmin`/`vmax` units now resolve against the real canvas (hero sections with `height: 100vh` finally land full-size)
- Convert accuracy: `margin: auto` centers fixed-width blocks; `position: relative` offsets (top/left/right/bottom) shift the layer subtree like the browser
- Convert accuracy: `min-/max-width`, `min-/max-height` are enforced; `flex-wrap: wrap` lays out real multi-row card grids; `scale()`/`scaleX()`/`scaleY()` transforms scale the layer in Photoshop (only skew/3D still warn)
- Convert accuracy: better per-character text width estimation → wrap and auto-size decisions match the browser much more closely; block text now uses Photoshop box (paragraph) text so `text-align: center/right` is pixel-faithful; first-line half-leading is compensated
- Convert accuracy: `text-decoration: underline / line-through` becomes real text styling; images with `border-radius` get a non-destructive layer mask (rounded corners survive)
- Convert accuracy: `sepia()` and `hue-rotate()` filters map to real Photoshop hue/saturation + photo filter adjustments
- New dynamic control tools: `ps_layer_effects` (drop/inner shadow, outer glow, stroke, color overlay — live, merged), `ps_adjustment` (brightness/contrast, hue/saturation, vibrance, photo filter, invert, desaturate, posterize, threshold), `ps_filter` (gaussian/motion blur, unsharp mask, sharpen, noise, median, high pass — auto-rasterizes type/shape with a note), `ps_edit_text` (contents/size/font/color/tracking/leading/align on an existing text layer), `ps_reorder_layer` (front/back/forward/backward/into group), `ps_group_layers`, `ps_smart_object`, `ps_rasterize`, `ps_create_fill_layer` (solid or multi-stop gradient, clip-to-below), `ps_crop_document`, `ps_resize_canvas`, `ps_resize_image`; `ps_transform_layer` gained absolute x/y placement

**0.7.0**
- Convert: radial gradients are now real Photoshop radial gradient fills (with off-center support) — no more "approximated with a solid fill"
- Convert: CSS `transform: rotate(...)` actually rotates the layer/group in Photoshop; `translate(...)` moves the layer; only skew/scale still warn
- Convert: CSS filters become real Photoshop filters — blur → Gaussian Blur, grayscale → Desaturate, invert, brightness/contrast, saturate; `drop-shadow` → live layer effect; `opacity()` → layer opacity. Filters on text layers are skipped (they would rasterize the type — keeps it editable)
- Convert: embedded images up to 1.5 MB always keep their real pixels; the swap threshold only kicks in for pages over 12 MB (a 5.4 MB file with two big photos now converts untouched)
- Convert: duplicate warnings fixed — the panel no longer shows each engine warning twice
- Fonts: when a requested family isn't installed, the converter now falls back through popular system fonts (Segoe UI → Arial → Helvetica …) and reports exactly what it used, instead of jumping to "Photoshop default"

**0.6.0**
- Convert: fixed `TypeError: Cannot read properties of undefined (reading 'TRANSPARENT')` — document creation no longer depends on `constants.NewDocumentFill` (missing on several Photoshop builds); falls back to the classic batchPlay descriptor, transparent and white canvases both work. Same fix inside `ps_new_document`.
- Convert: live layer blueprint — the dashboard now parses your HTML as you type and lists exactly what will become layers (text/shape/image/group, sizes and positions) before you spend a Photoshop run; no Photoshop call needed
- Dashboard: Photoshop preview is now realtime — auto-refreshes every second on Overview and Convert (pauses while hidden, skips while a render is in flight); the manual Refresh preview button stays
- Dashboard: Ctrl+Enter converts from the source editor; preview images swap in place (no flicker), LIVE badges show the auto-refresh state
- Errors: specific fix-it hint when an outdated plugin build reports the NewDocumentFill crash

**0.5.0**
- Convert: files over 5 MB no longer fail — oversized embedded base64 images are swapped for placeholders (reported); hard limit raised to 25 MB with size-aware errors
- Convert: drag & drop, paste/edit source, live preview (scales to the real canvas), document size presets (Square/Story/Full HD/A4/custom — minimum-canvas semantics, growth reported), three built-in samples, recent-conversions history with restore, progress bar + elapsed time + toasts
- Convert: every response carries `serverVersion`; the UI flags replies from a pre-0.5 daemon (stale background daemon detection)
- Engine: fixed auto-sized flex containers measuring at roughly half size when the body had no CSS width/height (fit-to-content pages got a too-small canvas)
- Installer: watchdog hot-restarts the daemon when `server\` files change (drop-in updates go live without a reboot or manual restart)

**0.4.0** — Convert tab: HTML/CSS → editable Photoshop layers (text layers, shape layers, gradient fills, live layer effects, smart-object images), WebSocket push architecture, undo grouping, action recorder, dashboard.

## Status / known limits

- Tested here: server, daemon, stdio shim, HTTP MCP endpoint, auth/origin checks, image placement (against a fake plugin), config merge helper.
  The installer **compiles cleanly** but has not been run on a real Windows machine; the plugin has not been run inside real Photoshop.
- Windows only (macOS needs a different installer). Photoshop 2023 (24.2)+ required.
- Adobe may show a "not verified by Adobe" prompt for the unsigned plugin; choose Install. The `.ccx` must be on the same drive as Photoshop (the installer handles a different-drive case when it can).
- If automatic plugin install fails, the installer prints the manual fallback (UXP Developer Tool > Add Plugin > `plugin\manifest.json`).
- Likely small fixes inside Photoshop: `createTextLayer` options, `doc.duplicate` in `ps_preview`, `file:` URL format for Windows paths (both forms are tried), `selection.fill`, `placeEvent` descriptor.
