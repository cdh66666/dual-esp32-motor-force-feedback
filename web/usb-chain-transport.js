// Two-board production topology. Physical USB wins; DATA supplies the missing
// peer. Route changes never reuse an old USB session or motion lease.
export class UsbChainTransport {
  constructor(raw){this.raw=raw;this.devices=new Map();this.lastScan=0;this.route='';}
  owns(port){return this.devices.has(port);}
  async ports(result){
    const serial=p=>(p.hwid?.match(/\bSER=([^\s]+)/i)?.[1]||'').replace(/[:-]/g,'').toUpperCase();
    const physical=result.ports.filter(p=>p.esp32&&!p.recovery_usb&&!/SER=\w\w:/i.test(p.hwid||''));
    // A board put into backend maintenance (for example while the other USB
    // is being used as the gateway) stays in /api/ports, but it is no longer
    // an independently usable physical endpoint.  Treat only a fresh,
    // non-maintenance session as physically present for DATA de-duplication;
    // otherwise the gateway's remote card is incorrectly suppressed.
    const livePhysical=physical.filter(p=>p.active&&p.telemetry_ok&&!p.maintenance);
    const entry=livePhysical[0];
    const route=entry?.port||'';
    if(route!==this.route){this.devices.clear();this.lastScan=0;this.route=route;}
      for(const [key,d] of this.devices)if(livePhysical.some(p=>serial(p)===d.serial))this.devices.delete(key);
    if(entry&&Date.now()-this.lastScan>1500){
      this.lastScan=Date.now();
      const known=(await this.raw('chain/topology')).devices;
      if(!Array.isArray(known))throw Error('设备 ID 表读取失败');
      for(const [key,d] of this.devices)if(!known.some(k=>k.uid===d.uid&&k.address===d.address))this.devices.delete(key);
      const session=(await this.raw('logs?port='+encodeURIComponent(entry.port)+'&since=0')).session_id;
      for(const spec of known.filter(k=>!livePhysical.some(p=>serial(p)===k.serial))){
        const port='DATA-'+spec.address,old=this.devices.get(port);
        try{
          const meta=await this.raw('chain/query',{port:entry.port,session_id:session,address:spec.address,command:'gatewayinfo'});
          if(meta.uid!==spec.uid||![2,3].includes(meta.protocol)||!Number.isFinite(meta.gear)||meta.gear<1||!(meta.current_limit>0))throw Error('远端身份/参数不匹配');
          this.devices.set(port,Object.assign(old?.session===session?old:{last:0,failed:false},
            {...spec,gear:meta.gear,limit:meta.current_limit,model_ke:meta.model_ke,
              protocol:meta.protocol,entry:entry.port,session}));
        }catch(e){if(old)old.failed=true;}
      }
    }
    return {...result,ports:[...result.ports,...[...this.devices].map(([port,d])=>({
      port,esp32:true,present:true,remote:true,entry:d.entry,uid:d.uid,
      address:d.address,gear:d.gear,current_limit:d.limit,model_ke:d.model_ke,protocol:d.protocol,
      hwid:'DATA address='+d.address+' via '+d.entry+' SER='+d.serial,
      active:!d.failed,write_ok:!d.failed,telemetry_ok:!d.failed&&Date.now()-d.last<2000,
      rx_age_ms:d.last?Date.now()-d.last:null,connected_age_ms:0,maintenance:false
    }))]};
  }
  async api(path,body){
    const port=body?.port||new URLSearchParams(path.split('?')[1]||'').get('port');
    const d=this.devices.get(port);if(!d)throw Error('远端路由已失效，请等待重新发现');
    const context={port:d.entry,session_id:d.session,address:d.address,uid:d.uid};
    if(path.startsWith('logs?')||path==='connect'||path==='recover-link'){
      try{
        const r=await this.raw('chain/query',{...context,command:'status'}),f=r.reply.split(',');
        if(f.length!==13||f[0]!=='STATUS'||Number(f[1])!==d.address||!f.slice(1).every(x=>x!==''&&Number.isFinite(Number(x))))throw Error('远端遥测无效');
        d.last=Date.now();d.failed=false;
        return {ok:true,session_id:d.session+':'+d.uid,logs:[],gateway:{...d,fields:f.map(Number),time:d.last}};
      }catch(e){d.failed=true;throw e;}
    }
    if(path==='send'&&body.command==='sync status'){
      return {...await this.raw('chain/query',{...context,command:'sync status'}),acknowledged:true};
    }
    if(path==='send'&&body.command==='wake'){
      const r=await this.raw('chain/control',{...context,mode:'wake'});
      return {...r,acknowledged:r.accepted===true};
    }
    if(path==='send'&&['stop','sleep','recover','sync stop','sync off','knob stop'].includes(body.command)){
      const mode=body.command==='sleep'?'sleep':
        body.command==='recover'?'recover':
        ['sync stop','sync off'].includes(body.command)?'sync_stop':'stop';
      const r=await this.raw('chain/control',{...context,mode});
      return {...r,acknowledged:r.accepted===true};
    }
    if(path==='send'&&typeof body.command==='string'){
      const m=body.command.match(/^sync force\s+(\d{1,3})\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+(\d{1,4})\s+(\d{1,5})\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
      if(m){
        const r=await this.raw('chain/control',{...context,mode:'sync_force',peer:Number(m[1]),
          stiffness:Number(m[2]),damping:Number(m[3]),reflection:Number(m[4]),
          limit:Number(m[5]),duty:Number(m[6]),timeout:Number(m[7]),offset:Number(m[8])});
        return {...r,acknowledged:r.accepted===true};
      }
    }
    throw Object.assign(Error('此远端功能尚未接通；未发送命令'),{kind:'validation'});
  }
  async keepaliveControl(port,mode){
    const d=this.devices.get(port);
    if(!d||!['stop','sync_stop'].includes(mode))throw Error('远端 STOP 路由已失效');
    const context={port:d.entry,session_id:d.session,address:d.address,uid:d.uid,mode};
    return this.raw('chain/control',context,1200,true);
  }
  async motion(port,mode,value){
    const d=this.devices.get(port);if(!d||d.failed||Date.now()-d.last>2000)throw Error('远端遥测过期');
    const scale={position:360,velocity:360,current:1000,pwm:1};
    if(!(mode in scale))throw Error('不支持的远端模式');
    return this.raw('chain/control',{port:d.entry,session_id:d.session,address:d.address,uid:d.uid,mode,value:value/scale[mode]});
  }
}
