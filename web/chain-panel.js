export function installChainPanel({api,boards}) {
  const $=s=>document.querySelector(s),dialog=$('#chainWindow');
  let cancelled=true,busy=false,selected=null,generation=0,idTarget=null;
  const invalidate=()=>{cancelled=true;generation++;selected=null;idTarget=null;$('#chainIdIdentity').textContent='尚未读取';$('#chainDevices').replaceChildren();};
  const context=()=>{const b=boards.get($('#chainPort').value);if(!b?.active||b.remote||!b.sessionId)throw Error('先连接实际 USB 入口');return {port:b.port,session_id:b.sessionId};};
  const current=(ctx,epoch)=>epoch===generation&&$('#chainPort').value===ctx.port&&boards.get(ctx.port)?.sessionId===ctx.session_id&&boards.get(ctx.port)?.active;
  $('#chainOpen').onclick=()=>{
    invalidate();$('#chainPort').replaceChildren();
    for(const b of boards.values())if(b.active&&!b.remote){const o=new Option(b.port,b.port);$('#chainPort').append(o);}
    $('#chainState').textContent='快速发现按双板设计；未找到时可完整扫描。只读操作，不转电机。';
    $('#chainWifi').open=false;$('#chainWifiState').textContent='免密码热点。手机连接后点系统的登录/打开网页提示；未弹出时访问 http://192.168.4.1/。运动前断开电脑串口；附近的人也能连接。';
    dialog.showModal();
  };
  $('#chainPort').onchange=()=>{invalidate();$('#chainState').textContent='入口已切换，请重新发现设备。';$('#chainWifiState').textContent='USB 已切换，请重新读取热点信息。';};
  $('#chainWifiRead').onclick=async()=>{
    if(busy)return;busy=true;
    try{const ctx=context();const r=await api('send',{...ctx,command:'wifi status',wait_ack:true});
      if($('#chainPort').value===ctx.port)$('#chainWifiState').textContent=ctx.port+'：'+r.reply.replace('password=none','免密码')+'；连接后点手机系统的登录提示，或访问 http://192.168.4.1/。';
    }catch(e){$('#chainWifiState').textContent=e.message;}finally{busy=false;}
  };
  $('#chainDevices').onchange=()=>{selected=$('#chainDevices').value?JSON.parse($('#chainDevices').value):null;};
  $('#chainIdRead').onclick=async()=>{
    if(busy)return;busy=true;const epoch=generation;
    try{
      const ctx=context(),r=await api('send',{...ctx,command:'businfo',wait_ack:true});
      if(!current(ctx,epoch))return;
      const m=r.reply.match(/BUS addr=(\d+) uid=([0-9a-f]+)/i);
      if(!m)throw Error('设备身份回执无效');
      idTarget={...ctx,uid:m[2].toUpperCase()};$('#chainNewId').value=m[1];
      $('#chainIdIdentity').textContent=`${ctx.port} · ID ${m[1]} · ${idTarget.uid}`;
    }catch(e){if(epoch===generation){idTarget=null;$('#chainState').textContent=e.message;}}finally{busy=false;}
  };
  $('#chainIdSave').onclick=async()=>{
    if(busy)return;const epoch=generation,ctx=idTarget;
    if(!ctx||!current(ctx,epoch)){$('#chainState').textContent='请先重新读取所选板 ID';return;}
    busy=true;
    try{
      const address=Number($('#chainNewId').value);
      if(!Number.isInteger(address)||address<1||address>254)throw Error('ID 必须为 1–254 的整数');
      const r=await api('chain/assign-id',{...ctx,address});
      if(!current(ctx,epoch))return;
      invalidate();boards.get(ctx.port).busAddress=r.address;
      $('#chainState').textContent=`${ctx.port} ID ${r.previous} → ${r.address}，已回读。${r.note}`;
    }catch(e){if(epoch===generation)$('#chainState').textContent=e.message;}finally{busy=false;}
  };
  const scan=async(full)=>{
    if(busy)return;invalidate();busy=true;cancelled=false;const epoch=generation;
    try{
      const ctx=context(),registry=await api('chain/topology');
      if(!current(ctx,epoch))return;
      const known=[...registry.devices.map(d=>d.address),...[...boards.values()].map(b=>b.busAddress)].filter(n=>Number.isInteger(n)&&n>=1&&n<=254);
      const order=[...new Set([...known,1,184,...(full?Array.from({length:254},(_,i)=>i+1):[])])],found=new Set();
      for(let i=0;i<order.length&&!cancelled&&current(ctx,epoch);i++){
        $('#chainState').textContent=`扫描 ${i+1}/${order.length}；可结束扫描后选择已发现设备`;
        const r=await api('chain/scan',{...ctx,first:order[i],last:order[i]});
        if(!current(ctx,epoch))return;
        for(const d of r.devices)if(!d.local&&!found.has(d.address+':'+d.uid)){
          found.add(d.address+':'+d.uid);$('#chainDevices').append(new Option(`ID ${d.address} · ${d.uid}`,JSON.stringify({...ctx,...d})));
        }
        if(!full&&found.size>=1)break;
      }
      if(!current(ctx,epoch))return;
      $('#chainDevices').onchange();$('#chainState').textContent=`发现 ${$('#chainDevices').options.length} 个远端；`+(found.size?'本机加远端可在主界面调试':'可尝试完整扫描，检查 DATA 接线与设备 ID');
    }catch(e){if(epoch===generation)$('#chainState').textContent=e.message;}finally{busy=false;}
  };
  $('#chainScan').onclick=()=>scan(false);
  $('#chainScanAll').onclick=()=>scan(true);
  $('#chainCancel').onclick=()=>{cancelled=true;};
  $('#chainRead').onclick=async()=>{
    if(busy||!selected)return;busy=true;
    try{$('#chainState').textContent=(await api('chain/query',{...selected,command:'status'})).reply;}
    catch(e){$('#chainState').textContent=e.message;}finally{busy=false;}
  };
  $('#chainStop').onclick=async()=>{
    cancelled=true;
    try{$('#chainState').textContent=(await api('chain/stop',context())).note;}
    catch(e){$('#chainState').textContent=e.message;}
  };
  // Discrete explicit requests until sustained-control lease/owner tests pass.
  $('#chainApply').onclick=async()=>{
    if(busy||!selected)return;busy=true;
    try{
      const mode=$('#chainMode').value;
      const result=await api('chain/control',{...selected,mode,value:Number($('#chainValue').value)});
      $('#chainState').textContent=(result.reply||'已执行')+(mode==='recover'?'；已停机并回读恢复':'；1秒有效期');
    }
    catch(e){$('#chainState').textContent=e.message;}finally{busy=false;}
  };
  $('#chainClose').onclick=()=>{invalidate();dialog.close();};
  dialog.addEventListener('cancel',invalidate);
}
