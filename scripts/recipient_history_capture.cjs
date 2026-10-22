/* Pure capture minimizer. Browser UI reads must use the documented Computer Use API. */
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const institutions={anyang:'14117000625',incheon:'12817700685'};
const headers=['수급자명','인정관리번호','자격','적용일자','종료일자'];
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function prepare(raw,branch,period,checkedAt=new Date().toISOString()){
  if(!institutions[branch]||raw.institutionNumber!==institutions[branch]||raw.benefitMonth!==period||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period))throw new Error('기관·조회 월 불일치');
  if(raw.filter!=='전체'||JSON.stringify(raw.headers)!==JSON.stringify(headers)||!Number.isInteger(raw.queryCount)||raw.queryCount<0||raw.queryCount!==raw.rows?.length)throw new Error('전체 필터·열·조회 건수 대조 실패');
  const records=raw.rows.map(row=>{
    if(!Array.isArray(row)||row.length!==5||row.some(x=>typeof x!=='string'))throw new Error('원본 열 형식 불일치');
    const [name,number,qualification,appliedOn,endOn]=row.map(x=>x.trim());
    if(!number||!name||!qualification)throw new Error('원본 식별·자격 필드 미확인');
    return {personKey:sha(branch+':'+number),name,qualification,appliedOn,endOn};
  });
  return {schemaVersion:1,benefitMonth:period,branches:[{id:branch,institutionNumber:institutions[branch],checkedAt,
    source:{kind:'portal-dom',recordCount:records.length,headers,sha256:sha(JSON.stringify(records))},records}]};
}
async function saveCapture(raw,branch,period,outputDirectory){
  const clean=prepare(raw,branch,period);
  const directory=path.resolve(outputDirectory);
  // Generated private export, never source files or public data/assets.
  if(!directory.split(path.sep).includes('.local'))throw new Error('수집 자료는 .local 내부에만 저장합니다.');
  await fs.mkdir(directory,{recursive:true});
  const target=path.join(directory,`${branch}-${period}.json`);
  await fs.writeFile(target,JSON.stringify(clean,null,2),{encoding:'utf8',mode:0o600});
  return {benefitMonth:period,branch,recordCount:clean.branches[0].records.length,path:target};
}
module.exports={prepare,saveCapture};
