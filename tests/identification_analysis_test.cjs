const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/dashboard.js'),'utf8');
const code=source.slice(source.indexOf('function analyzeCapturedMotor('),source.indexOf("$('#analyzeCapture').addEventListener"));
const context=vm.createContext({});vm.runInContext(code,context);
const record={gear:5.2,identification:Array.from({length:10},(_,n)=>{
 const currentA=(n<5?1:-1)*(.1+.031*(n%3));
 const outputDps=(n<5?1:-1)*(5+7*(n%5));
 const v=3*currentA+.03*outputDps*5.2*Math.PI/180+.1*Math.sign(currentA);
 return {trace:Array.from({length:20},()=>({currentA,outputDps,busV:20,pwm:v/20*4095}))};
})};
const a=context.analyzeCapturedMotor(record);
assert(Math.abs(a.fit.R-3)<1e-8);assert(Math.abs(a.fit.Ke-.03)<1e-8);assert(a.fit.rmse<1e-8);
assert.equal(a.adopted,false);assert(a.reasons.length);
assert(context.analyzeCapturedMotor({gear:5.2,identification:[]}).reasons.length);
const legacy={...record,gear:undefined,analysisAssumedGear:5.2};
assert(context.analyzeCapturedMotor(legacy).reasons.some(r=>r.includes('诊断假设')));
console.log('PASS: captured data fitted, holdout checked, incomplete and assumed data never adopted');
