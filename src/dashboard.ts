/**
 * Self-contained control panel served by the daemon at http://127.0.0.1:<port>/ . No external assets.
 * All dynamic text is inserted with textContent (never innerHTML) — layer names / error text from Photoshop are untrusted.
 */
const CSS = String.raw`
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--card:#f5f5f7;--line:#d2d2d7;--ok:#1a7f37;--bad:#c62828;--warn:#b26a00;--acc:#0a66c2;--code:#ececf0}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f5f5f7;--mut:#a1a1a6;--card:#222225;--line:#3a3a3e;--ok:#3fb950;--bad:#ff6b6b;--warn:#e3a03b;--acc:#4da3ff;--code:#2b2b2f}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:16px 20px 8px;max-width:1100px;margin:0 auto}
h1{font-size:20px;margin:0}h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 8px}
.mut{color:var(--mut)}.sm{font-size:12px}nav{display:flex;gap:4px;flex-wrap:wrap;padding:0 20px;max-width:1100px;margin:0 auto;border-bottom:1px solid var(--line)}
nav button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:8px 12px;color:var(--mut)}nav button.on{color:var(--fg);border-bottom-color:var(--acc)}
main{max-width:1100px;margin:0 auto;padding:16px 20px 60px}section[hidden]{display:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:12px}.grid .card{margin:0}
.big{font-size:22px;font-weight:600}.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.two .card{margin:0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--bad);margin-right:6px}.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin-left:6px;background:var(--card);font-size:12px}
button{font:inherit;padding:5px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}button:hover{border-color:var(--acc)}
input[type=text],select{font:inherit;padding:5px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--mut);font-weight:500}
tr.row{cursor:pointer}tr.row:hover{background:var(--code)}td.num,th.num{text-align:right;white-space:nowrap}
.badge{font-size:11px;border-radius:6px;padding:1px 6px;border:1px solid var(--line)}.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--bad);border-color:var(--bad)}.badge.warn{color:var(--warn);border-color:var(--warn)}
pre{margin:6px 0;padding:8px 10px;background:var(--code);border-radius:8px;white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,Consolas,monospace;max-height:340px;overflow:auto}
.attn{border-left:4px solid var(--ok);padding:8px 12px;margin:0 0 8px;background:var(--card);border-radius:6px}.attn.bad{border-color:var(--bad)}.attn.warn{border-color:var(--warn)}.attn.info{border-color:var(--acc)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 12px}.chips button.on{border-color:var(--acc);color:var(--acc)}
.tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.kv{display:grid;grid-template-columns:150px 1fr;gap:2px 12px}.kv div:nth-child(odd){color:var(--mut)}
img{max-width:100%;border-radius:8px;border:1px solid var(--line);margin-top:10px}#layers{max-height:240px;overflow:auto}
/* ---- convert tab + polish ---- */
button,select,input[type=text]{transition:border-color .15s,background .15s,color .15s,box-shadow .15s,transform .06s}
button:active{transform:translateY(1px)}
button:focus-visible,input[type=text]:focus-visible,select:focus-visible,.drop:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
section{animation:fadein .18s ease}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.btnp{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600;padding:6px 16px}
.btnp:hover{filter:brightness(1.1)}
.btnp[disabled]{opacity:.55;cursor:progress;filter:none}
.drop{border:2px dashed var(--line);border-radius:12px;padding:18px 14px;text-align:center;cursor:pointer;transition:border-color .18s,background .18s,transform .18s;background:var(--bg)}
.drop:hover{border-color:var(--acc)}
.drop.over{border-color:var(--acc);background:var(--code);transform:scale(1.008)}
.drop b{display:block;margin-bottom:2px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
.bar{height:4px;border-radius:4px;background:var(--code);overflow:hidden;margin-top:10px}
.bar>i{display:block;height:100%;width:30%;border-radius:4px;background:var(--acc);animation:slide 1.2s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
.chiprow{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.chip2{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;background:var(--bg)}
.chip2 b{font-size:13px}
.pvscale{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:10px;background:#fff;max-width:100%;box-shadow:0 4px 14px rgba(0,0,0,.08)}
.pvscale iframe{position:absolute;top:0;left:0;border:0;background:#fff}
textarea{font:12px/1.5 ui-monospace,Consolas,monospace;width:100%;min-height:130px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);padding:8px;resize:vertical}
textarea:focus{border-color:var(--acc)}
.hist{max-height:190px;overflow:auto;margin-top:10px}
.hist>div{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--line)}
.hist>div:last-child{border-bottom:0}
.hist .sm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:9}
.toast{background:var(--fg);color:var(--bg);border-radius:10px;padding:9px 14px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25);animation:fadein .2s ease}
.pulse{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.livebadge{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--ok);border:1px solid var(--ok);border-radius:999px;padding:1px 8px;vertical-align:1px}
.livebadge::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ok);animation:pulse 1.6s ease-in-out infinite}
.tree{max-height:300px;overflow:auto;font-size:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);padding:4px}
.tr-row{display:flex;align-items:center;gap:7px;padding:2px 4px;border-bottom:1px dashed var(--line)}
.tr-row:last-child{border-bottom:0}
.tr-kind{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;font-size:10px;font-weight:700;color:#fff;background:var(--mut);flex:none}
.tr-kind.k-text{background:#0a66c2}.tr-kind.k-shape{background:#1a7f37}.tr-kind.k-image{background:#b26a00}.tr-kind.k-group{background:#6b21a8}
.tr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46%}
.tr-geo{margin-left:auto;white-space:nowrap}
.swatch{display:inline-block;width:11px;height:11px;border-radius:3px;border:1px solid var(--line);vertical-align:-1px;margin:0 4px 0 8px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const BODY = `
<header><div><h1>Photoshop Supreme MCP <span class="mut sm" id="ver"></span></h1><div class="mut sm" id="sub"></div></div><div id="pills"></div></header>
<nav id="tabs"></nav>
<main>
<section id="t-overview">
  <div id="attn"></div>
  <div class="grid" id="cards"></div>
  <div class="two"><div class="card"><h3>Calls per minute (last 30 min)</h3><div id="chart"></div></div>
    <div class="card"><h3>Active document</h3><div id="doc" class="mut"></div><pre id="layers" hidden></pre><div class="tools"><button id="pvb">Refresh preview</button><span class="livebadge">LIVE · 1 s</span><span class="mut sm">auto-updates every second</span></div><div id="pv"></div>
      <div class="tools" style="margin-top:10px"><b class="sm">Dynamic control</b><button id="da-undo">Undo</button><button id="da-redo">Redo</button><button id="da-snap">Snapshot</button><button id="da-detect">Detect all</button></div>
      <div id="detect" class="mut sm">“Detect all” reads colors, fonts, history and document state straight from Photoshop.</div></div></div>
  <div class="two" style="margin-top:12px"><div class="card"><h3>Who is calling</h3><div id="byclient"></div></div>
    <div class="card"><h3>Busiest tools</h3><div id="bytool"></div></div></div>
</section>
<section id="t-calls" hidden>
  <div class="tools"><input type="text" id="q" placeholder="Filter tool / client / text..." size="28"><select id="cf"></select>
    <label><input type="checkbox" id="eo"> errors only</label><button id="dl">Download JSON</button><button id="clr">Clear history</button>
    <span class="mut sm" id="callnote"></span></div>
  <div class="card" style="padding:4px 8px"><table><thead><tr><th>Time</th><th>Client</th><th>Tool</th><th class="num">Duration</th><th>Result</th></tr></thead><tbody id="calls"></tbody></table></div>
</section>
<section id="t-errors" hidden><div id="errsum"></div><div id="errlist"></div></section>
<section id="t-convert" hidden>
  <div class="two">
    <div class="card">
      <h3>HTML → editable Photoshop layers</h3>
      <div class="mut sm">Text becomes editable text layers, boxes become shape layers, gradients and shadows become live layer effects, images are placed as smart objects. Local image paths resolve relative to the HTML file.</div>
      <div id="cvdrop" class="drop" tabindex="0" style="margin-top:10px">
        <b>Drop an .html file here</b>
        <span class="mut sm">or click to browse — or paste the source below</span>
      </div>
      <input type="file" id="cvfile" accept=".html,.htm,text/html" hidden>
      <textarea id="cvsrc" placeholder="Paste full HTML source here, or drop a file above… (Ctrl+Enter converts)" spellcheck="false" style="margin-top:10px"></textarea>
      <div class="tools" style="margin-top:10px">
        <select id="cvtarget"><option value="new">New document</option><option value="active">Into active document</option></select>
        <select id="cvpreset" title="Document size"><option value="">Fit to content</option><option value="sq">Square · 1080×1080</option><option value="story">Story · 1080×1920</option><option value="hd">Full HD · 1920×1080</option><option value="a4p">A4 portrait · 300 dpi</option><option value="a4l">A4 landscape · 300 dpi</option><option value="custom">Custom size…</option></select>
        <span id="cvcustom" hidden><input type="text" id="cvw" size="5" placeholder="w"> × <input type="text" id="cvh" size="5" placeholder="h"></span>
        <input type="text" id="cvscale" size="4" value="100" title="Scale in percent"><span class="mut sm">% scale</span>
      </div>
      <div class="tools">
        <input type="text" id="cvname" size="16" placeholder="Layer group name (optional)">
        <button id="cvgo" class="btnp">Convert to layers</button>
        <select id="cvsample"><option value="">Try a sample…</option><option value="biz">Business card</option><option value="social">Social post</option><option value="pricing">Pricing section</option></select>
      </div>
      <div id="cvnote" class="mut sm" style="margin-top:6px"></div>
      <div id="cvbar" class="bar" hidden><i></i></div>
      <div id="cvhist" class="hist"></div>
    </div>
    <div class="card">
      <h3>Live preview &amp; result</h3>
      <div id="cvsummary" class="mut sm">No conversion yet — the preview updates as you type.</div>
      <div id="cvwarn" style="margin-top:8px"></div>
      <div class="mut sm" style="margin-top:12px">HTML preview</div>
      <div id="cvlive" style="margin-top:6px"></div>
      <div class="mut sm" style="margin-top:12px">What will become layers:</div>
      <div id="cvtree" class="tree" style="margin-top:6px"><span class="mut sm">Paste or drop HTML — the layer plan builds itself here, live.</span></div>
      <div class="mut sm" style="margin-top:12px">Photoshop <span class="livebadge">LIVE · 1 s</span></div>
      <div id="cvps" style="margin-top:6px"></div>
    </div>
  </div>
</section>
<section id="t-connect" hidden>
  <div class="card"><h3>Detected AI apps</h3><div id="hosts"></div></div>
  <div class="card"><h3>Add Photoshop Supreme MCP to an AI app</h3>
    <div class="mut sm">Values below use the exact Node.js and server paths this daemon is running from.</div>
    <div class="chips" id="clients"></div><div id="cfg"></div>
    <label class="sm"><input type="checkbox" id="rev"> show real token in snippets (Copy always copies the real token)</label></div>
</section>
<section id="t-tools" hidden><div class="tools"><input type="text" id="tq" placeholder="Filter tools..." size="28"><span class="mut sm" id="toolnote"></span></div>
  <div class="card" style="padding:4px 8px"><table><thead><tr><th>Tool</th><th>What it does</th><th class="num">Calls</th><th class="num">Errors</th><th class="num">Avg</th></tr></thead><tbody id="toolrows"></tbody></table></div></section>
<section id="t-diag" hidden>
  <div class="card"><h3>Self-test</h3><div class="mut sm" style="margin-bottom:8px">Checks the whole chain: plugin link, speed, script permission, modal rights.</div><button id="st">Run self-test</button><div id="stout" style="margin-top:10px"></div></div>
  <div class="two"><div class="card"><h3>Environment</h3><div class="kv" id="env"></div></div>
    <div class="card"><h3>Plugin connection history</h3><div id="conn"></div></div></div>
</section>
</main>
<div id="toasts"></div>`;

const JS = String.raw`
var T="__TOKEN__";var S=null,CFG=null;
var st={tab:'overview',open:{},client:'claude-desktop'};
var TABS=[['overview','Overview'],['calls','Calls'],['errors','Errors'],['convert','Convert'],['connect','Connect AI apps'],['tools','Tools'],['diag','Diagnostics']];
function $(i){return document.getElementById(i)}
function el(tag,props,kids){var e=document.createElement(tag);if(props)for(var k in props){if(k==='class')e.className=props[k];else if(k==='text')e.textContent=props[k];else if(k.slice(0,2)==='on')e[k]=props[k];else e.setAttribute(k,props[k])}(kids||[]).forEach(function(c){if(c==null)return;e.appendChild(typeof c==='string'?document.createTextNode(c):c)});return e}
function put(id,kids){var n=$(id);while(n.firstChild)n.removeChild(n.firstChild);(kids||[]).forEach(function(k){if(k!=null)n.appendChild(typeof k==='string'?document.createTextNode(k):k)});return n}
function api(p,b){return fetch(p,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+T},body:JSON.stringify(b||{})}).then(function(r){return r.json()})}
function dur(ms){return ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s'}
function clock(ts){return new Date(ts).toLocaleTimeString()}
function ago(ts){if(!ts)return 'never';var s=Math.round((Date.now()-ts)/1000);if(s<5)return 'just now';if(s<60)return s+'s ago';if(s<3600)return Math.round(s/60)+' min ago';return Math.round(s/3600)+' h ago'}
function upt(ms){var s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m?m+'m '+(s%60)+'s':s+'s'}
function badge(t,c){return el('span',{class:'badge '+c,text:t})}
function dot(c){return el('span',{class:'dot '+(c||'')})}
function table(head,rows,numCols){return el('table',{},[el('thead',{},[el('tr',{},head.map(function(h,i){return el('th',{class:numCols&&numCols.indexOf(i)>=0?'num':'',text:h})}))]),el('tbody',{},rows.map(function(r){return el('tr',{},r.map(function(c,i){return el('td',{class:numCols&&numCols.indexOf(i)>=0?'num':''},[c])}))}))])}
function copyText(t,btn){function done(){btn.textContent='Copied';setTimeout(function(){btn.textContent='Copy'},1500);toast('Copied to clipboard')}function fb(){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(ta);done()}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(done,fb);else fb()}
function toast(msg){var box=$('toasts');if(!box)return;var t=el('div',{class:'toast',text:msg});box.appendChild(t);setTimeout(function(){t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t)},350)},2600)}

/* ---------- tabs ---------- */
function buildTabs(){put('tabs',TABS.map(function(t){return el('button',{class:t[0]===st.tab?'on':'',onclick:function(){st.tab=t[0];showTab()}},[t[1]])}))}
function showTab(){TABS.forEach(function(t){$('t-'+t[0]).hidden=t[0]!==st.tab});buildTabs();render()}

/* ---------- overview ---------- */
function attention(s){var a=[];
 if(!s.status.connected)a.push(['bad','Photoshop plugin is not connected.','Restart Photoshop once (the plugin loads at startup). Then open Diagnostics and run the self-test. Install log: %LOCALAPPDATA%\\PhotoshopSupremeMCP\\install.log']);
 s.hosts.forEach(function(h){if(h.state==='not-configured')a.push(['warn',h.name+' is installed but not set up for this MCP.','Re-run the installer, or use the Connect AI apps tab.']);
  if(h.state==='node-missing')a.push(['bad',h.name+' points to a Node.js that no longer exists.','Re-run the installer.']);
  if(h.state==='unreadable')a.push(['warn',h.name+' config file could not be read.','Check it is valid JSON: '+h.file])});
 var recent=s.errors.filter(function(e){return Date.now()-e.ts<600000});
 if(recent.length)a.push(['warn',recent.length+' failed call(s) in the last 10 minutes.','Open the Errors tab for causes and fixes.']);
 if(s.env.mode==='safe')a.push(['info','Safe mode is on.','Code-execution tools (ps_run_uxp, ps_inspect, ps_run_extendscript, saved scripts) are hidden.']);
 if(s.summary.total===0&&s.status.connected)a.push(['info','No AI app has called a tool yet.','Open your AI app and ask it to run ps_status.']);
 if(!a.length)a.push(['ok','Everything looks healthy.','']);
 return a}
function card(label,val,sub,color){return el('div',{class:'card'},[el('div',{class:'mut sm',text:label}),el('div',{class:'big',text:val,style:color?'color:var(--'+color+')':''}),sub?el('div',{class:'mut sm',text:sub}):null])}
function chart(series){var W=300,H=64,max=1;series.forEach(function(p){if(p.calls>max)max=p.calls});var ns='http://www.w3.org/2000/svg';var svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 '+W+' '+(H+14));svg.setAttribute('width','100%');
 series.forEach(function(p,i){var x=i*10+1,h=Math.round((p.calls-p.errors)/max*H),eh=Math.round(p.errors/max*H);
  function rect(y,hh,col){var r=document.createElementNS(ns,'rect');r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width',8);r.setAttribute('height',Math.max(hh,0));r.setAttribute('fill',col);r.setAttribute('rx',1);var t=document.createElementNS(ns,'title');t.textContent=new Date(p.t).toLocaleTimeString()+': '+p.calls+' call(s), '+p.errors+' error(s)';r.appendChild(t);svg.appendChild(r)}
  rect(H-h,h,'#0a66c2');rect(H-h-eh,eh,'#c62828');if(!p.calls)rect(H-1,1,'#8884')});
 var l=document.createElementNS(ns,'text');l.setAttribute('x',0);l.setAttribute('y',H+11);l.setAttribute('font-size',9);l.setAttribute('fill','#888');l.textContent='30 min ago';svg.appendChild(l);
 var r=document.createElementNS(ns,'text');r.setAttribute('x',W);r.setAttribute('y',H+11);r.setAttribute('font-size',9);r.setAttribute('fill','#888');r.setAttribute('text-anchor','end');r.textContent='now (peak '+max+'/min)';svg.appendChild(r);return svg}
function statTable(list,empty){if(!list.length)return el('div',{class:'mut',text:empty});return table(['Name','Calls','Errors','Avg','Last'],list.slice(0,8).map(function(x){return [x.name,String(x.calls),x.errors?badge(String(x.errors),'bad'):'0',dur(x.avgMs),ago(x.lastTs)]}),[1,2,3])}
function renderOverview(s){
 put('attn',attention(s).map(function(a){return el('div',{class:'attn '+a[0]},[el('b',{text:a[1]}),a[2]?el('div',{class:'mut sm',text:a[2]}):null])}));
 var p=s.status.pluginInfo||{},sm=s.summary,rate=sm.total?Math.round(sm.ok/sm.total*100)+'%':'-';
 put('cards',[card('Photoshop plugin',s.status.connected?'Connected':'Offline',s.status.connected?('Photoshop '+(p.photoshop||'?')+' / plugin v'+(p.plugin||'?')):'waiting for Photoshop',s.status.connected?'ok':'bad'),
  card('Total calls',String(sm.total),'last: '+ago(sm.lastTs)),card('Success rate',rate,sm.errors+' error(s)',sm.errors?'warn':null),
  card('Avg latency',dur(sm.avgMs),'p95 '+dur(sm.p95Ms)),card('Daemon uptime',upt(s.uptimeMs),'pid '+s.env.pid)]);
 put('chart',[chart(s.series)]);put('byclient',[statTable(s.byClient,'No callers yet.')]);put('bytool',[statTable(s.byTool,'No calls yet.')])}
function pollDoc(){if(!S||!S.status.connected){put('doc',['Plugin not connected.']);$('layers').hidden=true;return}
 api('/api/state').then(function(r){if(!r.ok){put('doc',[r.error||'error']);return}var d=r.data,doc=d.document;
  put('doc',[doc?(doc.title+' - '+doc.width+' x '+doc.height+' px, '+doc.mode+' ('+d.documents.length+' open)'):'No document open']);
  var out=[];(function walk(ls,dep){(ls||[]).forEach(function(l){out.push(new Array(dep+1).join('  ')+(l.layers?'[+] ':'- ')+l.name+'  (#'+l.id+', '+l.kind+(l.visible?'':', hidden')+')');if(l.layers)walk(l.layers,dep+1)})})(d.layers,0);
  $('layers').textContent=out.join('\n');$('layers').hidden=!doc}).catch(function(){})}

/* ---------- calls ---------- */
function renderCalls(s){
 var q=$('q').value.toLowerCase(),eo=$('eo').checked,cf=$('cf').value;
 var cl=$('cf');var names=s.byClient.map(function(c){return c.name});
 if(cl.options.length!==names.length+1||names.some(function(n,i){return cl.options[i+1].value!==n})){var cur=cl.value;put('cf',[el('option',{value:'',text:'all clients'})].concat(names.map(function(n){return el('option',{value:n,text:n})})));cl.value=cur}
 var rows=s.calls.filter(function(c){if(eo&&c.ok)return false;if(cf&&c.client!==cf)return false;if(q&&(c.tool+' '+c.client+' '+(c.args||'')+' '+(c.error||'')).toLowerCase().indexOf(q)<0)return false;return true});
 $('callnote').textContent='showing '+rows.length+' of last '+s.calls.length+' (full audit log on disk: '+s.env.auditLog+')';
 var body=[];
 rows.forEach(function(c){var open=!!st.open[c.id];
  body.push(el('tr',{class:'row',onclick:function(){st.open[c.id]=!st.open[c.id];renderCalls(S)}},[el('td',{text:clock(c.ts)}),el('td',{text:c.client}),el('td',{text:c.tool}),el('td',{class:'num',text:dur(c.ms)}),el('td',{},[c.ok?badge('ok','ok'):badge('error','bad')])]));
  if(open){var kv=[['Source',c.source],['When',new Date(c.ts).toLocaleString()],['Arguments',c.args||'-']];
   var box=el('div',{class:'kv'},[]);kv.forEach(function(x){box.appendChild(el('div',{text:x[0]}));box.appendChild(el('div',{text:x[1],style:'word-break:break-all'}))});
   var det=[box];if(c.error){det.push(el('pre',{text:c.error}))}if(c.hint){det.push(el('div',{class:'attn warn'},[el('b',{text:'Fix: '}),c.hint]))}if(c.detail){det.push(el('pre',{text:c.detail}))}
   body.push(el('tr',{},[el('td',{colspan:'5'},det)]))}});
 put('calls',body)}

/* ---------- errors ---------- */
function renderErrors(s){
 var groups={};s.errors.forEach(function(e){var k=e.tool+' - '+(e.error||'').slice(0,120);if(!groups[k])groups[k]={n:0,e:e};groups[k].n++});
 var list=Object.keys(groups).map(function(k){return groups[k]}).sort(function(a,b){return b.n-a.n});
 put('errsum',[el('div',{class:'card'},[el('h3',{text:'Most frequent recent errors'}),list.length?table(['Count','Tool','Message','How to fix'],list.slice(0,10).map(function(g){return [String(g.n),g.e.tool,g.e.error||'',g.e.hint||'']}),[0]):el('div',{class:'mut',text:'No errors recorded.'})])]);
 put('errlist',s.errors.slice(0,25).map(function(e){return el('div',{class:'card'},[el('div',{},[badge('error','bad'),' ',el('b',{text:e.tool}),el('span',{class:'mut sm',text:'  '+e.client+'  -  '+new Date(e.ts).toLocaleString()+'  -  '+dur(e.ms)})]),el('pre',{text:e.error||''}),e.hint?el('div',{class:'attn warn'},[el('b',{text:'Fix: '}),e.hint]):null,e.args?el('div',{class:'mut sm',text:'args: '+e.args}):null,e.detail?el('pre',{text:e.detail}):null])}))}

/* ---------- connect ---------- */
var HOSTSTATE={configured:['ok','configured'],'node-missing':['bad','Node.js path missing - re-run installer'],'not-configured':['warn','installed, not configured'],'not-installed':['','not installed'],unreadable:['warn','config unreadable']};
function renderConnect(s){
 put('hosts',s.hosts.map(function(h){var x=HOSTSTATE[h.state]||['',h.state];return el('div',{},[dot(x[0]==='ok'?'ok':x[0]==='warn'?'warn':''),el('b',{text:h.name+': '}),x[1],el('span',{class:'mut sm',text:'  '+h.file})])}));
 if(!CFG)return;
 put('clients',CFG.clients.map(function(c){return el('button',{class:c.id===st.client?'on':'',onclick:function(){st.client=c.id;renderConnect(S)}},[c.title])}));
 var c=CFG.clients.filter(function(x){return x.id===st.client})[0]||CFG.clients[0];var reveal=$('rev').checked;
 var shown=c.text.split('__TOKEN__').join(reveal?T:'<your-token>');var real=c.text.split('__TOKEN__').join(T);
 var btn=el('button',{text:'Copy'});btn.onclick=function(){copyText(real,btn)};
 put('cfg',[el('div',{},[el('b',{text:c.title}),el('span',{class:'mut sm',text:'  put it in: '+c.where})]),el('pre',{text:shown}),btn,c.note?el('div',{class:'mut sm',style:'margin-top:8px',text:c.note}):null])}

/* ---------- tools ---------- */
function renderTools(s){if(!CFG)return;var q=$('tq').value.toLowerCase();var by={};s.byTool.forEach(function(t){by[t.name]=t});
 var rows=CFG.tools.filter(function(t){return !q||(t.name+' '+t.description).toLowerCase().indexOf(q)>=0}).sort(function(a,b){return a.name<b.name?-1:1}).map(function(t){var x=by[t.name]||{calls:0,errors:0,avgMs:0};
  return [el('span',{},[el('b',{text:t.name}),t.full?el('span',{class:'badge warn',text:'runs code',style:'margin-left:6px'}):null]),el('span',{class:'sm mut',text:t.description.length>200?t.description.slice(0,200)+'...':t.description}),String(x.calls),x.errors?badge(String(x.errors),'bad'):'0',x.calls?dur(x.avgMs):'-']});
 $('toolnote').textContent=CFG.tools.length+' tools registered'+(s.env.mode==='safe'?' (safe mode: code-execution tools hidden)':'');
 var tb=$('toolrows');while(tb.firstChild)tb.removeChild(tb.firstChild);rows.forEach(function(r){tb.appendChild(el('tr',{},r.map(function(c,i){return el('td',{class:i>1?'num':''},[c])})))})}

/* ---------- diagnostics ---------- */
function renderDiag(s){var e=s.env;
 var rows=[['Server version',e.version],['Mode',e.mode],['Node.js',e.node+' ('+e.platform+')'],['Node path',e.nodePath],['Server script',e.script],['Dashboard / API','http://127.0.0.1:'+e.httpPort+'/'],['Plugin bridge','ws://127.0.0.1:'+e.bridgePort],['Data folder',e.dataDir],['Token file',e.tokenFile],['Audit log',e.auditLog]];
 var box=$('env');while(box.firstChild)box.removeChild(box.firstChild);rows.forEach(function(r){box.appendChild(el('div',{text:r[0]}));box.appendChild(el('div',{text:r[1],style:'word-break:break-all'}))});
 put('conn',s.conn.length?s.conn.map(function(c){return el('div',{},[dot(c.type==='connected'?'ok':''),clock(c.ts)+'  '+c.type,el('span',{class:'mut sm',text:c.detail?'  '+c.detail:''})])}):['No plugin connection events since the daemon started.'])}
function runSelfTest(){var b=$('st');b.disabled=true;b.textContent='Running...';put('stout',['']);
 api('/api/selftest').then(function(r){b.disabled=false;b.textContent='Run self-test';
  put('stout',(r.steps||[]).map(function(x){return el('div',{style:'margin-bottom:6px'},[x.ok?badge('PASS','ok'):badge('FAIL','bad'),' ',el('b',{text:x.name}),el('span',{class:'mut sm',text:'  '+dur(x.ms)}),x.detail?el('div',{class:'mut sm',text:x.detail}):null,x.error?el('pre',{text:x.error}):null,x.hint?el('div',{class:'attn warn'},[el('b',{text:'Fix: '}),x.hint]):null])}));poll()}).catch(function(){b.disabled=false;b.textContent='Run self-test';put('stout',['Daemon unreachable.'])})}

/* ---------- convert (HTML → layers) ---------- */
var CVP={a4p:[2480,3508],a4l:[3508,2480],sq:[1080,1080],story:[1080,1920],hd:[1920,1080]};
var cv={url:null,timer:null,deb:null,lastCanvas:null,rendered:null};
var cvHist=[];
try{cvHist=JSON.parse(localStorage.getItem('pss-history')||'[]')||[]}catch(e){cvHist=[]}
function fmtSize(n){return n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(2)+' MB'}
function cvSetNote(t){$('cvnote').textContent=t||''}
function cvPreset(){var v=$('cvpreset').value;if(v==='custom'){var w=parseInt($('cvw').value,10),h=parseInt($('cvh').value,10);return (w>=16&&h>=16&&w<=300000&&h<=300000)?{w:w,h:h}:null}return CVP[v]?{w:CVP[v][0],h:CVP[v][1]}:null}
function cvRenderHist(){
 if(!cvHist.length){put('cvhist',[]);return}
 var rows=cvHist.map(function(h,i){return el('div',{},[el('span',{class:'sm mut',text:h.n+' — '+h.layers+' layers — '+ago(h.t)}),el('button',{text:'Restore',onclick:function(){cvRestore(i)}})])});
 put('cvhist',[el('h3',{text:'Recent conversions'})].concat(rows))}
function cvRestore(i){
 var h=cvHist[i];if(!h)return;
 $('cvsrc').value=h.html;$('cvtarget').value=h.target;$('cvscale').value=h.scale;$('cvpreset').value=h.preset;
 $('cvcustom').hidden=h.preset!=='custom';$('cvw').value=h.w||'';$('cvh').value=h.h||'';
 cv.lastCanvas=null;cvSetNote('Restored "'+h.n+'" from history — check the preview, then Convert.');toast('Restored from history');cvDebounced()}
function cvRemember(d){
 var src=$('cvsrc').value;if(src.length>2000000)return;
 var f=$('cvfile').files&&$('cvfile').files[0];
 var e={n:f?f.name:'pasted snippet',t:Date.now(),html:src,target:$('cvtarget').value,scale:$('cvscale').value,preset:$('cvpreset').value,w:$('cvw').value||'',h:$('cvh').value||'',layers:d.created};
 cvHist.unshift(e);cvHist=cvHist.slice(0,8);
 try{localStorage.setItem('pss-history',JSON.stringify(cvHist))}catch(err){}
 cvRenderHist()}
function cvEstimate(){
 var p=cvPreset();if(p)return p;
 var src=$('cvsrc').value;var d={w:1440,h:900};
 var m=src.match(/body[^{]*\{[^}]*width\s*:\s*(\d+)px/);if(m)d.w=parseInt(m[1],10)||d.w;
 var h=src.match(/body[^{]*\{[^}]*height\s*:\s*(\d+)px/);if(h)d.h=parseInt(h[1],10)||d.h;
 return d}
function cvUpdatePreview(){
 cv.rendered=$('cvsrc').value;
 var box=$('cvlive');var src=$('cvsrc').value;
 if(!src.trim()){put('cvlive',[el('div',{class:'mut sm',text:'Load, drop or paste an HTML file to see a live preview here.'})]);return}
 var dims=cv.lastCanvas||cvEstimate();
 var wrapW=Math.max(box.clientWidth||460,220);
 var sc=Math.min(1,wrapW/dims.w);
 var holder=el('div',{class:'pvscale'});
 holder.style.width=Math.round(dims.w*sc)+'px';holder.style.height=Math.round(dims.h*sc)+'px';
 var frame=document.createElement('iframe');
 frame.setAttribute('sandbox','allow-scripts');
 frame.style.width=dims.w+'px';frame.style.height=dims.h+'px';
 frame.style.transform='scale('+sc+')';frame.style.transformOrigin='0 0';
 holder.appendChild(frame);put('cvlive',[holder]);
 if(cv.url){try{URL.revokeObjectURL(cv.url)}catch(e){}}
 cv.url=URL.createObjectURL(new Blob([src],{type:'text/html'}));
 frame.src=cv.url}
function cvDebounced(){if(cv.deb)clearTimeout(cv.deb);cv.deb=setTimeout(function(){cvUpdatePreview();cvAnalyze()},400)}
function cvLoadFile(f){
 if(!/\.html?$/i.test(f.name)&&f.type!=='text/html'){cvSetNote('That does not look like an HTML file: '+f.name);return}
 var rd=new FileReader();
 rd.onload=function(){$('cvsrc').value=String(rd.result);cv.lastCanvas=null;cvSetNote('Loaded '+f.name+' ('+fmtSize(f.size)+') — edit below if you like, then Convert.');cvDebounced()};
 rd.readAsText(f)}
/* ---------- layer blueprint — live plan of what Photoshop will build (parse-only, no PS call) ---------- */
var cvAna={src:null};
function cvAnalyze(){
 var src=$('cvsrc').value;
 if(!src.trim()){cvAna.src=null;put('cvtree',[el('span',{class:'mut sm',text:'Paste or drop HTML — the layer plan builds itself here, live.'})]);return}
 if(src.length>5000000){cvAna.src=null;put('cvtree',[el('span',{class:'mut sm',text:'Too large to plan live — it can still convert normally.'})]);return}
 if(src===cvAna.src)return;
 cvAna.src=src;
 var p=cvPreset();
 api('/api/analyze',{html:src,scale:(parseFloat($('cvscale').value)||100)/100,docW:p?p.w:undefined,docH:p?p.h:undefined}).then(function(r){
  if(src!==$('cvsrc').value)return;
  if(!r.ok){put('cvtree',[el('div',{class:'attn warn'},[el('b',{text:'Plan unavailable'}),el('div',{class:'sm mut',text:r.error||'error'})])]);return}
  var d=r.data,rows=[];
  (function walk(list,dep){(list||[]).forEach(function(nd){
   if(nd.k==='more'){rows.push(el('div',{class:'tr-row mut',text:'… more layers below',style:'padding-left:'+(dep*14+4)+'px'}));return}
   rows.push(el('div',{class:'tr-row'},[el('span',{class:'tr-kind k-'+nd.k,text:({text:'T',shape:'S',image:'I',group:'G'})[nd.k]||'?',style:'margin-left:'+(dep*14)+'px'}),el('span',{class:'tr-name',text:nd.n||nd.k}),el('span',{class:'tr-geo mut sm',text:nd.w+'×'+nd.h+' @ '+nd.x+','+nd.y})]));
   if(nd.c)walk(nd.c,dep+1)})})(d.tree);
  if(!rows.length)rows=[el('span',{class:'mut sm',text:'Nothing visible to convert on this page yet.'})];
  var head=el('div',{class:'mut sm',style:'margin:2px 4px 6px',text:d.canvas?('Canvas '+d.canvas.w+'×'+d.canvas.h+' px — '+d.stats.nodes+' element(s), '+d.stats.images+' image(s)'):''});
  put('cvtree',[head].concat(rows));
  if(d.warnings&&d.warnings.length)put('cvwarn',d.warnings.map(function(w){return el('div',{class:'attn warn'},[el('span',{text:w})])}));
 }).catch(function(){})}
function cvResult(r,ms){
 if(!r.ok){
  var parts=[el('b',{text:'Conversion failed'}),el('div',{class:'mut sm',text:r.error||'error'})];
  if(r.hint)parts.push(el('div',{class:'mut sm',text:'Fix: '+r.hint}));
  if(r.serverVersion===undefined)parts.push(el('div',{class:'attn warn',style:'margin-top:8px',text:'This reply came from an older daemon build (pre-0.5). Restart Photoshop Supreme — or re-run the installer — so the improved converter is loaded, then try again.'}));
  put('cvsummary',[el('div',{class:'attn bad'},parts)]);return}
 var d=r.data;
 var chips=[['layers',d.created],['text',d.texts],['shapes',d.shapes],['images',d.images],['groups',d.groups]].map(function(c){return el('span',{class:'chip2'},[el('b',{text:String(c[1])}),c[0]])});
 put('cvsummary',[el('div',{},[el('b',{text:d.created+' layers created'}),el('span',{class:'mut sm',text:'  in '+dur(ms)})]),el('div',{class:'chiprow'},chips),el('div',{class:'mut sm',text:'Document #'+(d.document_id||'?')+' — canvas '+d.canvas.w+'×'+d.canvas.h+' px ('+d.stats.nodes+' elements)'})]);
 var notes=[];
 if(d.fonts&&d.fonts.length){var seen={};var rows=[];d.fonts.forEach(function(x){var k=x.requested+'|'+x.used;if(seen[k])return;seen[k]=1;rows.push(x)});
  notes.push(el('div',{class:'attn info'},[el('b',{text:'Fonts used'}),el('div',{class:'sm'},rows.map(function(x){return el('div',{text:'"'+x.requested+'" → '+x.used})}))]))}
 (d.warnings||[]).forEach(function(w){notes.push(el('div',{class:'attn warn'},[el('span',{text:w})]))});
 put('cvwarn',notes);
 cv.lastCanvas=d.canvas;cvUpdatePreview();
 put('cvps',[el('div',{class:'mut sm',text:'Rendering Photoshop preview...'})]);
 api('/api/preview').then(function(pr){
  if(pr.ok){var i=new Image();i.src='data:'+pr.data.mimeType+';base64,'+pr.data.data;put('cvps',[i])}
  else put('cvps',[el('div',{class:'mut sm',text:'Preview unavailable: '+(pr.error||'?')})]);
 }).catch(function(){put('cvps',[])});
 cvRemember(d);toast(d.created+' layers created in Photoshop');pollDoc();poll()}
/* ---------- live Photoshop preview — auto-refreshes every 1 s (the Refresh button stays for a manual nudge) ---------- */
var live={busy:false,last:null,note:''};
function setPreviewImg(boxId,src){
 var box=$(boxId);if(!box)return;
 var img=box.querySelector('img');
 if(!img){put(boxId,[]);img=document.createElement('img');img.alt='Photoshop preview';box.appendChild(img)}
 img.src=src}
function liveFetch(){
 if(live.busy||document.hidden)return;
 if(!S||!S.status.connected)return;
 if(st.tab!=='overview'&&st.tab!=='convert')return;
 live.busy=true;
 api('/api/preview').then(function(r){
  live.busy=false;
  if(r.ok&&r.data&&r.data.data){
   live.note='';
   var src='data:'+r.data.mimeType+';base64,'+r.data.data;
   if(src!==live.last){live.last=src;setPreviewImg(st.tab==='overview'?'pv':'cvps',src)}
  }else{
   var msg=(r.error||'Preview unavailable')+(r.hint?' — '+r.hint:'');
   if(msg!==live.note){live.note=msg;live.last=null;if(st.tab==='overview')put('pv',[el('div',{class:'mut sm',text:msg})])}
  }
 }).catch(function(){live.busy=false})}
function liveLoop(){setTimeout(function(){liveFetch();liveLoop()},1000)}
function runConvert(){
 var src=$('cvsrc').value;
 if(!src.trim()){cvSetNote('Load, drop or paste an HTML file first.');return}
 if(src.length>25000000){cvSetNote('HTML is '+fmtSize(src.length)+' — the hard limit is 25.0 MB. Export big embedded images as separate files and link them instead.');return}
 var p=cvPreset();
 if($('cvpreset').value==='custom'&&!p){cvSetNote('Enter a custom canvas size (min 16×16 px).');return}
 var b=$('cvgo');b.disabled=true;
 var t0=Date.now();
 cv.timer=setInterval(function(){var s=((Date.now()-t0)/1000).toFixed(1);cvSetNote('Converting — '+s+' s elapsed. Photoshop is building the layers...')},150);
 $('cvbar').hidden=false;
 put('cvsummary',[el('div',{},[el('span',{class:'spin'}),el('span',{text:'Converting '+fmtSize(src.length)+' of HTML into layers...'})])]);
 put('cvwarn',[]);put('cvps',[]);
 var f=$('cvfile').files&&$('cvfile').files[0];
 api('/api/convert',{html:src,filename:f?f.name:'pasted.html',target:$('cvtarget').value,scale:(parseFloat($('cvscale').value)||100)/100,name:$('cvname').value,docW:p?p.w:undefined,docH:p?p.h:undefined}).then(function(r){
  b.disabled=false;if(cv.timer){clearInterval(cv.timer);cv.timer=null}
  $('cvbar').hidden=true;cvSetNote('');
  cvResult(r,Date.now()-t0);
 }).catch(function(e){b.disabled=false;if(cv.timer){clearInterval(cv.timer);cv.timer=null}$('cvbar').hidden=true;cvSetNote('Conversion request failed: '+e);put('cvsummary',[el('div',{class:'attn bad',text:'The daemon did not answer. Is it still running?'})])})}
function renderConvert(){cvRenderHist();if(cv.rendered!==$('cvsrc').value)cvUpdatePreview();cvAnalyze()}
(function(){
 var dz=$('cvdrop');
 dz.onclick=function(){$('cvfile').click()};
 dz.ondragover=function(e){e.preventDefault();dz.className='drop over'};
 dz.ondragleave=function(){dz.className='drop'};
 dz.ondrop=function(e){e.preventDefault();dz.className='drop';var f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];if(f)cvLoadFile(f)};
 dz.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();$('cvfile').click()}};
 $('cvfile').onchange=function(){var f=this.files&&this.files[0];if(f)cvLoadFile(f)};
 $('cvsrc').oninput=cvDebounced;
 $('cvpreset').onchange=function(){$('cvcustom').hidden=this.value!=='custom';cvDebounced()};
 $('cvw').oninput=cvDebounced;$('cvh').oninput=cvDebounced;
 var SAMPLES={
  biz:['<!doctype html><html><head><style>',
   '*{margin:0;box-sizing:border-box}',
   'body{width:1050px;height:600px;background:#0f172a;font-family:Georgia,Times New Roman,serif}',
   '.card{position:relative;width:850px;height:450px;left:100px;top:75px;background:linear-gradient(135deg,#1e293b 0%,#0f172a 60%,#1e3a5f 100%);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,0.55)}',
   '.bar{position:absolute;left:0;top:0;width:12px;height:450px;background:linear-gradient(180deg,#38bdf8,#0ea5e9)}',
   '.name{position:absolute;left:70px;top:120px;font-size:44px;color:#f8fafc;letter-spacing:1px}',
   '.role{position:absolute;left:70px;top:185px;font-size:20px;color:#7dd3fc;letter-spacing:4px}',
   '.line{position:absolute;left:70px;top:250px;width:340px;height:2px;background:#334155}',
   '.contact{position:absolute;left:70px;top:290px;font-size:18px;color:#cbd5e1;line-height:1.9}',
   '.mono{position:absolute;right:70px;bottom:60px;font-size:64px;color:#38bdf8;font-weight:700}',
   '</style></head><body><div class="card">',
   '<div class="bar"></div>',
   '<div class="name">Alexandra Reyes</div>',
   '<div class="role">ART DIRECTOR</div>',
   '<div class="line"></div>',
   '<div class="contact">alex@studio-nord.co<br>+1 415 220 8834<br>studio-nord.co</div>',
   '<div class="mono">N.</div>',
   '</div></body></html>'].join('\n'),
  social:['<!doctype html><html><head><style>',
   '*{margin:0;box-sizing:border-box}',
   'body{width:1080px;height:1350px;background:linear-gradient(160deg,#7c3aed 0%,#db2777 100%);font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center}',
   '.quote{width:820px;text-align:center}',
   '.mark{font-size:150px;color:rgba(255,255,255,0.45);line-height:0.6;font-weight:700}',
   '.q{font-size:64px;color:#ffffff;font-weight:700;line-height:1.25;margin-top:40px}',
   '.who{margin-top:60px;font-size:28px;color:#fbcfe8;letter-spacing:6px}',
   '.badge{display:inline-block;margin-top:40px;padding:18px 44px;background:#ffffff;color:#7c3aed;border-radius:999px;font-size:24px;font-weight:700;box-shadow:0 16px 40px rgba(0,0,0,0.35)}',
   '</style></head><body><div class="quote">',
   '<div class="mark">"</div>',
   '<div class="q">Design is intelligence made visible.</div>',
   '<div class="who">- ALINA WRIGHT</div>',
   '<div class="badge">Follow for more</div>',
   '</div></body></html>'].join('\n'),
  pricing:['<!doctype html><html><head><style>',
   '*{margin:0;box-sizing:border-box}',
   'body{width:1200px;height:800px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;display:flex;gap:40px;align-items:center;justify-content:center}',
   '.plan{width:320px;background:#ffffff;border-radius:16px;padding:36px;box-shadow:0 12px 36px rgba(15,23,42,0.12)}',
   '.plan.hero{background:#0f172a}',
   '.tier{font-size:18px;color:#64748b;letter-spacing:3px}',
   '.plan.hero .tier{color:#94a3b8}',
   '.price{font-size:52px;font-weight:800;color:#0f172a;margin-top:14px}',
   '.plan.hero .price{color:#f8fafc}',
   '.feat{margin-top:22px;font-size:17px;color:#475569;line-height:2}',
   '.plan.hero .feat{color:#cbd5e1}',
   '.buy{margin-top:28px;padding:14px 0;text-align:center;background:#2563eb;color:#ffffff;border-radius:10px;font-weight:700;font-size:18px}',
   '.plan.hero .buy{background:#22d3ee;color:#062a31}',
   '</style></head><body>',
   '<div class="plan"><div class="tier">STARTER</div><div class="price">$9</div><div class="feat">1 project<br>Email support<br>Basic exports</div><div class="buy">Choose Starter</div></div>',
   '<div class="plan hero"><div class="tier">PRO</div><div class="price">$29</div><div class="feat">Unlimited projects<br>Priority support<br>Layer-level exports</div><div class="buy">Choose Pro</div></div>',
   '</body></html>'].join('\n')};
 $('cvsample').onchange=function(){var k=this.value;if(!k||!SAMPLES[k])return;$('cvsrc').value=SAMPLES[k];cv.lastCanvas=null;cvSetNote('Sample loaded — tweak anything you like, then Convert.');this.selectedIndex=0;cvDebounced()};
})();

/* ---------- main loop ---------- */
function render(){if(!S)return;
 $('ver').textContent='v'+S.env.version;$('sub').textContent='Local control panel - daemon 127.0.0.1:'+S.env.httpPort+' - plugin bridge ws://127.0.0.1:'+S.env.bridgePort;
 put('pills',[el('span',{class:'pill'},[dot('ok'),'daemon running']),el('span',{class:'pill'},[dot(S.status.connected?'ok':''),S.status.connected?'Photoshop connected':'Photoshop offline']),el('span',{class:'pill',text:S.summary.total+' calls / '+S.summary.errors+' errors'})]);
 var f={overview:renderOverview,calls:renderCalls,errors:renderErrors,convert:renderConvert,connect:renderConnect,tools:renderTools,diag:renderDiag}[st.tab];f(S)}
function poll(){api('/api/stats').then(function(s){if(s.ok){var first=!S;S=s;render();if(first)pollDoc()}}).catch(function(){put('pills',[el('span',{class:'pill'},[dot(''),'daemon unreachable'])])})}
$('pvb').onclick=function(){live.last=null;liveFetch()};
/* ---------- dynamic control: one-click Photoshop actions from the dashboard ---------- */
function rpc(action,params){return api('/rpc',{action:action,params:params||{}}).then(function(r){if(!r.ok)throw new Error(r.error||'call failed');return r.data})}
function daRun(btn,fn){var t=btn.textContent;btn.disabled=true;fn().then(function(){pollDoc();poll()}).catch(function(e){toast('Failed: '+(e.message||e))}).then(function(){btn.disabled=false;btn.textContent=t})}
$('da-undo').onclick=function(){daRun(this,function(){return rpc('run_js',{code:"await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'historyState', _enum: 'ordinal', _value: 'previous' }], _options: { dialogOptions: 'dontDisplay' } }], {});return 'ok';",single_history:false,name:'Dashboard: undo'}).then(function(){toast('Undone')})})};
$('da-redo').onclick=function(){daRun(this,function(){return rpc('run_js',{code:"await ctx.batchPlay([{ _obj: 'select', _target: [{ _ref: 'historyState', _enum: 'ordinal', _value: 'next' }], _options: { dialogOptions: 'dontDisplay' } }], {});return 'ok';",single_history:false,name:'Dashboard: redo'}).then(function(){toast('Redone')})})};
$('da-snap').onclick=function(){daRun(this,function(){return rpc('run_js',{code:"await ctx.batchPlay([{ _obj: 'make', _target: [{ _ref: 'snapshotClass' }], from: { _ref: 'historyState', _property: 'currentHistoryState' }, name: 'Dashboard snapshot ' + new Date().toLocaleTimeString(), using: { _enum: 'historyState', _value: 'fullDocument' }, _options: { dialogOptions: 'dontDisplay' } }], {});return 'ok';",single_history:false,name:'Dashboard: snapshot'}).then(function(){toast('Snapshot saved')})})};
$('da-detect').onclick=function(){var btn=this;btn.disabled=true;var box=$('detect');box.textContent='Detecting…';
 Promise.all([rpc('colors'),api('/api/state'),rpc('fonts'),rpc('history')]).then(function(rs){
  var col=rs[0],st=rs[1],f=rs[2],h=rs[3];
  if(!st.ok)throw new Error(st.error||'state unavailable');
  var kids=[];
  var crow=el('div',{},[el('b',{text:'Colors'})]);
  function sw(hex,label){return el('span',{},[el('span',{class:'swatch',style:'background:'+(hex||'#888'),text:''}),label])}
  crow.appendChild(col.foreground?sw(col.foreground.hex,'fg '+col.foreground.hex):el('span',{text:'fg ?'}));
  crow.appendChild(col.background?sw(col.background.hex,'bg '+col.background.hex):el('span',{text:'bg ?'}));
  kids.push(crow);
  kids.push(el('div',{text:(st.data.document?(st.data.document.title+' — '+st.data.document.width+'×'+st.data.document.height+' px'):'No document open')+' · '+f.count+' fonts installed · '+h.count+' history states'+(h.active?' (active: '+h.active+')':'')}));
  var fams=(f.families||[]).slice(0,18).join(', ');
  if(fams)kids.push(el('div',{class:'sm',text:'Fonts: '+fams+(f.count>18?' …':'')}));
  put('detect',kids);
 }).catch(function(e){box.textContent='Detect failed: '+(e.message||e)}).then(function(){btn.disabled=false})};
$('q').oninput=function(){if(S)renderCalls(S)};$('eo').onchange=function(){if(S)renderCalls(S)};$('cf').onchange=function(){if(S)renderCalls(S)};$('tq').oninput=function(){if(S)renderTools(S)};$('rev').onchange=function(){if(S)renderConnect(S)};
$('clr').onclick=function(){if(confirm('Clear the in-memory call history and statistics? (The audit log file is kept.)'))api('/api/clear').then(poll)};
$('dl').onclick=function(){if(!S)return;var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(S.calls,null,2)],{type:'application/json'}));a.download='photoshop-supreme-calls.json';document.body.appendChild(a);a.click();document.body.removeChild(a)};
$('st').onclick=runSelfTest;
$('cvgo').onclick=runConvert;
$('cvsrc').onkeydown=function(e){if((e.ctrlKey||e.metaKey)&&(e.key==='Enter'||e.keyCode===13)){e.preventDefault();runConvert()}};
buildTabs();showTab();api('/api/config').then(function(c){if(c.ok){CFG=c;render()}});poll();setInterval(poll,2000);pollDoc();setInterval(pollDoc,5000);liveLoop();
`;

export function dashboardHtml(token: string, httpPort: number, bridgePort: number): string {
  void httpPort;
  void bridgePort;
  const script = JS.replace('"__TOKEN__"', JSON.stringify(token));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photoshop Supreme MCP</title><style>${CSS}</style></head><body>${BODY}<script>${script}</script></body></html>`;
}
