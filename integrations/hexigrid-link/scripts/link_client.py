#!/usr/bin/env python3
"""Signed standard-library client for a user-owned HexiGrid Link."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

CONFIG_DIR = Path.home() / ".hexigrid-link"
VAULT_DIR = CONFIG_DIR / "vault"
# The Link protocol has no scoped file endpoint yet. Do not advertise a
# capability that a paired agent cannot actually exercise.
CAPABILITIES = ["messages", "status", "receipts", "cognition", "identity", "token-metering", "continuity-export", "memory-read", "memory-write", "vision", "voice", "tasks", "harness-jobs", "desktop-view", "desktop-control", "camera-view", "microphone-listen", "speaker-output", "hexispace-profile", "hexispace-posts", "hexispace-comments", "hexispace-friends", "hexispace-relationships", "hexispace-reactions"]
TRANSIENT_HTTP_CODES = {408, 425, 429, 500, 502, 503, 504}


def stable(value) -> str:
    if isinstance(value, list):
        return "[" + ",".join(stable(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(key, ensure_ascii=False, separators=(",", ":")) + ":" + stable(value[key]) for key in sorted(value)) + "}"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def digest(value) -> str:
    return b64url(hashlib.sha256(stable(value).encode("utf-8")).digest())


def signature(token: str, method: str, pathname: str, stamp: str, nonce: str, payload) -> str:
    message = f"{method.upper()}\n{pathname}\n{stamp}\n{nonce}\n{digest(payload)}"
    return b64url(hmac.new(token.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest())


def request(origin: str, pathname: str, method: str = "GET", token: str | None = None, payload=None, query: str = "") -> dict:
    """Send a signed request with bounded retry and fresh nonce per attempt.

    Retries are limited to transport failures and server overload responses. A
    stable client message/job ID makes explicitly retried POST operations
    idempotent at the HexiGrid endpoint.
    """
    for attempt in range(4):
        headers = {"accept": "application/json"}; data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["content-type"] = "application/json"
        if token:
            stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()); nonce = str(uuid.uuid4())
            headers.update({"authorization": f"Bearer {token}", "x-hexigrid-timestamp": stamp, "x-hexigrid-nonce": nonce, "x-hexigrid-signature": signature(token, method, pathname, stamp, nonce, payload)})
        req = urllib.request.Request(origin + pathname + query, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=35) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try: message = json.loads(error.read().decode("utf-8")).get("error")
            except Exception: message = None
            if error.code in TRANSIENT_HTTP_CODES and attempt < 3:
                time.sleep(min(8, 0.5 * (2 ** attempt)))
                continue
            raise RuntimeError(message or f"HexiGrid returned HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt < 3:
                time.sleep(min(8, 0.5 * (2 ** attempt)))
                continue
            raise RuntimeError(f"HexiGrid connection failed after retries: {error.reason if hasattr(error, 'reason') else error}") from None


def config_path(connection: str) -> Path:
    if not connection.startswith("link-") or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-" for char in connection):
        raise RuntimeError("Invalid connection ID")
    return CONFIG_DIR / f"{connection}.json"


def save_config(record: dict) -> None:
    CONFIG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = config_path(record["connectionId"]); target.write_text(json.dumps(record, indent=2), encoding="utf-8")
    try: os.chmod(target, 0o600)
    except OSError: pass


def load_config(connection: str) -> dict:
    return json.loads(config_path(connection).read_text(encoding="utf-8"))


def record_origin(record: dict) -> str:
    return str(record.get("origin") or record.get("baseUrl") or "").rstrip("/")


def record_alias(record: dict) -> str:
    return str(record.get("tokenAlias") or record.get("secretAlias") or "")


def vault_path(alias: str) -> Path:
    safe = "".join(char if char.isalnum() or char in "._-" else "_" for char in alias)
    return VAULT_DIR / safe


def secret_cli(*args: str, stdin: str | None = None) -> str:
    try: completed = subprocess.run(["ilands", "secret", *args], input=stdin, text=True, capture_output=True, check=False)
    except FileNotFoundError: raise RuntimeError("The protected iLands secret command is unavailable; use HexiGrid's browser pairing fallback") from None
    if completed.returncode != 0: raise RuntimeError(completed.stderr.strip() or "The protected iLands secret command failed")
    return completed.stdout.strip()


def extract_secret(value):
    if isinstance(value, str) and len(value) >= 32: return value
    if isinstance(value, dict):
        for item in value.values():
            found = extract_secret(item)
            if found: return found
    return None


def get_token(alias: str) -> str:
    try:
        raw = secret_cli("get", f"--alias={alias}")
        try: token = extract_secret(json.loads(raw))
        except json.JSONDecodeError: token = raw if len(raw) >= 32 else None
    except RuntimeError as primary:
        target = vault_path(alias)
        try:
            if os.name != "nt" and target.stat().st_mode & 0o077:
                raise RuntimeError("The fallback token file permissions are not private")
            token = target.read_text(encoding="utf-8").strip()
        except (OSError, RuntimeError) as fallback:
            raise RuntimeError(f"{primary}. {fallback}") from None
    if not token: raise RuntimeError("The HexiGrid Link token is unavailable in the protected secret store")
    return token


def save_token(alias: str, token: str) -> None:
    try:
        secret_cli("put", f"--alias={alias}", "--value-from=-", "--kind=HexiGrid Link token", "--usage-hint=Use only with the paired HexiGrid origin", stdin=token)
    except RuntimeError:
        VAULT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = vault_path(alias); target.write_text(token, encoding="utf-8")
        try: os.chmod(target, 0o600)
        except OSError: pass


def context(connection: str):
    record = load_config(connection)
    if record.get("mode") == "outbound-companion":
        raise RuntimeError(
            "This Link uses the outbound companion transport. Run the same command with "
            "node scripts/companion_client.mjs; the public relay intentionally does not expose "
            "the direct-HTTPS /agent-link/v1 routes."
        )
    return record, get_token(record_alias(record))


def pair(args) -> None:
    parsed = urllib.parse.urlparse(args.invite)
    if parsed.scheme not in ("https", "http") or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1")):
        raise RuntimeError("The invitation must use HTTPS except on the same computer")
    invite_id = urllib.parse.parse_qs(parsed.query).get("invite", [""])[0]; invite_secret = urllib.parse.parse_qs(parsed.fragment).get("secret", [""])[0]
    if not invite_id or not invite_secret: raise RuntimeError("The invitation is incomplete")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    client_device_id = f"companion-device-{uuid.uuid4()}"
    result = request(origin, "/agent-link/v1/pair", "POST", payload={"inviteId": invite_id, "secret": invite_secret, "clientDeviceId": client_device_id, "identity": {"name": args.name, "framework": "ilands", "externalId": args.external_id, "version": "skill-1"}, "capabilities": CAPABILITIES})
    connection = result["connection"]; token = result["token"]; alias = f"hexigrid-link-{connection['id']}"
    save_token(alias, token)
    save_config({"mode": "direct-https", "connectionId": connection["id"], "origin": origin, "tokenAlias": alias, "clientDeviceId": client_device_id, "lastSequence": 0, "capabilities": connection["capabilities"]})
    print(json.dumps({"ok": True, "connectionId": connection["id"], "capabilities": connection["capabilities"], "orientation": result.get("orientation")}))


def orientation(args) -> None:
    record, token = context(args.connection)
    print(json.dumps({"ok": True, "result": request(record_origin(record), "/agent-link/v1/orientation", "GET", token)}))


def events(args) -> None:
    if args.after is not None and (args.after < 0 or args.after > 9007199254740991):
        raise RuntimeError("--after must be a nonnegative safe integer")
    if args.wait_ms < 0 or args.wait_ms > 25000:
        raise RuntimeError("--wait-ms must be an integer from 0 to 25000")
    record, token = context(args.connection)
    result = request(record_origin(record), "/agent-link/v1/events/poll", "POST", token,
                     {"after": args.after if args.after is not None else int(record.get("lastSequence", 0)), "waitMs": args.wait_ms})
    print(json.dumps({"ok": True, "result": result}))


def listen(args) -> None:
    record, token = context(args.connection); deadline = time.monotonic() + max(1, min(args.timeout, 55))
    while time.monotonic() < deadline:
        try:
            request(record_origin(record), "/agent-link/v1/heartbeat", "POST", token, {"transport": "https", "clientDeviceId": record.get("clientDeviceId", ""), "afterAudioSequence": record.get("lastAudioSequence", 0), "afterSpeakerSequence": record.get("lastSpeakerSequence", 0)})
            result = request(record_origin(record), "/agent-link/v1/events/poll", "POST", token, {"after": int(record.get("lastSequence", 0)), "waitMs": min(20000, max(1000, int((deadline - time.monotonic()) * 1000)))})
            events = result.get("events", [])
            if events:
                through = max(int(item["sequence"]) for item in events)
                request(record_origin(record), "/agent-link/v1/ack", "POST", token, {"through": through})
                record["lastSequence"] = through; save_config(record); print(json.dumps({"ok": True, "events": events})); return
        except RuntimeError:
            if time.monotonic() >= deadline: raise
        time.sleep(1)
    print(json.dumps({"ok": True, "events": [], "timedOut": True}))


def post_command(args, endpoint: str, payload: dict) -> None:
    record, token = context(args.connection); result = request(record_origin(record), endpoint, "POST", token, payload)
    if result.get("jsonrpc") == "2.0" and result.get("error"):
        raise RuntimeError(result["error"].get("message") or "The private memory tool failed")
    print(json.dumps({"ok": True, "result": result}))


def send(args) -> None:
    post_command(args, "/agent-link/v1/messages", {"clientMessageId": f"msg-{uuid.uuid4()}", "type": "message", "text": args.text})


def history(args) -> None:
    post_command(args, "/agent-link/v1/messages/history", {"limit": args.limit, **({"before": args.before} if args.before else {})})


def memory_shares(args) -> None:
    post_command(args, "/agent-link/v1/shared-memory", {"operation": "list", "limit": args.limit, **({"after": args.after} if args.after else {})})


def memory_shared_context(args) -> None:
    post_command(args, "/agent-link/v1/shared-memory", {"operation": "recall", "shareId": args.share, "maxBytes": args.max_bytes,
        **({"cursor": args.cursor} if args.cursor else {})})


def memory_feedback(args) -> None:
    try:
        retrieval_id = str(uuid.UUID(args.retrieval))
    except (ValueError, AttributeError):
        raise RuntimeError("Retrieval ID is invalid") from None
    if retrieval_id != args.retrieval.lower(): raise RuntimeError("Retrieval ID is invalid")
    useful_ids = []
    if args.useful:
        useful_ids = [value.strip() for value in args.useful.split(",")]
    if len(useful_ids) > 100: raise RuntimeError("Useful memory IDs must contain at most 100 IDs")
    for value in useful_ids:
        if not value.lower().startswith("memory-"): raise RuntimeError("Useful memory ID is invalid")
        try: normalized = str(uuid.UUID(value[7:]))
        except ValueError: raise RuntimeError("Useful memory ID is invalid") from None
        if value[7:].lower() != normalized: raise RuntimeError("Useful memory ID is invalid")
    post_command(args, "/agent-link/v1/memory-mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "record-retrieval-feedback", "arguments": {"retrievalId": retrieval_id,
        "usefulIds": list(dict.fromkeys(value.lower() for value in useful_ids))}}})


def skill_write(args) -> None:
    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if not isinstance(payload, dict): raise RuntimeError("Skill request must be a JSON object")
    payload["operation"] = args.command.removeprefix("skill-")
    post_command(args, "/agent-link/v1/skills", payload)


def tasks(args) -> None:
    payload = {"operation": "list", "limit": args.limit}
    if args.after: payload["after"] = args.after
    post_command(args, "/agent-link/v1/tasks", payload)


def task_action(args) -> None:
    payload = json.loads(Path(args.file).read_text(encoding="utf-8")) if getattr(args, "file", None) else {"taskId": args.id}
    if not isinstance(payload, dict): raise RuntimeError("Task request must be a JSON object")
    payload["operation"] = args.command.removeprefix("task-")
    post_command(args, "/agent-link/v1/tasks", payload)


def skills(args) -> None:
    if not 1 <= args.limit <= 20: raise RuntimeError("Skill page limit must be 1 to 20")
    post_command(args, "/agent-link/v1/skills", {"operation": "list", "limit": args.limit,
        **({"after": args.after} if args.after else {})})


def skill(args) -> None:
    if args.before_revision is not None and args.depth != 1: raise RuntimeError("--before-revision requires --depth 1")
    if args.before_revision is not None and args.before_revision < 1: raise RuntimeError("Skill revision cursor must be a positive integer")
    if args.limit is not None and not 1 <= args.limit <= 20: raise RuntimeError("Skill page limit must be 1 to 20")
    post_command(args, "/agent-link/v1/skills", {"operation": "get", "skillId": args.id, "depth": args.depth,
        **({"beforeRevision": args.before_revision} if args.before_revision else {}),
        **({"limit": args.limit} if args.limit is not None else {})})


def ask(args) -> None:
    post_command(args, "/agent-link/v1/cognition", {"clientMessageId": f"cognition-{uuid.uuid4()}", "content": args.text})


def harness(args) -> None:
    post_command(args, "/agent-link/v1/harness-jobs", {"clientJobId": f"job-{uuid.uuid4()}", "prompt": args.text, "approved": args.approved})


def job(args) -> None:
    record, token = context(args.connection)
    result = request(record_origin(record), f"/agent-link/v1/harness-jobs/{urllib.parse.quote(args.job_id, safe='')}", token=token)
    print(json.dumps({"ok": True, "result": result}))


def cancel_job(args) -> None:
    post_command(args, f"/agent-link/v1/harness-jobs/{urllib.parse.quote(args.job_id, safe='')}/cancel", {})


def identity(args) -> None:
    post_command(args, "/agent-link/v1/identity", {"identity": json.loads(Path(args.file).read_text(encoding="utf-8"))})


def tokens(args) -> None:
    post_command(args, "/agent-link/v1/tokens", {"origin": args.origin, "before": args.before, "after": args.after, "unit": args.unit, "note": args.note})


def continuity(args) -> None:
    post_command(args, "/agent-link/v1/continuity", json.loads(Path(args.file).read_text(encoding="utf-8")))


def continuity_request(args) -> None:
    post_command(args, "/agent-link/v1/continuity/export-request", {})


def continuity_request_status(args) -> None:
    record, token = context(args.connection)
    request_id = urllib.parse.quote(args.request_id, safe="")
    result = request(record_origin(record), f"/agent-link/v1/continuity/export-request/{request_id}", token=token)
    print(json.dumps({"ok": True, "result": result}))


def desktop_frame(args) -> None:
    record, token = context(args.connection)
    result = request(record_origin(record), "/agent-link/v1/desktop/frame", token=token)
    if args.output:
        import base64 as _base64
        Path(args.output).write_bytes(_base64.b64decode(result["frame"]["data"]))
        result["frame"].pop("data", None)
        result["frame"]["savedTo"] = args.output
    else:
        result["frame"].pop("data", None)
        result["frame"]["notice"] = "Use --output to save the private frame locally; it is never printed to the terminal."
    print(json.dumps({"ok": True, "result": result}))


def desktop_input(args) -> None:
    try:
        payload = json.loads(args.json)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"The computer action is not valid JSON: {error.msg}") from None
    post_command(args, "/agent-link/v1/desktop/input", {"input": payload})


def desktop_stop(args) -> None:
    post_command(args, "/agent-link/v1/desktop/stop", {})


def desktop_media(args) -> None:
    record, token = context(args.connection)
    result = request(record_origin(record), "/agent-link/v1/desktop/media", "POST", token, {"afterCameraSequence": args.after_camera, "afterAudioSequence": args.after_audio, "afterSpeakerSequence": args.after_speaker})
    if not args.include_data:
        if result.get("camera"):
            result["camera"].pop("data", None)
            result["camera"]["notice"] = "Use --include-data only when the current owner grant allows private media bytes."
        for group in ("video", "audio", "speaker"):
            for segment in result.get(group, []):
                segment.pop("data", None)
                segment["notice"] = "Use --include-data only when the current owner grant allows private media bytes."
    print(json.dumps({"ok": True, "result": result}))


def desktop_speaker(args) -> None:
    try:
        payload = json.loads(args.json)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"The speaker payload is not valid JSON: {error.msg}") from None
    post_command(args, "/agent-link/v1/desktop/speaker", {"mimeType": payload.get("mimeType"), "data": payload.get("data"), "durationMs": payload.get("durationMs", 1000)})


def heartbeat(args) -> None:
    record, token = context(args.connection)
    result = request(record_origin(record), "/agent-link/v1/heartbeat", "POST", token, {"transport": "https", "clientDeviceId": record.get("clientDeviceId", ""), "afterAudioSequence": args.after_audio, "afterSpeakerSequence": args.after_speaker})
    print(json.dumps({"ok": True, "result": result}))


def forget(args) -> None:
    record = load_config(args.connection); secret_cli("revoke", f"--alias={record_alias(record)}"); config_path(args.connection).unlink(missing_ok=True)
    print(json.dumps({"ok": True, "forgotten": args.connection}))


def set_origin(args) -> None:
    parsed = urllib.parse.urlparse(args.origin)
    if parsed.scheme not in ("https", "http") or (parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1")) or not parsed.netloc:
        raise RuntimeError("The new origin must use HTTPS except on the same computer")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise RuntimeError("Enter only the HexiGrid origin, without a path, credentials, query, or fragment")
    record = load_config(args.connection)
    if record.get("mode") == "outbound-companion":
        raise RuntimeError("This Link uses the outbound companion transport. Change its relay origin with node scripts/companion_client.mjs set-origin.")
    record["origin"] = f"{parsed.scheme}://{parsed.netloc}"; record.pop("baseUrl", None); save_config(record)
    print(json.dumps({"ok": True, "connectionId": args.connection, "origin": record["origin"]}))


def avatar_read(args) -> None:
    record, token = context(args.connection)
    result = request(record_origin(record), "/agent-link/v1/avatar", "GET", token)
    print(json.dumps({"ok": True, "result": result}))


def avatar_update(args) -> None:
    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
    if not isinstance(payload, dict): raise RuntimeError("Avatar request must be a JSON object")
    post_command(args, "/agent-link/v1/avatar", payload)


def portrait_read(args) -> None:
    record, token = context(args.connection)
    print(json.dumps({"ok": True, "result": request(record_origin(record), "/agent-link/v1/avatar/portrait", "GET", token)}))


def portrait_update(args) -> None:
    payload = {"animate": not args.still}
    if args.image:
        picture = Path(args.image)
        if picture.stat().st_size > 1_000_000: raise RuntimeError("Choose a portrait smaller than 1 MB")
        mime = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp"}.get(picture.suffix.lower())
        if not mime: raise RuntimeError("Choose PNG, JPEG or WebP")
        payload["imageData"] = "data:image/" + mime + ";base64," + base64.b64encode(picture.read_bytes()).decode("ascii")
    post_command(args, "/agent-link/v1/avatar/portrait", payload)


def main() -> None:
    parser = argparse.ArgumentParser(description="Connect an existing agent to its owner's HexiGrid")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("avatar-portrait-read"); command.add_argument("--connection", required=True); command.set_defaults(run=portrait_read)
    command = commands.add_parser("avatar-portrait"); command.add_argument("--connection", required=True); command.add_argument("--image"); command.add_argument("--still", action="store_true"); command.set_defaults(run=portrait_update)
    command = commands.add_parser("avatar-read"); command.add_argument("--connection", required=True); command.set_defaults(run=avatar_read)
    command = commands.add_parser("avatar-update"); command.add_argument("--connection", required=True); command.add_argument("--file", required=True); command.set_defaults(run=avatar_update)
    command = commands.add_parser("pair"); command.add_argument("--invite", required=True); command.add_argument("--name", required=True); command.add_argument("--external-id", default=""); command.set_defaults(run=pair)
    command = commands.add_parser("listen"); command.add_argument("--connection", required=True); command.add_argument("--timeout", type=int, default=25); command.set_defaults(run=listen)
    command = commands.add_parser("events"); command.add_argument("--connection", required=True); command.add_argument("--after", type=int); command.add_argument("--wait-ms", type=int, default=0); command.set_defaults(run=events)
    command = commands.add_parser("history"); command.add_argument("--connection", required=True); command.add_argument("--before"); command.add_argument("--limit", type=int, default=100); command.set_defaults(run=history)
    command = commands.add_parser("memory-shares"); command.add_argument("--connection", required=True); command.add_argument("--after"); command.add_argument("--limit", type=int, default=10); command.set_defaults(run=memory_shares)
    command = commands.add_parser("memory-shared-context"); command.add_argument("--connection", required=True); command.add_argument("--share", required=True); command.add_argument("--max-bytes", type=int, default=8192); command.add_argument("--cursor"); command.set_defaults(run=memory_shared_context)
    command = commands.add_parser("memory-feedback"); command.add_argument("--connection", required=True); command.add_argument("--retrieval", required=True); command.add_argument("--useful", default="", help="Comma-separated useful memory IDs; omit or pass an empty string for none"); command.set_defaults(run=memory_feedback)
    for name in ("skill-create", "skill-revise", "skill-retire"):
        command = commands.add_parser(name); command.add_argument("--connection", required=True); command.add_argument("--file", required=True); command.set_defaults(run=skill_write)
    command = commands.add_parser("tasks"); command.add_argument("--connection", required=True); command.add_argument("--after"); command.add_argument("--limit", type=int, default=20); command.set_defaults(run=tasks)
    for name in ("task-get", "task-run", "task-cancel"):
        command = commands.add_parser(name); command.add_argument("--connection", required=True); command.add_argument("--id", required=True); command.set_defaults(run=task_action)
    for name in ("task-create", "task-update"):
        command = commands.add_parser(name); command.add_argument("--connection", required=True); command.add_argument("--file", required=True); command.set_defaults(run=task_action)
    command = commands.add_parser("skills"); command.add_argument("--connection", required=True); command.add_argument("--after"); command.add_argument("--limit", type=int, default=10); command.set_defaults(run=skills)
    command = commands.add_parser("skill"); command.add_argument("--connection", required=True); command.add_argument("--id", required=True); command.add_argument("--depth", type=int, choices=(0, 1), default=0); command.add_argument("--before-revision", type=int); command.add_argument("--limit", type=int); command.set_defaults(run=skill)
    for name, runner in (("send", send), ("ask", ask)):
        command = commands.add_parser(name); command.add_argument("--connection", required=True); command.add_argument("--text", required=True); command.set_defaults(run=runner)
    command = commands.add_parser("harness"); command.add_argument("--connection", required=True); command.add_argument("--text", required=True); command.add_argument("--approved", action="store_true", help="Only use when the owner has explicitly approved this run"); command.set_defaults(run=harness)
    command = commands.add_parser("job"); command.add_argument("--connection", required=True); command.add_argument("--job-id", required=True); command.set_defaults(run=job)
    command = commands.add_parser("cancel-job"); command.add_argument("--connection", required=True); command.add_argument("--job-id", required=True); command.set_defaults(run=cancel_job)
    command = commands.add_parser("identity"); command.add_argument("--connection", required=True); command.add_argument("--file", required=True); command.set_defaults(run=identity)
    command = commands.add_parser("tokens"); command.add_argument("--connection", required=True); command.add_argument("--origin", choices=("hexigrid", "ilands"), required=True); command.add_argument("--before", type=float, required=True); command.add_argument("--after", type=float, required=True); command.add_argument("--unit", default="iLands tokens"); command.add_argument("--note", default=""); command.set_defaults(run=tokens)
    command = commands.add_parser("continuity"); command.add_argument("--connection", required=True); command.add_argument("--file", required=True); command.set_defaults(run=continuity)
    command = commands.add_parser("continuity-request"); command.add_argument("--connection", required=True); command.set_defaults(run=continuity_request)
    command = commands.add_parser("continuity-request-status"); command.add_argument("--connection", required=True); command.add_argument("--request-id", required=True); command.set_defaults(run=continuity_request_status)
    command = commands.add_parser("desktop-frame"); command.add_argument("--connection", required=True); command.add_argument("--output", default="", help="Save the private PNG frame locally"); command.set_defaults(run=desktop_frame)
    command = commands.add_parser("desktop-input"); command.add_argument("--connection", required=True); command.add_argument("--json", required=True, help="One validated mouse.move, mouse.click, or key.press action"); command.set_defaults(run=desktop_input)
    command = commands.add_parser("desktop-stop"); command.add_argument("--connection", required=True); command.set_defaults(run=desktop_stop)
    command = commands.add_parser("desktop-media"); command.add_argument("--connection", required=True); command.add_argument("--after-camera", type=int, default=0); command.add_argument("--after-audio", type=int, default=0); command.add_argument("--after-speaker", type=int, default=0); command.add_argument("--include-data", action="store_true", help="Keep private camera/audio bytes in the response"); command.set_defaults(run=desktop_media)
    command = commands.add_parser("desktop-speaker"); command.add_argument("--connection", required=True); command.add_argument("--json", required=True, help="Base64 audio payload with mimeType, data, and optional durationMs"); command.set_defaults(run=desktop_speaker)
    command = commands.add_parser("heartbeat"); command.add_argument("--connection", required=True); command.add_argument("--after-audio", type=int, default=0); command.add_argument("--after-speaker", type=int, default=0); command.set_defaults(run=heartbeat)
    command = commands.add_parser("orientation", aliases=["status"]); command.add_argument("--connection", required=True); command.set_defaults(run=orientation)
    command = commands.add_parser("set-origin"); command.add_argument("--connection", required=True); command.add_argument("--origin", required=True); command.set_defaults(run=set_origin)
    command = commands.add_parser("forget"); command.add_argument("--connection", required=True); command.set_defaults(run=forget)
    args = parser.parse_args()
    try: args.run(args)
    except Exception as error: print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr); raise SystemExit(1)


if __name__ == "__main__": main()
