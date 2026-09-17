// Same dashboard, different transport. No browser-generated fake serial ACKs.
export class GatewayTransport {
  constructor(config){this.config=config;this.devices=new Map();this.tail=Promise.resolve();this.epoch=0;this.session=config.token;this.discoverAt=0;this.discovering=null;this.motionRevision=new Map();}
  request(address,command,uid='',isCurrent=()=>true){
    const epoch=this.epoch,queued=performance.now();
    const work=async()=>{
      if(!['stop','sleep'].includes(command)&&(epoch!==this.epoch||!isCurrent()||performance.now()-queued>1200))throw Error('旧请求已取消');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1800);
      try{
        const r=await fetch('/api/request',{method:'POST',signal:controller.signal,headers:{'Content-Type':'text/plain','X-Motor-Token':this.config.token},body:`${address}|${uid}|${command}`});
        const text=await r.text();if(!r.ok)throw Error(text.includes('USB console connected')?'电脑串口正在连接此网关，请在电脑断开连接后再用手机控制；USB线可以保留。':text);return text;
      }catch(e){
        if(command==='status'){const d=this.devices.get('DATA'+address);if(d)d.failed=true;}
        throw e;
      }finally{clearTimeout(timer);}
    };
    const result=this.tail.then(work);this.tail=result.catch(()=>{});return result;
  }
  async discover(){
    if(this.discovering)return this.discovering;
    this.discovering=this.scanKnown();
    try{return await this.discovering;}finally{this.discovering=null;this.discoverAt=Date.now();}
  }
  async scanKnown(){
    for(const address of new Set([this.config.address,1,184])){
      try{
        const p=(await this.request(address,'gatewayinfo')).split(',');
        if(p.length!==6||p[0]!=='META'||Number(p[1])!==address||! /^[0-9a-f]{1,16}$/i.test(p[2])||p[5]!=='2'||!Number.isFinite(Number(p[3]))||Number(p[3])<1||!Number.isFinite(Number(p[4]))||Number(p[4])<=0)throw Error('无效身份');
        const old=this.devices.get('DATA'+address);
        this.devices.set('DATA'+address,Object.assign(old?.uid===p[2]?old:{last:0,failed:false},{address,uid:p[2],gear:Number(p[3]),limit:Number(p[4])}));
      }catch(e){const old=this.devices.get('DATA'+address);if(old)old.failed=true;if(address===this.config.address)throw e;}
    }
  }
  async api(path,body){
    if(path==='ports'){
      if(!this.devices.size||Date.now()-this.discoverAt>5000)await this.discover();
      return {ports:[...this.devices].map(([port,d])=>({port,present:true,esp32:true,active:!d.failed&&(!d.last||Date.now()-d.last<2000),write_ok:!d.failed,hwid:'DATA UID='+d.uid,telemetry_ok:!d.failed&&Date.now()-d.last<2000,rx_age_ms:d.last?Date.now()-d.last:null,connected_age_ms:0,maintenance:false}))};
    }
    const q=new URLSearchParams(path.split('?')[1]||''),port=body?.port||q.get('port'),d=this.devices.get(port);
    if(!d)throw Error('请先发现设备');
    if(path.startsWith('logs?')||path==='connect'||path==='recover-link'){
      let f;
      try {
        f=(await this.request(d.address,'status')).split(',');
        if(f[0]!=='STATUS'||Number(f[1])!==d.address||f.length!==13||!f.slice(1).every(x=>x!==''&&Number.isFinite(Number(x))))throw Error('状态数据无效');
      } catch(e) {d.failed=true;throw e;}
      d.last=Date.now();d.failed=false;
      return {ok:true,session_id:this.session+':'+d.uid,logs:[],gateway:{...d,fields:f.map(Number),time:d.last}};
    }
    if(path==='send'&&['stop','sleep','sync stop','sync off','knob stop'].includes(body.command)){
      this.epoch++;
      const reply=await this.request(d.address,body.command==='sleep'?'sleep':'stop',d.uid);
      return {ok:true,acknowledged:true,reply};
    }
    throw Object.assign(Error('该功能尚未接入热点传输；没有发送动作'),{kind:'validation'});
  }
  async motion(port,mode,value){
    const d=this.devices.get(port);if(!d||d.failed||Date.now()-d.last>2000)throw Error('遥测过期');
    const limits={position:3600,velocity:5400,current:Math.min(1000,d.limit*800)};
    if(!(mode in limits)||!Number.isFinite(value)||Math.abs(value)>limits[mode])throw Error('热点目标超出范围或模式未接通');
    const epoch=this.epoch;
    const revision=(this.motionRevision.get(port)||0)+1;this.motionRevision.set(port,revision);
    const isCurrent=()=>epoch===this.epoch&&this.motionRevision.get(port)===revision&&this.devices.get(port)===d&&!d.failed&&Date.now()-d.last<=2000;
    await this.request(d.address,'wake',d.uid,isCurrent);
    if(!isCurrent())throw Error('目标已被更新或停止操作取消');
    const command={position:'posout',velocity:'velocity',current:'current'}[mode];
    await this.request(d.address,`${command} ${(value*(mode==='velocity'?d.gear:1)).toFixed(4)} 4095 1000`,d.uid,isCurrent);
  }
}
