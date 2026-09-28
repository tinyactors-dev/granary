/** The small interactive page at `GET /` (ADR 0138). Plain HTML + fetch, no framework. */
export function controlPage(base: string, exe: { tokenPort: number | null; peerPort: number | null }): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fake-infra</title>
<style>
:root{color-scheme:light dark;--fg:#18181b;--muted:#71717a;--bg:#fff;--card:#f4f4f5;--line:#e4e4e7;--accent:#2563eb;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--fg:#fafafa;--muted:#a1a1aa;--bg:#09090b;--card:#18181b;--line:#27272a;--accent:#60a5fa;--bad:#f87171}}
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:var(--bg);color:var(--fg);max-width:1200px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px}p.m{color:var(--muted);margin:0 0 16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
input,select,button{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
form{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:3px 4px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-all}
code{font:12px ui-monospace,monospace}.bad{color:var(--bad)}pre{white-space:pre-wrap;font-size:12px;margin:4px 0}
</style></head><body>
<h1>fake-infra</h1>
<p class="m">R2-compatible S3 at <code>${base}/s3</code> (EU: <code>${base}/s3/eu</code>), OTLP at <code>${base}/otlp/v1/…</code>,
exe.dev proxy token front <code>:${exe.tokenPort ?? 'off'}</code>, peer front <code>:${exe.peerPort ?? 'off'}</code>. <button id="reset">Reset everything</button></p>
<div class="grid">
<section><h2>Buckets</h2>
<form id="bucket"><input name="name" placeholder="granary-backups" required pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]">
<select name="jurisdiction"><option>eu</option><option>default</option><option>fedramp</option></select>
<input name="quotaBytes" type="number" min="0" placeholder="quota bytes"><button class="primary">Create</button></form>
<div id="buckets"></div></section>
<section><h2>Credentials</h2>
<form id="cred"><select name="kind"><option value="s3">S3 key</option><option value="exe-vm-token">exe VM token</option><option value="otlp-bearer">OTLP bearer</option></select>
<select name="scope"><option>object-rw</option><option>object-ro</option><option>admin</option></select>
<input name="buckets" placeholder="bucket(s), comma-separated"><button class="primary">Issue</button></form>
<pre id="issued"></pre><div id="creds"></div></section>
<section><h2>Faults</h2>
<form id="fault"><select name="target"><option>s3</option><option>otlp</option><option>exe-proxy</option></select>
<select name="method"><option>*</option><option>PUT</option><option>GET</option><option>POST</option><option>DELETE</option><option>HEAD</option></select>
<input name="pathPattern" value="." size="10"><input name="status" type="number" placeholder="status" value="503" style="width:70px">
<input name="s3Code" placeholder="S3 code" size="10"><input name="count" type="number" value="1" min="1" style="width:60px">
<input name="retryAfterSec" type="number" placeholder="Retry-After" style="width:90px"><input name="latencyMs" type="number" placeholder="latency ms" style="width:90px">
<label><input type="checkbox" name="dropConnection">drop</label><label><input type="checkbox" name="corruptBody">corrupt</label>
<button class="primary">Inject</button> <button type="button" id="clearFaults">Clear all</button></form>
<div id="faults"></div></section>
<section><h2>Fidelity &amp; clock</h2><div id="fidelity"></div>
<form id="clock">Clock skew <input name="skewMs" type="number" value="0" style="width:120px"> ms <button>Set</button></form></section>
<section style="grid-column:1/-1"><h2>OTLP batches</h2><div id="otlp"></div></section>
<section style="grid-column:1/-1"><h2>Requests</h2><div id="requests"></div></section>
</div>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function call(method,path,body){const r=await fetch(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}if(!r.ok)alert(method+' '+path+' → '+r.status+'\\n'+t);return j}
const table=(rows,cols)=>rows.length?'<table><tr>'+cols.map(c=>'<th>'+c[0]+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+c[1](r)+'</td>').join('')+'</tr>').join('')+'</table>':'<p class="m">None.</p>';
const t=ms=>new Date(ms).toLocaleTimeString();
async function refresh(){const s=await call('GET','/__control/state');if(!s)return;
$('#buckets').innerHTML=s.buckets.map(b=>'<p><b>'+esc(b.name)+'</b> ('+b.jurisdiction+') '+b.objects.length+' objects, '+b.usedBytes+' B'+(b.quotaBytes!=null?' / quota '+b.quotaBytes:'')+(b.multipartUploads.length?', '+b.multipartUploads.length+' open uploads':'')+' <button data-del="'+esc(b.name)+'">delete</button></p>'+table(b.objects.slice(0,50),[['key',o=>'<code>'+esc(o.key)+'</code>'],['size',o=>o.size],['modified',o=>t(o.lastModified)]])).join('')||'<p class="m">No buckets.</p>';
$('#creds').innerHTML=table(s.credentials,[['id',c=>'<code>'+esc(c.id)+'</code>'],['kind',c=>c.kind],['scope',c=>esc(c.scope??'')],['label',c=>esc(c.label??'')],['',c=>c.revoked?'<span class="bad">revoked</span>':'<button data-revoke="'+esc(c.id)+'">revoke</button>']]);
$('#faults').innerHTML=table(s.faults,[['target',f=>f.target],['match',f=>(f.method??'*')+' <code>'+esc(f.pathPattern)+'</code>'],['effect',f=>[f.status,f.s3Code,f.latencyMs&&f.latencyMs+'ms',f.dropConnection&&'drop',f.corruptBody&&'corrupt'].filter(Boolean).join(' ')],['left',f=>f.remaining+'/'+f.count]]);
$('#fidelity').innerHTML=Object.entries(s.fidelity).map(([k,v])=>'<label style="display:block"><input type="checkbox" data-fid="'+k+'"'+(v?' checked':'')+'> '+k+'</label>').join('');
$('#clock [name=skewMs]').value=s.clockSkewMs;
$('#otlp').innerHTML=table(s.otlp.slice(-30).reverse(),[['at',b=>t(b.at)],['signal',b=>b.signal],['via',b=>b.via],['service',b=>esc(b.service??'')],['bytes',b=>b.bytes],['summary',b=>esc(b.summary.slice(0,5).join(', '))]]);
$('#requests').innerHTML=table(s.requests.slice(-40).reverse(),[['at',r=>t(r.at)],['surface',r=>r.surface],['request',r=>r.method+' <code>'+esc(r.path)+'</code>'],['status',r=>r.status>=400?'<span class="bad">'+r.status+'</span>':r.status],['bytes in',r=>r.bytesIn],['fault',r=>esc(r.faultId??'')]]);}
const form=f=>Object.fromEntries(new FormData(f));
$('#bucket').onsubmit=async e=>{e.preventDefault();const v=form(e.target);await call('POST','/__control/buckets',{name:v.name,jurisdiction:v.jurisdiction,...(v.quotaBytes?{quotaBytes:+v.quotaBytes}:{})});refresh()};
$('#cred').onsubmit=async e=>{e.preventDefault();const v=form(e.target);const body=v.kind==='s3'?{kind:'s3',scope:v.scope,buckets:v.buckets.split(',').map(s=>s.trim()).filter(Boolean)}:{kind:v.kind,label:v.buckets||v.kind};const r=await call('POST','/__control/credentials',body);if(r)$('#issued').textContent=JSON.stringify(r,null,2);refresh()};
$('#fault').onsubmit=async e=>{e.preventDefault();const f=e.target;const v=form(f);const b={target:v.target,method:v.method,pathPattern:v.pathPattern,count:+v.count};for(const k of['status','retryAfterSec','latencyMs'])if(v[k])b[k]=+v[k];if(v.s3Code)b.s3Code=v.s3Code;if(f.dropConnection.checked)b.dropConnection=true;if(f.corruptBody.checked)b.corruptBody=true;await call('POST','/__control/faults',b);refresh()};
$('#clearFaults').onclick=async()=>{await call('DELETE','/__control/faults');refresh()};
$('#clock').onsubmit=async e=>{e.preventDefault();await call('PUT','/__control/clock',{skewMs:+form(e.target).skewMs});refresh()};
$('#reset').onclick=async()=>{if(confirm('Reset all fake-infra state?')){await call('POST','/__control/reset');refresh()}};
document.body.addEventListener('click',async e=>{const d=e.target.dataset;if(d.del){await call('DELETE','/__control/buckets/'+encodeURIComponent(d.del));refresh()}if(d.revoke){await call('DELETE','/__control/credentials/'+encodeURIComponent(d.revoke));refresh()}});
document.body.addEventListener('change',async e=>{const k=e.target.dataset?.fid;if(k){await call('PUT','/__control/fidelity',{[k]:e.target.checked});refresh()}});
refresh();const es=new EventSource('/__control/events');let pending=false;es.onmessage=()=>{if(pending)return;pending=true;setTimeout(()=>{pending=false;refresh()},500)};
</script></body></html>`;
}
