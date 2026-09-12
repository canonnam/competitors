"""Opt-in live verification using public forms and explicitly synthetic company data."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import support_applications as support
import support_documents as docs


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',action='store_true')
    args=parser.parse_args()
    if not args.live:parser.error('--live is required; this uses the configured AI API with test data')
    output=Path('.local/support-verification');output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='support-verify-') as temp:
        os.environ['SUPPORT_DB_PATH']=str(Path(temp)/'verification.db');support.init_db()
        p=support.profile();p['data']['company'].update({'name':'검증용 콤파스원','representative':'테스트대표','business_number':'000-00-00000','industry':'소프트웨어 개발','established_date':'2024-01-01'})
        p['data']['branches'][3]['address']='인천광역시 테스트 주소 (실제 주소 아님)'
        p['data']['plans']=[{'id':'verify-plan','name':'테스트용 요양 기록 자동화 계획','overview':'요양원 직원의 업무 기록과 내부 문서 검색을 돕는 AI 서비스 도입 계획.',
            'problem':'업무 기록을 여러 문서에서 찾아야 하는 불편을 줄이는 것을 목표로 한다.',
            'product':'직원이 입력한 기록을 분류하고 승인된 업무 문서를 검색하는 서비스.',
            'schedule':'요구사항 정리, 기존 자료 정비, 시범 적용, 담당자 검토, 현장 피드백 순으로 추진한다.',
            'goals':'업무 기록의 접근성과 일관성을 개선하고 현장 피드백을 받아 개선한다.',
            'content':'이 자료는 자동화 검증용 가상 계획이다. 공급기업, 예산, 정량 목표, 인력 경력은 정해지지 않았다.'}]
        support.save_profile(p)
        url='https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126334'
        case={'id':'bizinfo:PBLN_000000000126334','url':url,'title':'인천 AX 지원사업 — 검증용','application_period':'2026.09.07 ~ 2026.10.02'}
        with closing(support.connect()) as db,db:db.execute('INSERT INTO support_cases VALUES(?,?,\'queued\',\'\',?)',(case['id'],support.dumps(case),support.now()))
        support.collect_case(case['id'])
        selected=[a for a in support.assets(case['id']) if a['kind'] in ('form','consent')]
        assert len(selected)>=2,selected
        assert all(not a['error'] for a in selected),selected
        print('Public attachments:',[(a['name'],a['targets']) for a in support.assets(case['id'])],flush=True)
        created=support.create_draft({'case_id':case['id'],'branch_id':'incheon','plan_id':'verify-plan','asset_ids':[a['id'] for a in selected]})
        with closing(support.connect()) as db:job=db.execute("SELECT * FROM support_jobs WHERE kind='draft'").fetchone()
        support.run_job(job);draft=support.get_draft(created['id'])
        (output/'draft-verification.json').write_text(support.dumps(draft),encoding='utf-8')
        assert draft['status']=='ready',draft['error']
        application=next(d for d in draft['data']['documents'] if '참가 신청서' in d['name'])
        filled={f['target_id']:f['value'] for f in application['fields']}
        assert filled['Contents/section0.xml:t0r3c1']=='검증용 콤파스원'
        assert filled['Contents/section0.xml:t0r3c4']=='테스트대표'
        assert not filled.get('Contents/section0.xml:t0r7c4'), 'Unknown contact person must not use the representative name'
        assert not filled.get('Contents/section0.xml:t0r1c0'), 'Spacer must stay empty'
        for document in draft['data']['documents']:
            asset=support.get_asset(document['asset_id']);before=json.loads(asset['analysis'])
            name,raw=support.draft_export(draft['id'],document['asset_id']);(output/name).write_bytes(raw)
            after=docs.inspect_document(name,raw)
            assert len(before['targets'])==len(after['targets'])
            mapped={t['id']:t for t in after['targets']}
            for field in document['fields']:
                if field['value']:assert field['value'].replace('\n','')==mapped[field['target_id']]['text'].replace('\n',''),field
            print('Verified output:',name,'fields:',len(document['fields']),'missing:',sum(not f['value'] for f in document['fields']),flush=True)
        print('PASS: live download, HWP conversion, AI drafting, HWPX re-read, target values and original structure',flush=True)


if __name__=='__main__':main()
