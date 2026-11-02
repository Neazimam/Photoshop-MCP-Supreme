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
`;

const BODY = `
<header><div><h1>Photoshop Supreme MCP <span class="mut sm" id="ver"></span></h1><div class="mut sm" id="sub"></div></div><div id="pills"></div></header>
<nav id="tabs"></nav>
<main>
<section id="t-overview">
  <div id="attn"></div>
  <div class="grid" id="cards"></div>
  <div class="two"><div class="card"><h3>Calls per minute (last 30 min)</h3><div id="chart"></div></div>
    <div class="card"><h3>Active document</h3><div id="doc" class="mut"></div><pre id="layers" hidden></pre><button id="pvb">Refresh preview</button><div id="pv"></div></div></div>
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
</main>`;

const JS = String.raw`
var T="__TOKEN__";var S=null,CFG=null;
var st={tab:'overview',open:{},client:'claude-desktop'};
var TABS=[['overview','Overview'],['calls','Calls'],['errors','Errors'],['connect','Connect AI apps'],['tools','Tools'],['diag','Diagnostics']];
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
function copyText(t,btn){function done(){btn.textContent='Copied';setTimeout(function(){btn.textContent='Copy'},1500)}function fb(){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(ta);done()}
 if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(done,fb);else fb()}

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

/* ---------- main loop ---------- */
function render(){if(!S)return;
 $('ver').textContent='v'+S.env.version;$('sub').textContent='Local control panel - daemon 127.0.0.1:'+S.env.httpPort+' - plugin bridge ws://127.0.0.1:'+S.env.bridgePort;
 put('pills',[el('span',{class:'pill'},[dot('ok'),'daemon running']),el('span',{class:'pill'},[dot(S.status.connected?'ok':''),S.status.connected?'Photoshop connected':'Photoshop offline']),el('span',{class:'pill',text:S.summary.total+' calls / '+S.summary.errors+' errors'})]);
 var f={overview:renderOverview,calls:renderCalls,errors:renderErrors,connect:renderConnect,tools:renderTools,diag:renderDiag}[st.tab];f(S)}
function poll(){api('/api/stats').then(function(s){if(s.ok){var first=!S;S=s;render();if(first)pollDoc()}}).catch(function(){put('pills',[el('span',{class:'pill'},[dot(''),'daemon unreachable'])])})}
$('pvb').onclick=function(){put('pv',['Rendering...']);api('/api/preview').then(function(r){if(!r.ok){put('pv',[el('div',{class:'attn warn'},[r.error||'error',r.hint?el('div',{class:'mut sm',text:r.hint}):null])]);return}var i=new Image();i.src='data:'+r.data.mimeType+';base64,'+r.data.data;put('pv',[i]);poll()})};
$('q').oninput=function(){if(S)renderCalls(S)};$('eo').onchange=function(){if(S)renderCalls(S)};$('cf').onchange=function(){if(S)renderCalls(S)};$('tq').oninput=function(){if(S)renderTools(S)};$('rev').onchange=function(){if(S)renderConnect(S)};
$('clr').onclick=function(){if(confirm('Clear the in-memory call history and statistics? (The audit log file is kept.)'))api('/api/clear').then(poll)};
$('dl').onclick=function(){if(!S)return;var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(S.calls,null,2)],{type:'application/json'}));a.download='photoshop-supreme-calls.json';document.body.appendChild(a);a.click();document.body.removeChild(a)};
$('st').onclick=runSelfTest;
buildTabs();showTab();api('/api/config').then(function(c){if(c.ok){CFG=c;render()}});poll();setInterval(poll,2000);pollDoc();setInterval(pollDoc,5000);
`;

export function dashboardHtml(token: string, httpPort: number, bridgePort: number): string {
  void httpPort;
  void bridgePort;
  const script = JS.replace('"__TOKEN__"', JSON.stringify(token));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photoshop Supreme MCP</title><style>${CSS}</style></head><body>${BODY}<script>${script}</script></body></html>`;
}
