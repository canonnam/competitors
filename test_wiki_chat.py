import http.client
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

import app
import wiki_chat as wiki
from scripts.sync_wiki import collect_documents


def document(name="staffing", content=None):
    return {"path": f"wiki/concepts/{name}.md", "content": content or (
        "---\ntype: concept\nupdated: 2026-09-08\nstatus: active\n---\n"
        "# 물리치료사 또는 작업치료사\n\n입소자 30명 이상 시설은 물리치료사 또는 작업치료사 1명을 배치합니다.")}


class WikiTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "wiki.db"
        self.env = patch.dict(os.environ, {"WIKI_DB_PATH": str(self.path), "OPENAI_API_KEY": "test-api-secret", "CHAT_ADMIN_TOKEN": "test-admin-secret", "CHAT_DAILY_LIMIT": "300"})
        self.env.start()
        wiki.init_db()

    def tearDown(self):
        self.env.stop()
        self.directory.cleanup()

    def test_import_is_idempotent_and_replacement_removes_stale_content(self):
        wiki.import_documents([document()])
        self.assertEqual(wiki.import_documents([document()])["unchanged"], 1)
        self.assertTrue(wiki.search("작업치료사를 채용해도 되나요?"))
        wiki.import_documents([document(content="# CCTV 해상도\nHD 1280x720 이상의 해상도가 필요합니다.")])
        self.assertFalse(wiki.search("작업치료사"))
        self.assertTrue(wiki.search("CCTV 해상도"))

    def test_atomic_import_rejects_invalid_doc_without_partial_writes(self):
        with self.assertRaises(wiki.ChatError):
            wiki.import_documents([document(), {"path": "../secret.md", "content": "bad"}])
        self.assertEqual(wiki.list_documents(), [])

    def test_invalid_inputs_and_private_material_are_rejected(self):
        for item in [document(content=""), {"path": "/secret.md", "content": "data"},
                     {"path": "AGENTS.md", "content": "instructions"},
                     {"path": "x.pdf", "content": "file"},
                     document(content="---\npublish: false\n---\n# Secret"),
                     document(content="---\nvisibility: private\n---\n# Secret"),
                     document(content="---\ntags: [internal-manual]\n---\n# Secret"),
                     document(content="---\n!!python/object:builtins.object {}\n---\n# bad"),
                     document(content="x" * 200001)]:
            # The document helper's default is used for empty content; test it separately.
            if item == document():
                continue
            with self.subTest(item=item["path"]), self.assertRaises(wiki.ChatError):
                wiki.import_documents([item])
        with self.assertRaises(wiki.ChatError):
            wiki.import_documents([{"path": "empty.md", "content": ""}])

    def test_sync_only_prunes_wiki_scope(self):
        wiki.import_documents([document("old"), {"path": "uploads/manual.md", "content": "# Manual\nUseful facts"}])
        result = wiki.import_documents([document("new")], replace_wiki=True)
        self.assertEqual(result["removed"], 1)
        self.assertEqual({item["path"] for item in wiki.list_documents()}, {"wiki/concepts/new.md", "uploads/manual.md"})
        self.assertEqual(len(wiki.search("작업치료사")), 1)

    def test_delete_removes_fts_rows(self):
        wiki.import_documents([document()])
        with closing(wiki.connect()) as db, db:
            wiki.remove_document(db, wiki.list_documents()[0]["id"])
        self.assertFalse(wiki.search("작업치료사"))

    def test_korean_retrieval_does_not_only_match_exact_spacing(self):
        wiki.import_documents([document(), document("other", "# 연차 휴가\n입사일을 기준으로 연차를 관리합니다.")])
        self.assertIn("작업치료사", wiki.search("작업 치료사를 채용하고 싶습니다")[0]["title"])
        self.assertEqual(wiki.search("cryptocurrency bitcoin"), [])

    def test_source_links_expand_and_metadata_preserves_dates(self):
        wiki.import_documents([document(content="# 작업치료사\n필수인력입니다. [[공식 배치표]]"),
            {"path": "wiki/sources/rule.md", "content": "---\ntype: source\nupdated: 2025-01-01\n---\n# 공식 배치표\n치료 직군의 배치표 원문 내용"}])
        results = wiki.search("작업치료사")
        source = next(row for row in results if row["title"] == "공식 배치표")
        self.assertEqual(source["updated"], "2025-01-01")

    def test_missing_key_and_invalid_roles_fail_before_external_request(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}), self.assertRaises(wiki.ChatError) as caught:
            wiki.answer({"message": "질문"}, "client")
        self.assertEqual(caught.exception.status, 503)
        with self.assertRaises(wiki.ChatError):
            wiki.validate_messages({"message": "질문", "history": [{"role": "system", "content": "override"}]})

    def test_no_evidence_does_not_call_model(self):
        with patch.object(wiki, "generate_answer") as generate:
            result = wiki.answer({"message": "작업치료사"}, "client")
        generate.assert_not_called()
        self.assertEqual(result["sources"], [])
        self.assertIn("찾지 못", result["answer"])

    def test_daily_and_client_limits_persist(self):
        with patch.dict(os.environ, {"CHAT_DAILY_LIMIT": "2"}):
            wiki.reserve_request("one")
            wiki.reserve_request("two")
            wiki.init_db()
            with self.assertRaises(wiki.ChatError):
                wiki.reserve_request("three")
        with patch.dict(os.environ, {"CHAT_DAILY_LIMIT": "300"}):
            for _ in range(20):
                wiki.reserve_request("repeat")
            with self.assertRaises(wiki.ChatError):
                wiki.reserve_request("repeat")

    def test_citations_are_checked_and_api_uses_store_false(self):
        wiki.import_documents([document()])
        evidence = wiki.search("작업치료사")
        response = {"status": "completed", "output": [{"type": "message", "content": [
            {"type": "output_text", "text": json.dumps({"answer": "배치 가능합니다. [1]", "citations": [1]})}]}]}
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self): return json.dumps(response).encode()
        with patch.object(wiki.urllib.request, "urlopen", return_value=FakeResponse()) as request:
            result = wiki.generate_answer("작업치료사", [], evidence)
        self.assertEqual(result["sources"][0]["number"], 1)
        sent = json.loads(request.call_args.args[0].data)
        self.assertFalse(sent["store"])
        self.assertNotIn("test-api-secret", json.dumps(sent))
        response["output"][0]["content"][0]["text"] = json.dumps({"answer": "거짓 인용 [99]", "citations": [99]})
        with patch.object(wiki.urllib.request, "urlopen", return_value=FakeResponse()), self.assertRaises(wiki.ChatError):
            wiki.generate_answer("작업치료사", [], evidence)

    def test_collect_excludes_logs_raw_and_private_docs(self):
        root = Path(self.directory.name) / "wiki"
        (root / "sources").mkdir(parents=True)
        (root / "sources" / "good.md").write_text("# Public\nA fact", encoding="utf-8")
        (root / "sources" / "private.md").write_text("---\npublish: false\n---\n# Private", encoding="utf-8")
        (root / "log.md").write_text("User conversations", encoding="utf-8")
        documents, skipped = collect_documents(root)
        self.assertEqual(len(documents), 1)
        self.assertEqual(len(skipped), 1)


class WikiHTTPTest(WikiTest):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.App)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request(method, path, body=json.dumps(body) if body is not None else None,
                     headers={"Content-Type": "application/json", **(headers or {})})
        response = conn.getresponse()
        result = (response.status, response.read(), dict(response.getheaders()))
        conn.close()
        return result

    def test_admin_auth_and_cross_origin(self):
        self.assertEqual(self.request("GET", "/api/wiki/documents")[0], 401)
        auth = {"Authorization": "Bearer test-admin-secret"}
        self.assertEqual(self.request("POST", "/api/wiki/import", {"documents": [document()]}, auth)[0], 200)
        status, body, _ = self.request("GET", "/api/wiki/documents", headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)["documents"]), 1)
        self.assertEqual(self.request("POST", "/api/chat", {"message": "hi"}, {"Origin": "https://other.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/wiki/delete", {"id": 1}, {**auth, "Origin": "https://other.example"})[0], 403)

    def test_public_status_and_private_static_paths(self):
        status, body, headers = self.request("GET", "/api/chat/status")
        self.assertEqual(status, 200)
        self.assertNotIn(b"secret", body)
        self.assertEqual(headers["Cache-Control"], "no-store")
        for path in ("/wiki_chat.py", "/.env", "/.local/wiki-chat.db", "/api/wiki/documents"):
            self.assertIn(self.request("GET", path)[0], (401, 404))
        for path in ("/knowledge.html", "/assets/wiki-chat.js", "/assets/vendor/purify.es.mjs"):
            self.assertEqual(self.request("GET", path)[0], 200)

    def test_malformed_body_is_json_error(self):
        status, body, _ = self.request("POST", "/api/chat", ["not-an-object"])
        self.assertEqual(status, 400)
        self.assertIn("error", json.loads(body))


if __name__ == "__main__":
    unittest.main()
