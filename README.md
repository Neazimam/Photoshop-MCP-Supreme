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

Flags: `--silent` (no message box), `--use-cc` (prefer Creative Cloud's installer for the plugin), `--uninstall`.

**Web UI:** open <http://127.0.0.1:38461/> any time: daemon + plugin status, active document and layer tree, live preview, and fixes if Photoshop isn't connected.
(Served only to `127.0.0.1`/`localhost` hosts; other sites and DNS-rebinding are blocked.)

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
| Layers | `ps_create_layer`, `ps_set_layer_props`, `ps_delete_layer`, `ps_duplicate_layer`, `ps_transform_layer`, `ps_create_text_layer` |
| Selection / filters | `ps_select`, `ps_fill_selection`, `ps_gaussian_blur` |

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

## Status / known limits

- Tested here: server, daemon, stdio shim, HTTP MCP endpoint, auth/origin checks, image placement (against a fake plugin), config merge helper.
  The installer **compiles cleanly** but has not been run on a real Windows machine; the plugin has not been run inside real Photoshop.
- Windows only (macOS needs a different installer). Photoshop 2023 (24.2)+ required.
- Adobe may show a "not verified by Adobe" prompt for the unsigned plugin; choose Install. The `.ccx` must be on the same drive as Photoshop (the installer handles a different-drive case when it can).
- If automatic plugin install fails, the installer prints the manual fallback (UXP Developer Tool > Add Plugin > `plugin\manifest.json`).
- Likely small fixes inside Photoshop: `createTextLayer` options, `doc.duplicate` in `ps_preview`, `file:` URL format for Windows paths (both forms are tried), `selection.fill`, `placeEvent` descriptor.
