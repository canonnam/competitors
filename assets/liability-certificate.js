/* Conservative proposals: ambiguous fields remain blank for human review. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.LiabilityCertificate=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  function iso(year,month,day){
    const y=Number(year),m=Number(month),d=Number(day),date=new Date(Date.UTC(y,m-1,d));
    return y>=2000&&y<=2100&&date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`:null;
  }
  function dates(value){return [...value.matchAll(/(20\d{2})\s*(?:년|[.\/-])\s*(\d{1,2})\s*(?:월|[.\/-])\s*(\d{1,2})\s*일?/g)].map(m=>iso(m[1],m[2],m[3])).filter(Boolean);}
  function parse(source){
    const text=String(source).replace(/\r/g,'').replace(/[：]/g,':'),compact=text.replace(/[ \t]+/g,' ');
    const unique=values=>[...new Set(values)];
    const names=unique([...compact.matchAll(/(?:보험\s*이름|보험\s*명(?!세)|상품\s*명|보험\s*종목)\s*[:：]?\s*([^\n]{2,100})/g)].map(m=>m[1].trim().split(/\s{2,}|보험기간|가입기간|증권번호|계약자/)[0].trim()).filter(Boolean));
    const counts=unique([...compact.matchAll(/(?:가입\s*인원|보험\s*가입\s*인원|피보험자\s*(?:수|인원)|(?:입소자|수용)\s*인원|보상\s*대상\s*인원)\s*(?:\([^\n)]{0,20}\))?\s*[:：]?\s*([\d,]+)\s*(?:명|인|$)/gm)].map(m=>Number(m[1].replace(/,/g,''))).filter(n=>Number.isSafeInteger(n)&&n>=0&&n<=10000));
    const periods=[];
    for(const m of compact.matchAll(/(?:보험\s*기간|가입\s*기간|보장\s*기간)\s*[:：]?\s*([\s\S]{0,180})/g)){
      const found=dates(m[1]);if(found.length>=2&&found[0]<=found[1])periods.push([found[0],found[1]].join('|'));
    }
    const period=unique(periods),range=period.length===1?period[0].split('|'):[];
    const proposal={insuranceName:names.length===1?names[0]:null,insuredCount:counts.length===1?counts[0]:null,startDate:range[0]||null,endDate:range[1]||null};
    const missing=[['insuranceName','보험 이름'],['insuredCount','가입 인원'],['startDate','가입기간']].filter(([key])=>proposal[key]===null).map(([,label])=>label);
    return {...proposal,missing};
  }
  return {parse,iso};
});
