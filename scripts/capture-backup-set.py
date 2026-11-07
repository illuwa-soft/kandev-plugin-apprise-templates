#!/usr/bin/env python3
"""Capture an explicitly planned local host/plugin set under one bounded lease."""

import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


snapshotter = module("snapshot-sqlite")
verifier = module("verify-backup-set")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError("capture API redirects are forbidden")


def api_client(origin):
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or not parsed.port):
        raise ValueError("explicit loopback HTTP API origin required")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(method, route):
        headers = {"Accept": "application/json"}
        if token := os.environ.get("KANDEV_CAPTURE_TOKEN"):
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(origin.rstrip("/") + route, method=method, headers=headers)
        with opener.open(request, timeout=30) as response:
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError("capture API response too large")
            return json.loads(raw, object_pairs_hook=verifier.unique_object)
    return call


def check_lease(value, expected):
    expires = datetime.datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
    if value["id"] != expected or expires <= datetime.datetime.now(datetime.timezone.utc):
        raise ValueError("capture lease expired or changed")


def copy_pinned(item, output):
    source = Path(item["path"])
    if not source.is_absolute() or source.is_symlink() or not source.is_file():
        raise ValueError("explicit regular source file required")
    if verifier.digest_file(source) != item["sha256"]:
        raise ValueError("capture input does not match its pin")
    with source.open("rb") as reader:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as writer:
            while chunk := reader.read(1024 * 1024):
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
    if verifier.digest_file(source) != item["sha256"] or verifier.digest_file(output) != item["sha256"]:
        raise ValueError("capture input changed while copying")


def capture(plan_path, output):
    plan = json.loads(Path(plan_path).read_text(), object_pairs_hook=verifier.unique_object)
    output = Path(output)
    if plan["schema"] != 1 or not output.is_absolute():
        raise ValueError("unsupported plan or relative output")
    roles = {"host_binary", "plugin_binary", "launcher", "configuration", "plugin_record", "plugin_package"}
    if set(plan["files"]) != roles:
        raise ValueError("all runtime/configuration file roles are required")
    call = api_client(plan["api_base_url"])
    if call("GET", "/health")["version"] != plan["host_version"]:
        raise ValueError("running host does not match the selected version")
    route = "/api/v1/notification-formatters/capture"
    lease = call("POST", route)  # A failed/uncertain acquisition is never retried.
    lease_id = lease["id"]
    scoped = route + "/" + urllib.parse.quote(lease_id, safe="")
    try:
        check_lease(lease, lease_id)
        os.mkdir(output, 0o700)
        files = {}
        for role in ("host_database", "plugin_database"):
            source = Path(plan[role])
            if not source.is_absolute() or source.is_symlink():
                raise ValueError("explicit database source required")
            receipt = snapshotter.snapshot(source, output / (role + ".db"))
            files[role] = {"path": role + ".db", "sha256": receipt["sha256"], "bytes": receipt["bytes"], "source_path": str(source)}
        for role in sorted(roles):
            target = output / role
            copy_pinned(plan["files"][role], target)
            files[role] = {"path": role, "sha256": plan["files"][role]["sha256"], "bytes": target.stat().st_size,
                           "source_mode": Path(plan["files"][role]["path"]).stat().st_mode & 0o777,
                           "source_path": plan["files"][role]["path"]}
        manifest = {key: plan[key] for key in ("schema", "host_version", "plugin_version", "plugin_id", "installation_id")}
        manifest.update(files=files, validator_sha256=plan["files"]["plugin_binary"]["sha256"], capture_lease=lease)
        pending = output / "manifest.pending.json"
        with open(pending, "x", opener=lambda filename, flags: os.open(filename, flags, 0o600)) as writer:
            json.dump(manifest, writer, indent=2)
            writer.flush()
            os.fsync(writer.fileno())
        result = verifier.verify(pending, plan["files"]["plugin_binary"]["path"])
        if result["installation_checked"] is not True:
            raise ValueError("complete capture requires installation reference validation")
        check_lease(call("GET", scoped), lease_id)
    finally:
        # Failure leaves only pending artifacts. Lease release is not retried.
        if call("POST", scoped + "/release").get("released") is not True:
            raise ValueError("capture lease release was not confirmed")
    os.rename(pending, output / "manifest.json")
    for directory in (output, output.parent):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    return result


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("usage: capture-backup-set.py PRIVATE_PLAN NEW_OUTPUT_DIRECTORY")
        print(json.dumps(capture(sys.argv[1], sys.argv[2])))
    except Exception:
        print("Backup capture did not confirm completion; preserve output and reconcile the lease and final manifest before retrying", file=sys.stderr)
        sys.exit(1)
