#!/usr/bin/env python3
"""Verify offline backup bytes and host-to-plugin revision closure, without restore."""

from contextlib import ExitStack, closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def digest_file(filename):
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def checked_file(root, item):
    relative = Path(item["path"])
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("backup path must stay inside its directory")
    filename = root / relative
    if filename.is_symlink() or not filename.is_file():
        raise ValueError("backup entry must be a regular file")
    filename = filename.resolve(strict=True)
    if not filename.is_relative_to(root):
        raise ValueError("backup entry escapes its directory")
    if filename.stat().st_size != item["bytes"] or digest_file(filename) != item["sha256"]:
        raise ValueError("backup entry size or digest mismatch")
    return filename


def open_snapshot(stack, filename):
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(filename) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            raise ValueError("offline snapshot has SQLite sidecars")
    database = stack.enter_context(closing(sqlite3.connect(filename.as_uri() + "?mode=ro&immutable=1", uri=True)))
    if database.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("backup database failed integrity_check")
    return database


def verify_bindings(host, plugin, manifest):
    if plugin.execute("PRAGMA user_version").fetchone() != (1,):
        raise ValueError("unsupported plugin database schema")
    rows = host.execute("""SELECT b.provider_id, b.provider_type, b.plugin_id,
        b.installation_id, b.formatter_key, b.configuration_revision, b.digest,
        p.user_id, p.type FROM notification_formatter_bindings b
        LEFT JOIN notification_providers p ON p.id=b.provider_id
        WHERE b.plugin_id<>''""").fetchall()
    for provider, kind, plugin_id, installation, key, revision, digest, owner, provider_type in rows:
        if (plugin_id != manifest["plugin_id"] or installation != manifest["installation_id"]
                or key != "apprise-text" or kind != "apprise" or provider_type != kind or not owner):
            raise ValueError("unsupported or mismatched formatter binding")
        snapshots = plugin.execute("""SELECT digest, configuration FROM snapshots
            WHERE owner_id=? AND provider_id=? AND revision=?""", (owner, provider, revision)).fetchall()
        if len(snapshots) != 1:
            raise ValueError("backup is missing an owned referenced revision")
        stored_digest, raw = snapshots[0]
        if stored_digest != digest or hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest:
            raise ValueError("referenced configuration digest mismatch")
        configuration = json.loads(raw, object_pairs_hook=unique_object)
        if configuration.get("version") != 1:
            raise ValueError("unsupported referenced configuration version")
    return len(rows)


def verify(manifest_path, validator):
    manifest_path = Path(manifest_path).resolve(strict=True)
    manifest_digest = digest_file(manifest_path)
    manifest = json.loads(manifest_path.read_text(), object_pairs_hook=unique_object)
    if manifest["schema"] != 1 or manifest["plugin_id"] != "kandev-plugin-apprise-templates":
        raise ValueError("unsupported backup manifest")
    for key in ("host_version", "plugin_version", "installation_id"):
        if not isinstance(manifest[key], str) or not manifest[key]:
            raise ValueError("missing backup identity")
    files = {key: checked_file(manifest_path.parent, item) for key, item in manifest["files"].items()}
    validator = Path(validator)
    if not validator.is_absolute() or digest_file(validator) != manifest["validator_sha256"]:
        raise ValueError("explicit runtime validator does not match its pin")
    arguments = [str(validator), "--verify-offline-store", str(files["plugin_database"])]
    installation_checked = "plugin_record" in files
    if installation_checked:
        if manifest["files"]["plugin_binary"]["sha256"] != manifest["validator_sha256"]:
            raise ValueError("runtime validator and backup executable pins differ")
        arguments.append(str(manifest_path))
    subprocess.run(arguments,
                   check=True, capture_output=True, timeout=60)
    if len(set(files.values())) != len(files):
        raise ValueError("backup roles must reference distinct files")
    with ExitStack() as stack:
        host = open_snapshot(stack, files["host_database"])
        plugin = open_snapshot(stack, files["plugin_database"])
        count = verify_bindings(host, plugin, manifest)
    # Fail if another process changed either source while it was inspected.
    for item in manifest["files"].values():
        checked_file(manifest_path.parent, item)
    if digest_file(manifest_path) != manifest_digest:
        raise ValueError("backup manifest changed during verification")
    return {"verified_bindings": count, "verified_files": len(files), "manifest_sha256": manifest_digest,
            "installation_checked": installation_checked}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("usage: verify-backup-set.py MANIFEST TRUSTED_VALIDATOR_BINARY")
        print(json.dumps(verify(sys.argv[1], sys.argv[2])))
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError):
        # Private manifests and SQL errors can contain paths or template data.
        print("Backup verification failed; check manifest, file digests, and owned revision closure", file=sys.stderr)
        sys.exit(1)
