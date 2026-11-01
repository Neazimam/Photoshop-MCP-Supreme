/** Self-contained status page served by the daemon at http://127.0.0.1:<port>/ . No external assets. */
export function dashboardHtml(token: string, httpPort: number, bridgePort: number): string {
  const css = `
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--card:#f5f5f7;--line:#d2d2d7;--ok:#1a7f37;--bad:#c62828;--acc:#0a66c2}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f5f5f7;--mut:#a1a1a6;--card:#222225;--line:#3a3a3e;--ok:#3fb950;--bad:#ff6b6b;--acc:#4da3ff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.row{display:flex;align-items:center;gap:10px;padding:4px 0}.dot{width:10px;height:10px;border-radius:50%;background:var(--bad);flex:none}.dot.ok{background:var(--ok)}
.mut{color:var(--mut)}button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}button:hover{border-color:var(--acc)}
pre{margin:0;white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,Consolas,monospace}
ul{margin:6px 0 0;padding-left:20px}#layers{max-height:300px;overflow:auto;font:12px/1.6 ui-monospace,Consolas,monospace}
img{max-width:100%;border-radius:8px;border:1px solid var(--line);margin-top:10px}#help li{margin:4px 0}`;
  const js = `
var T=${JSON.stringify(token)};
function api(p,b){return fetch(p,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+T},body:JSON.stringify(b||{})}).then(function(r){return r.json()});}
function $(id){return document.getElementById(id)}
function setDot(id,on){$(id).className='dot'+(on?' ok':'')}
function tree(layers,depth,out){(layers||[]).forEach(function(l){out.push(new Array(depth+1).join('  ')+(l.layers?'[+] ':'- ')+l.name+'  (#'+l.id+', '+l.kind+(l.visible?'':', hidden')+')');if(l.layers)tree(l.layers,depth+1,out)});return out}
var busy=false;
function tick(){
  if(busy)return;busy=true;
  api('/status').then(function(s){
    var d=s.data||{};setDot('d1',true);setDot('d2',!!d.connected);
    $('plug').textContent=d.connected?('connected - Photoshop '+((d.pluginInfo||{}).photoshop||'?')+', plugin v'+((d.pluginInfo||{}).plugin||'?')):'not connected';
    $('help').style.display=d.connected?'none':'block';
    $('docs').style.display=d.connected?'block':'none';
    if(!d.connected)return;
    return api('/rpc',{action:'get_state',params:{depth:3}}).then(function(r){
      if(!r.ok){$('doc').textContent=r.error;return}
      var st=r.data,doc=st.document;
      $('doc').textContent=doc?(doc.title+' - '+doc.width+' x '+doc.height+' px, '+doc.mode+', '+st.documents.length+' open'):'No document open';
      $('layers').textContent=doc?tree(st.layers,0,[]).join('\\n'):'';
    });
  }).catch(function(){setDot('d1',false);setDot('d2',false);$('plug').textContent='daemon unreachable'}).then(function(){busy=false});
}
function preview(){$('pv').textContent='Rendering...';api('/rpc',{action:'preview',params:{max_dim:900}}).then(function(r){
  if(!r.ok){$('pv').textContent=r.error;return}$('pv').textContent='';var i=new Image();i.src='data:'+r.data.mimeType+';base64,'+r.data.data;$('pv').appendChild(i)})}
function copyCfg(){var t=$('cfg').textContent;navigator.clipboard&&navigator.clipboard.writeText(t);$('cp').textContent='Copied'}
tick();setInterval(tick,2500);
$('pvb').onclick=preview;$('cp').onclick=copyCfg;`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photoshop Supreme MCP</title><style>${css}</style></head><body><main>
<h1>Photoshop Supreme MCP</h1><div class="mut">Local control panel &middot; daemon 127.0.0.1:${httpPort} &middot; plugin bridge ws://127.0.0.1:${bridgePort}</div>
<h2>Status</h2><div class="card">
<div class="row"><span class="dot" id="d1"></span><b>Daemon</b><span class="mut">running</span></div>
<div class="row"><span class="dot" id="d2"></span><b>Photoshop plugin</b><span class="mut" id="plug">checking...</span></div></div>
<div id="help" style="display:none"><h2>Photoshop plugin not connected</h2><div class="card"><ol>
<li>The plugin loads automatically when Photoshop starts - <b>restart Photoshop once</b> after installing. (Photoshop 2023 / 24.2 or newer is required.)</li>
<li>Still not connected? Check that <code>%APPDATA%\\Adobe\\UXP\\Plugins\\External\\com.eagle.photoshop-supreme-mcp_*</code> exists and that <code>%APPDATA%\\Adobe\\UXP\\PluginsInfo\\v1\\PS.json</code> lists <code>com.eagle.photoshop-supreme-mcp</code>. If not, run the installer again; its log is <code>%LOCALAPPDATA%\\PhotoshopSupremeMCP\\install.log</code>.</li>
<li>Installed but Photoshop's Plugins menu is empty? Run <code>PhotoshopSupremeMCP-Setup.exe --use-cc</code> to install through Creative Cloud instead, or load <code>plugin\\manifest.json</code> with UXP Developer Tool.</li>
<li>Panel says <i>Cannot reach 127.0.0.1:${bridgePort}</i>? Something else is using that port or the daemon is not running - re-run the installer.</li></ol></div></div>
<div id="docs" style="display:none"><h2>Active document</h2><div class="card"><div id="doc" class="mut"></div><div id="layers" style="margin-top:8px"></div>
<div style="margin-top:10px"><button id="pvb">Refresh preview</button></div><div id="pv"></div></div></div>
<h2>Connect an AI app</h2><div class="card"><div class="mut">The installer already did this for Claude Desktop and Cursor. For other stdio clients use:</div>
<pre id="cfg" style="margin:8px 0">{ "mcpServers": { "photoshop-supreme": { "command": "node", "args": ["&lt;install dir&gt;\\\\server\\\\supreme.mjs"] } } }</pre>
<button id="cp">Copy</button>
<div class="mut" style="margin-top:10px">HTTP clients: POST http://127.0.0.1:${httpPort}/mcp with header <code>Authorization: Bearer &lt;token&gt;</code> (token file: <code>%USERPROFILE%\\.photoshop-supreme-mcp\\token</code>).</div></div>
<script>${js}</script></main></body></html>`;
}
