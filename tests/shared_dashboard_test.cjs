// Real shared UI in a mobile viewport. All I/O is mocked; never touches hardware.
const assert=require('node:assert/strict');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
(async()=>{
 console.log('Launching isolated mobile browser');
 const browser=process.env.MOTOR_TEST_CDP ? await chromium.connectOverCDP(process.env.MOTOR_TEST_CDP) : await chromium.launch({headless:true,timeout:15000,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}),errors=[],commands=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});await require('./offline_browser.cjs')(page);
  await page.addInitScript(()=>window.MOTOR_GATEWAY={address:1,token:'offline'});
  await page.route('**/api/request',async route=>{
   const [a,uid,c]=route.request().postData().split('|');commands.push(c);
   const text=c==='gatewayinfo'?`META,${a},ABC${a},5.2,1.5,2`:c==='status'?`STATUS,${a},0,1872,19.5,120,0,1,0,0,0,0,0`:'ACK,1,accepted='+c;
   await route.fulfill({body:text,contentType:'text/plain'});
  });
  await page.goto('http://127.0.0.1:18766/',{waitUntil:'domcontentloaded'});
  console.log('Loaded shared dashboard');
  await page.waitForFunction(()=>document.querySelector('#simpleConnection').textContent.includes('2 / 2'));
  assert(commands.every(c=>['gatewayinfo','status'].includes(c)),'opening never wakes or moves');
  assert(await page.locator('#forceStart').isDisabled());
  assert(await page.locator('#quick-pwm').isDisabled());
  assert.equal(await page.locator('#scopeCanvas').count(),1);
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width})).slice(0,12));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow: '+JSON.stringify(overflow));
  await page.locator('#quick-position').evaluate(el=>{el.value='.1';el.dispatchEvent(new Event('input',{bubbles:true}));});
  try{await page.waitForFunction(()=>document.querySelector('#quickState').textContent.includes('正在控制'));}
  catch(e){throw Error(e.message+'; state='+await page.locator('#quickState').textContent());}
  assert(commands.some(c=>c.startsWith('posout 36.0000 4095 1000')));
  await page.locator('#quickStop').click();
  await page.waitForFunction(()=>document.querySelector('#quickState').textContent==='测试已停止');
  assert(commands.filter(c=>c==='stop').length>=2);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:'evidence/shared-mobile-dashboard.png',fullPage:true});
  console.log('PASS shared mobile UI, two devices, zero auto-motion, mock slider/stop, no overflow or JS errors');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
