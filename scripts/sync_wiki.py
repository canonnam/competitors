#!/usr/bin/env python3
"""Publish a reviewed Markdown wiki to the private Railway knowledge database."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wiki_chat


def collect_documents(root):
    root = root.resolve()
    if not root.is_dir():
        raise ValueError("Wiki directory does not exist")
    documents, skipped = [], []
    for folder in ("sources", "entities", "concepts", "syntheses"):
        for file in sorted((root / folder).rglob("*.md")):
            if file.is_symlink() or not file.resolve().is_relative_to(root):
                raise ValueError("Symlinks outside the wiki cannot be published")
            content = file.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
            metadata = {}
            if content.startswith("---\n"):
                metadata = yaml.safe_load(content.split("\n---", 1)[0][4:]) or {}
            if not isinstance(metadata, dict):
                raise ValueError(f"Invalid YAML metadata: {file.name}")
            if (metadata.get("visibility") == "private" or metadata.get("publish") is False
                    or "internal-manual" in (metadata.get("tags") or [])):
                skipped.append(str(file.relative_to(root)))
                continue
            item = {"path": "wiki/" + file.relative_to(root).as_posix(), "content": content}
            wiki_chat.parse_document(item)
            documents.append(item)
    if not documents:
        raise ValueError("No eligible wiki documents found; refusing an empty sync")
    if len(documents) > wiki_chat.MAX_DOCUMENTS:
        raise ValueError("Too many documents")
    return documents, skipped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki", required=True, type=Path, help="Path to the wiki/ directory, not raw/")
    parser.add_argument("--url", help="Deployed service origin (HTTPS)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--db", type=Path, help="Import into a local DB instead of the service")
    args = parser.parse_args()
    documents, skipped = collect_documents(args.wiki)
    payload = json.dumps({"documents": documents, "replaceWiki": True}, ensure_ascii=False).encode()
    if len(payload) > wiki_chat.MAX_IMPORT_BYTES:
        raise ValueError("Import exceeds 5MB")
    print(json.dumps({"documents": len(documents), "bytes": len(payload), "excluded": skipped}, ensure_ascii=False))
    if args.dry_run:
        return
    if args.db:
        wiki_chat.init_db(args.db)
        result = wiki_chat.import_documents(documents, replace_wiki=True, path=args.db)
    else:
        if not args.url or not args.url.startswith("https://"):
            raise ValueError("A deployed HTTPS --url is required")
        token = os.getenv("CHAT_ADMIN_TOKEN", "")
        if not token:
            raise ValueError("Set CHAT_ADMIN_TOKEN in this process (never pass a key on the command line)")
        request = urllib.request.Request(args.url.rstrip("/") + "/api/wiki/import", data=payload,
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise ValueError(f"Import failed (HTTP {exc.code}); existing knowledge was not replaced") from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, wiki_chat.ChatError, yaml.YAMLError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
