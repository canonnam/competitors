"""Small live checks against a running service; never prints credentials."""
import json
import os
import urllib.request

origin = os.environ.get("WIKI_TEST_URL", "http://localhost:8324").rstrip("/")
cases = [
    ("케어포와 이지케어의 50인 가격을 비교해주세요", ["77,000", "33,000"], "/competitors.html"),
    ("경쟁사 최신 뉴스 3건을 알려주세요", [], "news"),
    ("더비다 안양점 2026년 8월 운영손익은 얼마인가요?", [], "/operating-costs.html"),
    ("더비다 안양점 2026년 7월 운영손익과 전월 대비 증감을 알려주세요", ["3,731,755"], "/operating-costs.html"),
]
for question, expected, source in cases:
    request = urllib.request.Request(origin + "/api/chat", data=json.dumps({"message": question, "history": []}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.load(response)
    assert result["sources"], (question, result["answer"])
    for value in expected:
        assert value in result["answer"], (value, result["answer"])
    if source != "news":
        assert any(row.get("url") == source for row in result["sources"]), result
    if "8월" in question:
        assert "자료" in result["answer"] and any(word in result["answer"] for word in ("없", "확인", "미보유", "제공되지", "있지 않")), result["answer"]
        assert "-3,731,755" not in result["answer"], "Must not silently substitute July"
    print(json.dumps({"question": question, "answer": result["answer"], "sources": [r["title"] for r in result["sources"]]}, ensure_ascii=False), flush=True)
print("Live service chat checks passed", flush=True)
