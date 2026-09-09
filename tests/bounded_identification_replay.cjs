// Offline analysis only: no hardware commands or parameter writes.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../web/dashboard.js'),'utf8');
const ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function fitControlRows('),src.indexOf('async function runAutoTune(')),ctx);
for(const port of ['COM4','COM23']) {
  const r=JSON.parse(fs.readFileSync(path.join(__dirname,`../evidence/bounded-identify-${port}-20260908.json`),'utf8'));
  let result;
  const fit=ctx.fitControlRows, diagnostics=[];
  ctx.fitControlRows=(rows,label)=>{
    const groups=[...new Set(rows.map(x=>x.group))].map(group=>({group,count:rows.filter(x=>x.group===group).length}));
    const diagnostic={label,groups}; diagnostics.push(diagnostic);
    const value=fit(rows,label); diagnostic.fit=value;
    return value;
  };
  try { result=ctx.calculateThreeLoopModel(r.pulses,r.gear,r.pulses[0].bus); }
  catch(error) { result={rejected:error.message}; }
  ctx.fitControlRows=fit;
  console.log(JSON.stringify({port,result,diagnostics}));
}
