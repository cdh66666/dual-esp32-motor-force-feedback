// Read-only hardware interaction: download already-buffered server logs.
const fs=require('node:fs');
const {api}=require('./validate_saved_current.cjs');
(async()=>{
 const result={scope:'Existing server buffer only; no control commands',boards:[]};
 for(const port of ['COM4','COM23'])result.boards.push({port,...await api(`logs?port=${port}&since=0`)});
 const file=`evidence/current-existing-buffer-${Date.now()}.json`;
 fs.writeFileSync(file,JSON.stringify(result,null,2),{encoding:'utf8',flag:'wx'});
 console.log(file);
 for(const b of result.boards){const rows=b.logs.filter(r=>r.text.startsWith('S,')).map(r=>r.text.slice(2).split(',').map(Number));console.log({port:b.port,samples:rows.length,controlModes:[...new Set(rows.map(s=>s[11]))],maxRps:Math.max(...rows.map(s=>Math.abs(s[10])/1872))});}
})().catch(e=>{console.error(e);process.exitCode=1;});
