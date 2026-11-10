const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e};
const fmt=n=>n===null||n===undefined?'–':Number(n).toLocaleString('en-US',{maximumFractionDigits:5});
const ago=s=>s<60?s+'s':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d';
function lv(label,val,cls){const d=el('div',cls);d.append(el('small','',label),el('span','',fmt(val)));return d}
function signalCard(s,now){
  const c=el('div','card'+(s.expired?' exp':''));const r=el('div','row');
  if(s.kind==='entry')r.append(el('span','badge '+s.side,s.side.toUpperCase()+' ENTRY'));
  else if(s.kind==='update')r.append(el('span','badge upd',(s.side||'').toUpperCase()+' · '+s.status));
  else r.append(el('span','badge unk','KHÔNG ĐỌC ĐƯỢC'));
  if(s.symbol)r.append(el('span','sym',s.symbol),el('span','tf',s.tf||''));
  if(s.src==='worker')r.append(el('span','src','qua Worker'));r.append(el('span','time','#'+s.id+' · '+ago(Math.max(0,now-s.received_at))+' trước'));c.append(r);
  if(s.kind==='entry'){const g=el('div','lv');g.append(lv('Entry',s.entry),lv('SL',s.sl,'sl'),lv('TP1 40%',s.tp1,'tp'),lv('TP2 80%',s.tp2,'tp'),lv('TP3 100%',s.tp3,'tp'));c.append(g);
    if(s.rr)c.append(el('div','del','R:R theo TP3 ≈ 1 : '+s.rr.toFixed(2)))}
  else if(s.kind==='update'){const g=el('div','lv');g.append(lv('Entry',s.entry),lv('SL',s.sl,'sl'),lv('TP',s.tp,'tp'));c.append(g)}
  else{c.append(el('div','del','Lý do: '+(s.note||'')));c.append(el('div','raw',s.raw))}
  if(s.kind!=='unknown'){const d=s.deliveries.length?'Terminal: '+s.deliveries.map(x=>x.tid+' → '+x.result).join(' · '):(s.expired?'Quá hạn, không giao cho EA':'Chưa terminal nào nhận');c.append(el('div','del',d))}
  return c}
function termCard(t,now){
  const c=el('div','card');const r=el('div','row');r.append(el('span','dot'+(t.online?' on':'')),el('b','',t.login?('#'+t.login):t.tid),el('span','tf',t.server||''),el('span','time',t.online?'online':'mất '+ago(now-t.last_seen)));c.append(r);
  const m=el('div','metrics');for(const [k,v] of [['Balance',t.balance],['Equity',t.equity],['Margin',t.margin],['Free margin',t.free_margin]]){const d=el('div');d.append(el('small','',k),el('span','',fmt(v)));m.append(d)}c.append(m);
  const P=t.positions||[];if(P.length){const tb=el('table');const h=el('tr');for(const x of ['Ticket','Symbol','Loại','Lot','Giá mở','SL','TP','P/L'])h.append(el('th','',x));tb.append(h);
    for(const p of P){const tr=el('tr');tr.append(el('td','',p.ticket),el('td','',p.symbol),el('td','pos-'+p.side,p.side),el('td','',fmt(p.volume)),el('td','',fmt(p.open)),el('td','',fmt(p.sl)),el('td','',fmt(p.tp)),el('td',p.profit>=0?'pos-buy':'pos-sell',fmt(p.profit)));tb.append(tr)}c.append(tb)}
  else c.append(el('div','del','Không có lệnh đang mở'));
  c.append(el('div','del','EA '+(t.ea_ver||'?')));return c}
const ago2=s=>s==null?'chưa':ago(s)+' trước';
async function poll(){
  try{
    const [r,i]=await Promise.all([fetch('/api/state',{cache:'no-store'}),fetch('/api/info',{cache:'no-store'})]);
    if(!r.ok)throw new Error('HTTP '+r.status);
    const d=await r.json(),info=i.ok?await i.json():null;
    $('conn').textContent='kết nối tốt';$('conn').className='pill ok';
    $('age').textContent='tín hiệu hết hạn sau '+d.maxAgeSec+'s';
    const W=$('worker');
    if(info&&info.worker){W.hidden=false;const ok=info.worker.lastPollAgoSec!==null&&!info.worker.error;
      W.textContent='Worker: '+(ok?'thông ('+ago2(info.worker.lastPollAgoSec)+')':(info.worker.error||'chưa thông'));W.className='pill '+(ok?'ok':'bad')}
    else W.hidden=true;
    const TP=$('tunnel');
    if(info&&info.tunnel){const t=info.tunnel;TP.hidden=false;
      TP.textContent=t.state==='ok'?'Tunnel: thông':t.state==='down'?'Tunnel: đã rớt, đang tạo lại':'Tunnel: đang tạo…';
      TP.className='pill '+(t.state==='ok'?'ok':t.state==='down'?'bad':'')}
    else TP.hidden=true;
    const S=$('signals');S.replaceChildren(...(d.signals.length?d.signals.map(s=>signalCard(s,d.now)):[el('div','empty','Chưa có tín hiệu nào. Hãy gắn webhook vào alert TradingView.')]));
    const T=$('terms');T.replaceChildren(...(d.terminals.length?d.terminals.map(t=>termCard(t,d.now)):[el('div','empty','Chưa có EA nào kết nối Gateway.')]));
    if(window.onData)window.onData(info,d);
  }catch{$('conn').textContent='mất kết nối';$('conn').className='pill bad'}}
setInterval(poll,2000);poll();
