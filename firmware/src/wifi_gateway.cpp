#include "wifi_gateway.h"
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <atomic>
#include <esp_netif.h>
#include "dashboard_assets.generated.h"

namespace motor_wifi {
static QueueHandle_t requests=nullptr,responses=nullptr;
static char networkName[32]{},token[33]{};
static uint8_t localAddress;
static std::atomic<bool> available{false};
static std::atomic<uint32_t> associated{0}, disconnected{0}, leases{0}, dhcpRepairs{0};
static std::atomic<int> startupError{0};
static uint8_t apChannel=1;

static int dhcpStatus() {
  auto *netif=esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
  esp_netif_dhcp_status_t state=ESP_NETIF_DHCP_INIT;
  return netif && esp_netif_dhcps_get_status(netif,&state)==ESP_OK ? int(state) : -1;
}
static const char page[] PROGMEM=R"HTML(<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>电机热点调试</title>
<style>body{background:#102331;color:#e3edf5;font:16px 'Microsoft YaHei',sans-serif;max-width:600px;margin:auto;padding:18px}h1{font-size:24px}label{display:block;margin:14px 0}input,select,button{font:inherit;padding:12px;border-radius:6px;border:1px solid #67869b}button{background:#1e536c;color:white;margin:5px 0}input{width:90%;background:#eaf0f3}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;min-height:70px}#stop{background:#943244;width:100%}:focus-visible{outline:3px solid #ebc575}small{color:#abc0cc}</style>
<h1>电机热点调试</h1><small>免密码热点。附近的人也能连接，请仅在受控场地开启设备。</small>
<p><button id="discover">发现整条总线</button><button id="cancelScan">结束扫描</button> <a href="http://192.168.4.1/">在浏览器打开控制页</a></p>
<label>已发现设备 <select id="devices"><option value="">正在读取本机</option></select></label>
<label>曲线 <select id="signal"><option value="position">位置 r</option><option value="velocity">速度 r/s</option><option value="current">电流 A</option><option value="pwm">PWM %</option></select></label>
<div id="scope"></div>
<label>设备地址 <input id="address" type="number" min="1" max="254" value="%ADDR%"></label>
<button id="read">读取设备与状态</button><pre id="state" role="status">先读取设备身份；不会自动唤醒或恢复旧目标。</pre>
<label>模式 <select id="mode"><option value="posout">位置 / r</option><option value="velocity">速度 / r/s</option><option value="current">电流 / A</option></select></label>
<label>目标 <input id="value" type="number" step="0.01" value="0"></label>
<button id="wake">唤醒所选设备</button><button id="apply">执行 1 秒</button><button id="stop">停止所选设备</button>
<p><small>位置±10r、速度±15r/s、电流±1A且受板端限幅。电脑串口断开后才允许手机控制，避免两端争抢。不会自动续发；修改地址后必须重新读取身份。设备未响应时检查 DATA、电源及地址冲突。</small></p>
<script>
const $=s=>document.querySelector(s);let meta=null,busy=false,scanning=false,scanCancel=false,stopPending=false;
const known=new Map(),localAddress=Number('%ADDR%');
async function request(command,uid='',address=Number($('#address').value)){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1800);
 try{const r=await fetch('/api/request',{method:'POST',signal:controller.signal,headers:{'Content-Type':'text/plain','X-Motor-Token':'%TOKEN%'},body:address+'|'+uid+'|'+command});const text=await r.text();if(!r.ok)throw Error(text);return text;}finally{clearTimeout(timer);}
}
async function run(fn){if(busy||stopPending){$('#state').textContent='正在查询，请稍后重试';return;}busy=true;try{$('#state').textContent=await fn();}catch(e){$('#state').textContent=e.message;}finally{busy=false;}}
function choose(address){$('#address').value=address;meta=known.get(Number(address))||null;}
$('#address').oninput=()=>{meta=null;};
$('#devices').onchange=()=>choose($('#devices').value);
async function identify(address){
 const m=(await request('gatewayinfo','',address)).split(',');
  if(m[0]!=='META'||Number(m[1])!==address||![2,3].includes(Number(m.at(-1)))||!(Number(m[3])>0))throw Error('设备身份/协议无效');
 let d=known.get(address);
 if(!d||d.uid!==m[2]){d={uid:m[2],gear:Number(m[3]),limit:Number(m[4]),samples:[]};known.set(address,d);}
 $('#devices').replaceChildren(...Array.from(known,([a,x])=>new Option('地址 '+a+' · '+x.uid,String(a))));
 $('#devices').value=String($('#address').value);
 return d;
}
function sample(address,text){
 const d=known.get(address),f=text.split(',');if(!d||f[0]!=='STATUS'||Number(f[1])!==address)throw Error('状态格式无效');
 const s={t:performance.now(),position:Number(f[3])/(360*d.gear),velocity:Number(f[10])/(360*d.gear),current:Number(f[5])/1000,pwm:Number(f[6])/4095*100};
 if(!Object.values(s).every(Number.isFinite))throw Error('状态数据无效');
 d.samples.push(s);while(d.samples.length>100)d.samples.shift();d.error='';
}
function draw(){
 const box=$('#scope');box.replaceChildren();const k=$('#signal').value;
 for(const [a,d] of known){
  const label=document.createElement('p'),s=d.samples.at(-1),age=s?(performance.now()-s.t)/1000:Infinity;
  label.textContent='地址 '+a+(s?' · '+s[k].toFixed(2)+' '+$('#signal').selectedOptions[0].textContent.split(' ').slice(1).join(' '):' · 等待数据')+(age>2?' · 数据过期':'')+(d.error?' · '+d.error:'');box.append(label);
  const c=document.createElement('canvas');c.width=600;c.height=150;c.style.cssText='width:100%;height:150px;background:#091a26';box.append(c);
  const ctx=c.getContext('2d'),now=performance.now(),points=d.samples.filter(p=>now-p.t<=10000),vals=points.map(p=>p[k]);
  if(!vals.length)continue;
  let lo=Math.min(...vals),hi=Math.max(...vals),pad=Math.max((hi-lo)*.15,k==='current'?.01:.02);lo-=pad;hi+=pad;
  ctx.font='12px sans-serif';ctx.fillStyle='#abc0cc';ctx.strokeStyle='#345165';
  for(let i=0;i<3;i++){const y=12+i*58;ctx.fillText((hi-(hi-lo)*i/2).toFixed(2),2,y+4);ctx.beginPath();ctx.moveTo(58,y);ctx.lineTo(590,y);ctx.stroke();}
  ctx.fillText('-10s',58,146);ctx.fillText('0s',570,146);ctx.strokeStyle='#6dd3bd';ctx.beginPath();points.forEach((p,i)=>{const x=58+(1-(now-p.t)/10000)*532,y=12+(hi-p[k])/(hi-lo)*116;if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
 }
}
$('#signal').onchange=draw;
$('#read').onclick=()=>run(async()=>{const a=Number($('#address').value);meta=null;meta=await identify(a);const s=await request('status','',a);sample(a,s);draw();return s;});
async function scan(full){
 if(busy||scanning||stopPending)return;scanning=true;scanCancel=false;
 const addresses=[...new Set([localAddress,1,184,...(full?Array.from({length:254},(_,i)=>i+1):[])])];
 try{for(const a of addresses){if(scanCancel||document.hidden)break;while(busy&&!scanCancel)await new Promise(r=>setTimeout(r,100));if(scanCancel)break;busy=true;
  try{await identify(a);$('#state').textContent='已发现 '+known.size+' 台，扫描地址 '+a;}catch(e){$('#state').textContent='地址 '+a+' 未响应；继续扫描';}finally{busy=false;}
 }}finally{scanning=false;choose(Number($('#address').value));$('#state').textContent='发现 '+known.size+' 台；只读发现不会启动电机。';draw();}
}
$('#discover').onclick=()=>scan(true);$('#cancelScan').onclick=()=>scanCancel=true;
let pollIndex=0;
async function poll(){
 if(!document.hidden&&!busy&&!scanning&&!stopPending&&known.size){const addresses=[...known.keys()],a=addresses[pollIndex++%addresses.length];busy=true;
  try{sample(a,await request('status','',a));}catch(e){known.get(a).error=e.message;}finally{busy=false;draw();}
 }
 setTimeout(poll,250);
}
$('#wake').onclick=()=>run(()=>{if(!meta)throw Error('先读取身份');return request('wake',meta.uid);});
$('#apply').onclick=()=>run(()=>{if(!meta)throw Error('先读取身份');let v=Number($('#value').value),m=$('#mode').value;if(!Number.isFinite(v))throw Error('目标无效');const max=m==='posout'?10:m==='velocity'?15:Math.min(1,.8*meta.limit);if(Math.abs(v)>max)throw Error('超出范围 ±'+max);v*=m==='posout'?360:m==='velocity'?360*meta.gear:1000;return request(m+' '+v.toFixed(4)+' 4095 1000',meta.uid);});
$('#stop').onclick=async()=>{
 if(stopPending)return;stopPending=true;scanCancel=true;const address=Number($('#address').value);
 try{while(busy)await new Promise(r=>setTimeout(r,20));busy=true;$('#state').textContent=await request('stop','',address);}
 catch(e){$('#state').textContent=e.message;}finally{busy=false;stopPending=false;}
};
scan(false).finally(poll);
</script></html>)HTML";

static void task(void*) {
  snprintf(token,sizeof(token),"%08lx%08lx%08lx%08lx",esp_random(),esp_random(),esp_random(),esp_random());
  WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t){
    if(event==ARDUINO_EVENT_WIFI_AP_STACONNECTED)++associated;
    if(event==ARDUINO_EVENT_WIFI_AP_STADISCONNECTED)++disconnected;
    if(event==ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED)++leases;
  });
  if(!WiFi.mode(WIFI_AP)){startupError.store(1);return vTaskDelete(nullptr);}
  // Deliberately open AP at the user's request. HTTP token is CSRF protection,
  // not authentication: anyone connected to this network can open the page.
  if(!WiFi.softAP(networkName,nullptr,apChannel,false,4)){startupError.store(2);return vTaskDelete(nullptr);}
  // Configure and verify DHCP itself, not just the portal URL.
  if(!WiFi.softAPConfig(IPAddress(192,168,4,1),IPAddress(192,168,4,1),
                       IPAddress(255,255,255,0),IPAddress(192,168,4,2))){
    startupError.store(3);return vTaskDelete(nullptr);
  }
  if(dhcpStatus()!=ESP_NETIF_DHCP_STARTED){startupError.store(4);return vTaskDelete(nullptr);}
  DNSServer dns;
  dns.setTTL(0);
  if(!dns.start(53,"*",WiFi.softAPIP())){startupError.store(5);return vTaskDelete(nullptr);}
  WebServer server(80);
  const char *headers[]={"X-Motor-Token"};server.collectHeaders(headers,1);
  for(const auto &asset:dashboardAssets){
    const auto *entry=&asset;
    server.on(entry->path,HTTP_GET,[&,entry](){
      server.sendHeader("Cache-Control","no-store");server.sendHeader("Content-Encoding","gzip");
      server.send_P(200,entry->mime,reinterpret_cast<const char*>(entry->data),entry->size);
    });
  }
  server.on("/gateway-config.js",HTTP_GET,[&](){
    server.sendHeader("Cache-Control","no-store");
    server.send(200,"text/javascript",String("window.MOTOR_GATEWAY={address:")+String(localAddress)+",token:'"+token+"'};");
  });
  // Retain the old engineering page only as an explicit diagnostic fallback.
  server.on("/engineering",HTTP_GET,[&](){String html=FPSTR(page);html.replace("%ADDR%",String(localAddress));html.replace("%TOKEN%",token);server.sendHeader("Cache-Control","no-store");server.send(200,"text/html; charset=utf-8",html);});
  // Captive-portal probes and unknown HTTP hosts land on the canonical origin.
  // HTTPS cannot be intercepted; phones may still require tapping Sign in.
  server.onNotFound([&](){
    if(server.uri().startsWith("/api/")){server.send(404,"text/plain","Unknown API");return;}
    server.sendHeader("Cache-Control","no-store");
    server.sendHeader("Location","http://192.168.4.1/",true);
    server.send(302,"text/plain","Open http://192.168.4.1/");
  });
  uint32_t nextId=0;
  server.on("/api/request",HTTP_POST,[&](){
    if(server.header("X-Motor-Token")!=token){server.send(403,"text/plain","Invalid session token");return;}
    const String body=server.arg("plain");const int a=body.indexOf('|'),b=body.indexOf('|',a+1);
    if(body.length()>120||a<1||b<0){server.send(400,"text/plain","Invalid request");return;}
    const String addr=body.substring(0,a),uid=body.substring(a+1,b),cmd=body.substring(b+1);
    bool valid=addr.length()<=3&&uid.length()<=16&&cmd.length()>0&&cmd.length()<=96;
    for(unsigned i=0;i<addr.length();i++)valid&=isDigit(addr[i]);
    for(unsigned i=0;i<uid.length();i++)valid&=isHexadecimalDigit(uid[i]);
    for(unsigned i=0;i<cmd.length();i++)valid&=cmd[i]>=32&&cmd[i]<=126;
    const int address=addr.toInt();
    if(!valid||address<1||address>254){server.send(400,"text/plain","Invalid address/command");return;}
    Request req{};req.id=++nextId;req.deadline=millis()+500;req.address=address;
    strlcpy(req.uid,uid.c_str(),sizeof(req.uid));strlcpy(req.command,cmd.c_str(),sizeof(req.command));
    Response response;while(xQueueReceive(responses,&response,0)==pdTRUE){}
    if(xQueueSend(requests,&req,0)!=pdTRUE){server.send(409,"text/plain","Control queue busy");return;}
    const uint32_t until=millis()+650;
    while(static_cast<int32_t>(millis()-until)<0){
      if(xQueueReceive(responses,&response,pdMS_TO_TICKS(20))==pdTRUE&&response.id==req.id){server.send(response.ok?200:409,"text/plain; charset=utf-8",response.text);return;}
    }
    server.send(504,"text/plain","No confirmed response; do not assume execution");
  });
  server.begin();available.store(true);
  uint32_t lastHealth=millis();
  for(;;){
    dns.processNextRequest();server.handleClient();
    if(uint32_t(millis()-lastHealth)>=2000){
      lastHealth=millis();
      // Never reset healthy leases or disconnect clients on a slow request.
      if(dhcpStatus()!=ESP_NETIF_DHCP_STARTED){
        auto *netif=esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
        if(netif && esp_netif_dhcps_start(netif)==ESP_OK)++dhcpRepairs;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}
bool begin(uint8_t address,uint64_t uid){
  if(requests)return true;
  // The low bytes contain the shared vendor prefix on these ESP32 boards.
  // Keep all 48 identity bits so two boards do not advertise the same SSID.
  localAddress=address;snprintf(networkName,sizeof(networkName),"Motor-%012llX",uid&0xffffffffffffULL);
  apChannel=1+5*((uid>>24)%3);
  requests=xQueueCreate(2,sizeof(Request));responses=xQueueCreate(2,sizeof(Response));
  if(!requests||!responses)return false;
  return xTaskCreatePinnedToCore(task,"motor_wifi",8192,nullptr,1,nullptr,0)==pdPASS;
}
bool take(Request&r){return requests&&xQueueReceive(requests,&r,0)==pdTRUE;}
void reply(uint32_t id,bool ok,const char*text){Response r{};r.id=id;r.ok=ok;strlcpy(r.text,text,sizeof(r.text));if(responses)xQueueSend(responses,&r,0);}
bool ready(){return available.load();}
const char*ssid(){return networkName;}
const char*password(){return available.load()?"none":"not_ready";}
String diagnostics(){
  return String("WIFI ready=")+int(available.load())+" ssid="+networkName+
    " password="+password()+" url=http://192.168.4.1/ ip="+WiFi.softAPIP().toString()+
    " channel="+int(apChannel)+" clients="+WiFi.softAPgetStationNum()+
    " dhcp="+(dhcpStatus()==ESP_NETIF_DHCP_STARTED?"started":"stopped")+
    " joins="+associated.load()+" leaves="+disconnected.load()+" leases="+leases.load()+
    " repairs="+dhcpRepairs.load()+" startup_error="+startupError.load();
}
}
