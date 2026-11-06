#!/usr/bin/env python3
"""Capture a SQLite database (including committed WAL data) without SQL writes."""

import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time


def snapshot(source, target):
    source = Path(source).resolve(strict=True)
    target = Path(target).absolute()
    if not source.is_file():
        raise ValueError("source must be a regular database file")
    if os.path.lexists(target):
        raise FileExistsError("snapshot target already exists")
    # A private, same-filesystem staging directory keeps incomplete databases
    # invisible at TARGET. link() installs the validated bytes without replacing.
    with tempfile.TemporaryDirectory(prefix=".sqlite-capture-", dir=target.parent) as directory:
        staged = Path(directory) / "snapshot.db"
        receipt = capture(source, staged)
        os.link(staged, target)
        parent = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        return receipt


def capture(source, target):
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + 60

        def progress(_status, _remaining, _total):
            if time.monotonic() >= deadline:
                raise TimeoutError("SQLite capture exceeded 60 seconds")

        # immutable=1 would silently omit live WAL pages. mode=ro retains WAL
        # awareness while preventing SQL writes to the source database.
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as reader:
            with closing(sqlite3.connect(str(target))) as writer:
                reader.backup(writer, pages=256, progress=progress, sleep=0.05)
                integrity = writer.execute("PRAGMA integrity_check").fetchall()
                if integrity != [("ok",)]:
                    raise ValueError("snapshot failed SQLite integrity_check")
        os.fsync(fd)
        digest = hashlib.sha256()
        os.lseek(fd, 0, os.SEEK_SET)
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        return {"integrity": "ok", "sha256": digest.hexdigest(), "bytes": os.fstat(fd).st_size}
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("usage: snapshot-sqlite.py SOURCE TARGET")
        print(json.dumps(snapshot(sys.argv[1], sys.argv[2])))
    except (OSError, ValueError, sqlite3.Error, TimeoutError) as error:
        print(f"SQLite snapshot failed: {error}", file=sys.stderr)
        sys.exit(1)
