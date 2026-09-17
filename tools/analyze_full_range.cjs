// Offline analysis only. Never imports a transport or sends motor commands.
const fs=require('node:fs');
const input=process.argv[2];if(!input)throw Error('Usage: node tools/analyze_full_range.cjs evidence/file.json');
const report=JSON.parse(fs.readFileSync(input,'utf8'));
for(const t of report.trials){
 console.log(t.port);
 for(let i=0;i<t.commands.length;i++){
  const c=t.commands[i],next=t.commands[i+1]?.ms??Infinity;
  const rows=t.rows.filter(s=>s.ms>=c.ms&&s.ms<next);if(!rows.length)continue;
  const direction=Math.sign(c.r-rows[0].r),tail=rows.filter(s=>s.ms>=rows.at(-1).ms-500);
  const reached=rows.find(s=>Math.abs(s.r-c.r)*360<=.5);
  console.log(JSON.stringify({targetR:c.r,holdMs:c.hold,complete:rows.at(-1).ms-c.ms>=c.hold-100,
   peakRps:Math.max(...rows.map(s=>Math.abs(s.rps))),
   overshootDeg:Math.max(0,...rows.map(s=>direction*(s.r-c.r)*360)),
   firstHalfDegreeMs:reached?reached.ms-c.ms:null,
   finalErrorDeg:Math.abs(rows.at(-1).r-c.r)*360,
   tailSwingDeg:(Math.max(...tail.map(s=>s.r))-Math.min(...tail.map(s=>s.r)))*360}));
 }
}
