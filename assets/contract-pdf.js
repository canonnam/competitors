(function (root) {
  'use strict';
  const won = value => value === '' || value == null ? '' : Math.round(value).toLocaleString('ko-KR');
  const date = value => value ? value.replaceAll('-', '.') : '';
  const decimal = value => Number(value.toFixed(2)).toLocaleString('ko-KR');
  function content(model, template) {
    const f = model.fields, result = model.result, key = f.template;
    const cycle = key === 'care-cycle', day = key === 'care-day';
    const values = Object.fromEntries(template.cells.map(c => [c.id, c.text]));
    Object.assign(values, {
      C5: f.organization, I5: f.representative, C6: f.organizationAddress,
      C7: f.employee, I7: f.residentNumber, C8: f.employeeAddress, I8: f.phone,
      B10: `${f.organizationAddress || '기관 주소지'} (단, 기관 사정에 따라 업무장소가 변경될 수 있다.)`,
      G10: `${f.job || '                '}(단, 기관 사정에 따라 업무가 변경될 수 있다.)`,
      B11: date(f.startDate), D11: '~', E11: f.term === 'indefinite' ? '기간의 정함 없음' : date(f.endDate),
      B13: `입사일로부터 ${f.probationMonths || '     '}개월`,
      F13: `수습기간중의 급여는 ${f.probationReduction || '     '}% 감액할 수 있다.\n단, 최저임금법의 적용을 받는다.`,
      B15: model.workText, C21: won(result.total), C22: result.hourly == null ? '' : decimal(result.hourly),
    });
    if (!day) values.B18 = `2. “을”은 기관의 경영상 필요에 따른 연장·야간·휴일근로에 동의하며, 근로시간, 휴게시간, 휴일 규정 등을 확인하고 임금의 구성항목 및 금액을 확인하고 이에 동의함\n${f.employee || '                    '}      (서명)`;
    if (cycle && f.includeFlexibleClause) values.B15 = values.B15.replace('휴게시간을 변경할 수 있다.)', '휴게시간을 변경할 수 있으며, 취업규칙에 따라 탄력적근무제를 실시한다.)');
    const time = result.hours;
    const wageRows = [{ label: '기본급(월)', value: result.basic, note: time ? `${decimal(time.basic)}h(주휴포함)` : '' }];
    wageRows.push({ label: '고정연장수당', value: result.overtime, note: [time ? `${decimal(time.overtime)}h*1.5배` : '',result.overtimeOrdinary?'통상임금 포함':''].filter(Boolean).join('\n') });
    wageRows.push({ label: '고정야간수당', value: result.night, note: [time ? `${decimal(time.night)}h*0.5배` : '',result.nightOrdinary?'통상임금 포함':''].filter(Boolean).join('\n') });
    for (const item of result.extras) {
      if (item.amount > 0 || item.name === '식대') wageRows.push({ label: item.name, value: item.amount || '', note: '해당자에 한함' });
    }
    const capacity = cycle ? 6 : 4;
    const extraWages = wageRows.length > capacity ? wageRows.slice() : [];
    const visibleWages = extraWages.length ? [...wageRows.slice(0, capacity - 1), {
      label: '기타수당 합계', value: wageRows.slice(capacity - 1).reduce((s, x) => s + Number(x.value || 0), 0), note: '별지 참조',
    }] : wageRows;
    const defaults = cycle ? ['기본급(월)', '고정연장수당', '고정야간수당', '식대', '장기근속수당', '특별상여'] : ['기본급(월)', '식대', '자가운전보조금', day ? '특별상여' : '기타수당'];
    for (let i = 0; i < capacity; i++) {
      const row = 21 + i, item = visibleWages[i];
      values[`E${row}`] = item ? item.label : defaults[i];
      values[`F${row}`] = item ? won(item.value) : '';
      values[`I${row}`] = item ? item.note : '해당자에 한함';
    }
    const payRow = cycle ? 27 : 25;
    values[`B${payRow}`] = `1. 임금 지급 : 매월 1일부터 기산하여 말일로 마감하며, 임금 총액에서 제세공과금 및 급여착오(과다) 지급분 등을 공제한 후, ${f.paymentMonth === 'next' ? '익월' : '당월'} ${f.paymentDay || '   '}일 지급한다.`;
    const bank = `( ${f.bank || '                '} 은행, 계좌번호 : ${f.account || '                                   '} 예금주 : ${f.accountHolder || '                '} )`;
    if (day) values.B26 = `2. 임금 지급 방법 : 계좌이체(등록된 본인의 예금계좌로 입금)로 지급한다.\n${bank}`;
    else values[cycle ? 'B29' : 'B27'] = bank;
    if (!f.includeFlexibleClause) {
      values[cycle ? 'B32' : day ? 'B29' : 'B30'] = '';
      const next = cycle ? 'B33' : day ? 'B30' : 'B31';
      values[next] = values[next].replace('6.', '5.');
    }
    if (result.extras.some(x => x.name === '장기근속수당' && x.amount > 0 && x.ordinary)) {
      const cell = cycle ? 'B33' : day ? 'B30' : 'B31';
      values[cell] = values[cell].replace('공단지침에 따르며 통상임금 범위에는 해당하지 아니한다.', '공단지침에 따른다.');
    }
    const pattern = model.schedule.mode === 'weekly' ? `1주 ${model.schedule.pattern.filter(x => x !== 'O').length}일` : `${model.schedule.pattern.map(x => ({D:'주',N:'야',O:'휴'})[x]).join('')} 반복주기`;
    values[cycle ? 'B38' : day ? 'B35' : 'B36'] = `본 계약은 ${pattern} 월 평균 근무일수에 따른 것으로 실제 근무일수는 월별로 달라질 수 있으며, 월 인정근무시간이 부족한 경우 추가 근무가 발생할 수 있고, 계약기간 만료 시 재계약이 되지 않을 수 있다는 점, 계약된 휴게시간을 온전히 사용한다는 점 등에 대하여 종사자는 일체 동의함\n${f.employee || '                    '}                      (서명)`;
    const footer = cycle ? [43, 45, 46] : day ? [40, 42, 43] : [41, 43, 44];
    const d = f.documentDate ? f.documentDate.split('-') : ['', '', ''];
    values[`A${footer[0]}`] = `${d[0] || '     '}년     ${d[1] || '   '}월     ${d[2] || '   '}일`;
    values[`A${footer[1]}`] = `"갑" [사용자]   ${f.organization || '                '}          "을" [근로자] 성 명: ${f.employee || '                    '}      (서명)`;
    values[`A${footer[2]}`] = `대표자   ${f.representative || '                    '}    (인)`;
    return { values, extraWages, specialTerms: f.specialTerms || '' };
  }
  function lines(text, font, size, width) {
    const result = [];
    for (const paragraph of String(text || '').replace(/\t/g, '  ').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean)) {
      let line = '';
      for (const ch of paragraph) {
        if (font.widthOfTextAtSize(line + ch, size) > width && line) { if(line.trim())result.push(line.trim()); line = ''; }
        line += ch;
      }
      if(line.trim())result.push(line.trim());
    }
    return result;
  }
  async function create(model, template, regularBytes, boldBytes, libs) {
    const { PDFLib, fontkit } = libs;
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
    const font = await doc.embedFont(regularBytes, { subset: false });
    const bold = await doc.embedFont(boldBytes, { subset: false });
    const data = content(model, template);
    const characters = new Set(font.getCharacterSet());
    const printable = text => {
      const value = String(text || '').replace(/[⑴⑵⑶]/g, x => ({'⑴':'(1)','⑵':'(2)','⑶':'(3)'})[x]);
      const unsupported = [...value].find(x => x.trim() && !characters.has(x.codePointAt(0)));
      if (unsupported) throw Error(`계약서 글꼴에서 지원하지 않는 문자 '${unsupported}'가 있습니다. 해당 문자를 변경해주세요.`);
      return value;
    };
    for (const key of Object.keys(data.values)) data.values[key] = printable(data.values[key]);
    data.specialTerms = printable(data.specialTerms);
    const pageWidth = 595.28, pageHeight = 841.89, margin = 28;
    const scale = (pageWidth - margin * 2) / template.widths.reduce((a,b) => a + b, 0);
    const widths = template.widths.map(x => x * scale);
    const heights = Object.fromEntries(Object.keys(template.heights).map(r => [r, 0]));
    const sumRows = (r, count) => Array.from({length:count}, (_,i) => heights[r+i]).reduce((a,b) => a+b, 0);
    const prepared = template.cells.map(c => {
      const face = c.bold ? bold : font;
      let size = c.size * scale;
      const w = widths.slice(c.c - 1, c.c - 1 + c.cols).reduce((a,b) => a+b, 0);
      if (/^(F2[1-6]|C21|C22)$/.test(c.id) && data.values[c.id]) {
        size = Math.min(size, size * (w - 8) / face.widthOfTextAtSize(data.values[c.id], size));
      }
      const wrapped = lines(data.values[c.id], face, size, w - 8);
      const required = wrapped.length ? wrapped.length * size * 1.25 + 6 : 0;
      return { ...c, font:face, size, w, wrapped, required };
    });
    // Fit single rows before merged fields; source spacer rows no longer consume space.
    for (const c of prepared.slice().sort((a,b) => a.rows-b.rows)) {
      if (sumRows(c.r,c.rows) < c.required) heights[c.r+c.rows-1] += c.required-sumRows(c.r,c.rows);
    }
    // Keep vertically merged fields together, and keep the signing block on one page.
    const blocks = [];
    for (let r = template.first; r <= template.last;) {
      let end = r;
      if (r >= template.last - 7) end = template.last;
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of prepared) if (c.r >= r && c.r <= end && c.r + c.rows - 1 > end) { end = c.r + c.rows - 1; changed = true; }
      }
      blocks.push([r,end]); r = end + 1;
    }
    let page = doc.addPage([pageWidth,pageHeight]), top = pageHeight - margin;
    for (const [start,end] of blocks) {
      const blockHeight = sumRows(start, end-start+1);
      if (blockHeight > pageHeight-margin*2) throw Error('입력한 문구가 계약서 한 페이지의 공간을 초과합니다. 긴 내용은 특약사항에 입력해주세요.');
      if (top - blockHeight < margin) { page = doc.addPage([pageWidth,pageHeight]); top = pageHeight-margin; }
      for (const c of prepared.filter(c => c.r >= start && c.r <= end)) {
        const x = margin + widths.slice(0,c.c-1).reduce((a,b) => a+b,0);
        const yTop = top - sumRows(start,c.r-start), h = sumRows(c.r,c.rows), bottom = yTop-h;
        const edge = { top: [[x,yTop],[x+c.w,yTop]], bottom:[[x,bottom],[x+c.w,bottom]], left:[[x,yTop],[x,bottom]], right:[[x+c.w,yTop],[x+c.w,bottom]] };
        for (const [side,style] of Object.entries(c.borders)) if (style) {
          const [a,b] = edge[side]; page.drawLine({start:{x:a[0],y:a[1]},end:{x:b[0],y:b[1]},thickness:style==='medium'?0.8:0.45,color:rgb(.12,.12,.12)});
        }
        const lineHeight = c.size*1.25;
        const textHeight = c.wrapped.length*lineHeight;
        const offset = c.vertical === 'top' ? 3 : Math.max(3,(h-textHeight)/2);
        let y = yTop-offset-c.size;
        for (const line of c.wrapped) {
          if (line) {
            const length = c.font.widthOfTextAtSize(line,c.size);
            const align = c.align==='center' ? (c.w-length)/2 : c.align==='right' ? c.w-length-4 : 4;
            page.drawText(line,{x:x+align,y,size:c.size,font:c.font,color:rgb(0,0,0)});
          }
          y -= lineHeight;
        }
      }
      top -= blockHeight;
    }
    if (data.extraWages.length || data.specialTerms) {
      page = doc.addPage([pageWidth,pageHeight]); top = pageHeight-margin;
      const write = (text, size=10, face=font) => {
        for (const line of lines(printable(text),face,size,pageWidth-margin*2)) {
          if (top < margin+20) {page=doc.addPage([pageWidth,pageHeight]);top=pageHeight-margin;}
          page.drawText(line,{x:margin,y:top-size,font:face,size});top-=size*1.6;
        }
      };
      write('근로계약서 별지',16,bold);top-=12;
      write(`기관명: ${model.fields.organization || ''}     근로자: ${model.fields.employee || ''}`);top-=14;
      if(data.extraWages.length){write('임금 구성',12,bold);for(const item of data.extraWages)write(`${item.label}: ${won(item.value)} 원  ${item.note}`);write(`월 급여 총액: ${won(model.result.total)} 원`,11,bold);top-=18;}
      if(data.specialTerms){write('특약사항',12,bold);write(data.specialTerms);}
      top-=22;write('사용자:                          (인)          근로자:                          (서명)');
    }
    const pages=doc.getPages();
    pages.forEach((p,i)=>p.drawText(`${i+1} / ${pages.length}`,{x:pageWidth/2-10,y:13,size:8,font,color:rgb(.4,.4,.4)}));
    doc.setTitle('근로계약서');doc.setCreator('더비다 지식 창고');
    return doc.save();
  }
  const api={content,create,lines};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ContractPDF=api;
})(typeof window!=='undefined'?window:globalThis);
