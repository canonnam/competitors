const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const core=require('./assets/payroll-core.js');
const pdf=require('./assets/contract-pdf.js');
const templates=JSON.parse(fs.readFileSync(path.join(__dirname,'assets/contracts/templates.json'),'utf8'));
const shifts={D:{start:'09:00',end:'18:00',breaks:[{start:'12:00',end:'13:00',hours:1}]},N:{start:'18:00',end:'09:00',breaks:[{start:'18:00',end:'22:00',hours:.5},{start:'22:00',end:'06:00',hours:5},{start:'06:00',end:'09:00',hours:.5}]}};
const cycle={mode:'cycle',pattern:['D','D','N','N','O','O'],shifts,weeklyPaidHours:8};
const weekly={...cycle,mode:'weekly',pattern:['D','D','D','D','D','O','O']};
const near=(a,b)=>assert.ok(Math.abs(a-b)<.000001,`${a} != ${b}`);
near(core.hours(cycle).basic,196.98222222222222);
near(core.hours(cycle).night,30.416666666666668);
near(core.hours(cycle).overtime,10.13888888888889);
assert.equal(core.hours(weekly).basic,209);
assert(core.workText(cycle).includes('야간 18:00~익일 09:00'));
const fixtureRows=[
 [weekly,2900000,[200000,200000],2500000,0],
 [weekly,2256270,[40000,100000],2116270,0],
 [weekly,2420000,[40000],2380000,0],
 [cycle,2420000,[40000],2056304,161848],
 [weekly,2196880,[40000],2156880,0],
];
for(const [s,amount,items,basic,overtime]of fixtureRows){const r=core.calculate({...s,basis:'gross',amount,extras:items.map((amount,i)=>({name:`수당 ${i+1}`,amount,ordinary:true}))});assert.equal(r.basic,basic);assert.equal(r.overtime,overtime);assert.equal(r.total,r.basic+r.overtime+r.night+items.reduce((a,b)=>a+b,0));}
const hourly=core.calculate({...cycle,basis:'hourly',amount:11000,extras:[{name:'실비',amount:100000,ordinary:false}]});
assert.equal(hourly.hourly,11000);assert.equal(hourly.total,Math.round(core.hours(cycle).divisor*11000+100000));
assert.equal(core.calculate({...cycle,basis:'gross',amount:'',extras:[]}).pending,true);
assert.throws(()=>core.calculate({...cycle,basis:'gross',amount:100,extras:[{name:'수당',amount:200,ordinary:true}]}));
assert.throws(()=>core.hours({...cycle,pattern:['O','O']}));
assert.throws(()=>core.shift({start:'18:00',end:'09:00',breaks:[{start:'20:00',end:'00:00',hours:1}]}));
assert.throws(()=>core.shift({start:'09:00',end:'18:00',breaks:[{start:'12:00',end:'14:00',hours:1},{start:'13:00',end:'15:00',hours:1}]}));
const four=core.hours({...cycle,pattern:['D','D','D','D','O','O']});assert.equal(four.night,0);near(four.counts.D,365/6*4/12);
const nights=core.hours({...weekly,pattern:['N','N','N','N','N','N','O']});near(nights.overtime,14*365/7/12);assert.equal(nights.maxWeek,54);
const fields={template:'care-cycle',organization:'검증기관',representative:'',organizationAddress:'검증주소',employee:'',residentNumber:'',phone:'',job:'요양보호사',employeeAddress:'',startDate:'',endDate:'',term:'indefinite',probationMonths:'',probationReduction:'',paymentMonth:'next',paymentDay:'7',bank:'',account:'',accountHolder:'',specialTerms:'',documentDate:'',includeFlexibleClause:false};
function model(key,filled=false){const s=key==='care-cycle'?cycle:weekly;return {fields:{...fields,template:key,...(filled?{employee:'검증용 직원',startDate:'2026-09-11',documentDate:'2026-09-11'}:{})},schedule:s,workText:core.workText(s),result:core.calculate({...s,basis:'gross',amount:filled?2420000:'',extras:[{name:'식대',amount:40000,ordinary:true}]})};}
for(const key of Object.keys(templates)){const c=pdf.content(model(key),templates[key]);assert.equal(c.values.C7,'');assert.equal(c.values.I7,'');assert.equal(c.values.C21,'');assert(!JSON.stringify(c).includes('undefined'));assert(c.values.B17.includes('사전에 기관의 승인을'));assert(c.values.B18.includes('이에 동의함'));}
assert(!/\d{6}-\d{7}|VLOOKUP|#N\/A/.test(JSON.stringify(templates)));
console.log('Payroll: 5 workbook baselines, rounding, missing inputs, custom cycles, weekly overtime and template mapping passed.');
if(process.argv.includes('--pdf'))(async()=>{
 const out=path.resolve(__dirname,'..','.codex-analysis','pdf-qa');fs.mkdirSync(out,{recursive:true});
 const PDFLib=require('./assets/vendor/pdf-lib-1.17.1.min.js'),fontkit=require('./assets/vendor/fontkit-1.1.1.umd.min.js');
 const regular=fs.readFileSync(path.join(__dirname,'assets/contracts/NanumGothic-Regular.ttf')),bold=fs.readFileSync(path.join(__dirname,'assets/contracts/NanumGothic-Bold.ttf'));
 for(const key of Object.keys(templates))for(const filled of [false,true]){const bytes=await pdf.create(model(key,filled),templates[key],regular,bold,{PDFLib,fontkit});fs.writeFileSync(path.join(out,`${key}-${filled?'filled':'blank'}.pdf`),bytes);}
 const long=model('office',true);long.fields.employee='검증용 긴 이름';long.fields.organizationAddress='경기도 안양시 만안구 전파로 19-1 별관 3층 사무실 및 직원 휴게실';long.fields.specialTerms='별도 합의한 특약사항을 기재합니다.\n'.repeat(120);long.result.extras=Array.from({length:8},(_,i)=>({name:`검증 수당 ${i+1}`,amount:10000}));
 long.result.total=long.result.basic+long.result.overtime+long.result.night+80000;
 fs.writeFileSync(path.join(out,'long-fields.pdf'),await pdf.create(long,templates.office,regular,bold,{PDFLib,fontkit}));
 console.log(`PDF samples created in ${out}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
