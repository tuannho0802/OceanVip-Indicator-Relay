// Trang Cài đặt (#setup). Chỉ hiện khi xem từ chính VPS (server báo info.local); người xem từ xa không thấy nút này.
// Mọi chữ hiện ra đều đi qua textContent (không innerHTML) nên dữ liệu lạ không thể chèn HTML.
(function(){
  const HDR={'content-type':'application/json','x-ocean-setup':'1'};
  // Tự chứa helper (không dựa vào app.js) để thứ tự nạp tệp không ảnh hưởng.
  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e};
  const ago=s=>s<60?s+'s':s<3600?Math.floor(s/60)+'m':s<86400?Math.floor(s/3600)+'h':Math.floor(s/86400)+'d';
  let info=null,live=null,loaded=false,autoOpened=false,saving=false,gwPort=null;

  // Lệnh cho MT4 (chuyển cổng 80 -> cổng Gateway): số cổng cuối lệnh luôn theo cổng Gateway đang dùng.
  function mt4Ports(port){
    $('mt4Cmd').textContent='netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=80 connectaddress=127.0.0.1 connectport='+port;
    $('mt4Row').textContent='127.0.0.1  80  127.0.0.1  '+port;
  }

  const isSetup=()=>location.hash==='#setup'&&!!info&&info.local===true;

  function route(){
    const on=isSetup();
    $('app').hidden=on;$('setupView').hidden=!on;
    $('banner').hidden=on||!(info&&info.local&&info.needsSetup);
    if(on&&!loaded)load();
    if(on)renderChecks();
  }

  function msg(kind,text){const m=$('setupMsg');m.textContent=text;m.className='msg'+(text?' '+kind:'')}

  function fill(v){
    $('codeCurrent').textContent=v.connected
      ?'Đang dùng: Server ID "'+v.serverId+'"'+(v.workerUrl?' · Worker '+v.workerUrl.replace(/^https:\/\//,''):'')+(v.source==='env'?' (đặt trong server.env)':'')
      :'Chưa kết nối. Dán mã của bạn vào ô bên dưới.';
    $('btnDisc').hidden=!v.connected;
    $('fCode').value='';
    $('fAccounts').value=(v.accounts||[]).join(', ');
    $('fMap').value=v.symbolMap?Object.entries(v.symbolMap).map(([a,b])=>a+'='+b).join(', '):'';
    $('fTfs').value=v.tfs?(v.tfs.length?v.tfs.join(','):'ALL'):'';
    // Cổng Gateway: để trống = mặc định. Địa chỉ cần thêm vào Allow WebRequest của MT5 luôn theo cổng đang dùng.
    gwPort=v.gatewayPort;
    $('fPort').value=v.gatewayPort===v.defaultGatewayPort?'':String(v.gatewayPort);
    $('fPort').placeholder='mặc định '+v.defaultGatewayPort;
    $('gwUrl').textContent='http://127.0.0.1:'+v.gatewayPort;
    mt4Ports(v.gatewayPort);
    if(v.symbolMap||v.tfs||v.gatewayPort!==v.defaultGatewayPort)$('adv').open=true;
  }

  async function load(){
    try{
      const r=await fetch('/api/setup',{cache:'no-store'});
      if(!r.ok)throw new Error('HTTP '+r.status);
      fill(await r.json());loaded=true;
    }catch(e){msg('bad','Không đọc được cài đặt hiện tại: '+e.message)}
  }

  function check(kind,text){const li=el('li',kind,text);return li}
  function renderChecks(){
    if(!info)return;
    const L=[];
    L.push(check('ok','Server đang chạy (phiên bản '+info.version+')'));
    const w=info.worker;
    if(!w)L.push(check('warn','Chưa kết nối Worker: dán mã kết nối ở bước 1'));
    else if(w.lastPollAgoSec!==null&&!w.error)L.push(check('ok','Đã kết nối Worker (liên lạc lần cuối '+ago(w.lastPollAgoSec)+' trước)'));
    else L.push(check('bad','Chưa thông với Worker: '+(w.error||'đang thử kết nối…')));
    if(w){
      if(info.baseUrl)L.push(check('ok','Địa chỉ nhận tín hiệu: '+info.baseUrl));
      else L.push(check('warn','Đang tạo địa chỉ công khai (mất vài chục giây). Trong lúc này Server vẫn tự lấy tín hiệu từ Worker.'));
    }
    const g=info.gateway;
    if(g){
      if(g.lastSeenAgoSec===null||g.lastSeenAgoSec>30)L.push(check('warn','Chưa thấy Gateway báo về: Gateway chưa chạy, hoặc là bản cũ (chạy lại bộ cài mới nhất)'));
      else if(g.error)L.push(check('bad','Gateway chưa mở được cổng '+g.port+': '+g.error+'. Đổi sang cổng khác ở mục Nâng cao'+(g.listening?' (tạm giữ cổng '+g.listening+')':'')));
      else if(g.listening===g.port){$('gwUrl').textContent='http://127.0.0.1:'+g.port;mt4Ports(g.port);L.push(check('ok','Gateway đang nghe cổng '+g.port+' (địa chỉ cho MT5: http://127.0.0.1:'+g.port+')'))}
      else L.push(check('warn','Gateway đang chuyển sang cổng '+g.port+'…'));
    }
    const on=live?live.terminals.filter(t=>t.online).length:0;
    L.push(on>0?check('ok',on+' terminal MT5 đang online'):check('warn','Chưa thấy EA nào: làm bước 3 trong MT5. Dùng MT4 mà Experts báo err=5200: mở mục "Dùng MT4?" ở bước 3'));
    $('checks').replaceChildren(...L);
  }

  async function post(body){
    if(saving)return;
    saving=true;$('btnSave').disabled=true;$('btnDisc').disabled=true;
    msg('warn','Đang lưu và kiểm tra kết nối… (có thể mất vài giây)');
    try{
      const r=await fetch('/api/setup',{method:'POST',headers:HDR,body:JSON.stringify(body)});
      const d=await r.json().catch(()=>({ok:false,error:'Máy chủ trả dữ liệu không đọc được.'}));
      if(!r.ok||!d.ok){msg('bad',d.error||('Lỗi '+r.status));return}
      const before=gwPort;
      fill(d.view);
      const portNote=(before!==null&&d.view.gatewayPort!==before)?' Cổng Gateway đã đổi sang '+d.view.gatewayPort+': thêm http://127.0.0.1:'+d.view.gatewayPort+' vào Allow WebRequest của MT5 và sửa InpGateway của EA (bước 3).':'';
      if(d.worker===null)msg('ok','Đã lưu cài đặt.'+portNote);
      else if(d.worker.ok)msg('ok','Đã lưu và kết nối Worker thành công. Từ giờ tín hiệu TradingView sẽ về máy này.'+portNote);
      else msg('warn','Đã lưu, nhưng chưa kết nối được Worker: '+(d.worker.error||'không rõ lý do')+'. Kiểm tra lại mã kết nối (hoặc xin người quản trị cấp lại).'+portNote);
    }catch(e){msg('bad','Không gọi được Server: '+e.message)}
    finally{saving=false;$('btnSave').disabled=false;$('btnDisc').disabled=false}
  }

  $('btnSave').addEventListener('click',()=>{
    const b={},code=$('fCode').value.trim();
    if(code)b.connectCode=code;
    b.accounts=$('fAccounts').value;
    b.symbolMap=$('fMap').value.trim()===''?null:$('fMap').value;
    b.tfs=$('fTfs').value.trim()===''?null:$('fTfs').value;
    b.gatewayPort=$('fPort').value.trim()===''?null:$('fPort').value.trim();
    post(b);
  });
  $('btnDisc').addEventListener('click',()=>{
    if(window.confirm('Ngắt kết nối Worker? Máy này sẽ không nhận tín hiệu cho tới khi bạn dán mã lại.'))post({connectCode:''});
  });
  $('btnPortFocus').addEventListener('click',()=>{$('adv').open=true;if($('fPort').scrollIntoView)$('fPort').scrollIntoView({block:'center'});$('fPort').focus()});
  $('btnCopy').addEventListener('click',async()=>{
    const t=$('gwUrl').textContent;
    try{await navigator.clipboard.writeText(t);$('btnCopy').textContent='Đã chép'}
    catch{const r=document.createRange();r.selectNodeContents($('gwUrl'));const s=getSelection();s.removeAllRanges();s.addRange(r);$('btnCopy').textContent='Bôi đen xong, bấm Ctrl+C'}
    setTimeout(()=>{$('btnCopy').textContent='Chép'},2500);
  });

  document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{
    const src=$(b.getAttribute('data-copy'));if(!src)return;
    try{await navigator.clipboard.writeText(src.textContent);b.textContent='Đã chép'}
    catch{const r=document.createRange();r.selectNodeContents(src);const s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Bôi đen xong, bấm Ctrl+C'}
    setTimeout(()=>{b.textContent='Chép'},2500);
  }));

  window.onData=(i,d)=>{
    info=i;live=d;
    $('setupBtn').hidden=!(i&&i.local);
    // Lần đầu mở sau khi cài: đưa thẳng tới trang Cài đặt để người dùng làm ngay.
    if(!autoOpened&&i&&i.local&&i.needsSetup&&location.hash===''){autoOpened=true;location.hash='#setup'}
    route();
  };
  window.addEventListener('hashchange',route);
})();
