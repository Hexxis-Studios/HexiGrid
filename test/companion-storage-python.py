"""Public synthetic fixtures; no network or real platform vault is used."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import sys
import subprocess
from types import SimpleNamespace

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / "integrations/hexigrid-link/scripts/link_client.py"
spec = importlib.util.spec_from_file_location("hexigrid_link", source)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
native_secret_cli = client.secret_cli
token = "p" * 43
assert client.alias_label('link-11111111-2222-4333-8444-555555555555') == 'he.in.of.an.an.if.me.my.of.do.an.is.he.me.is.by.my.is.be.is.an.my.in.it.me.go.it.be.it.no.go.on'
vault = {}
requests = []


def helper(operation, *args, stdin=None):
    alias = next(item[8:] for item in args if item.startswith("--alias="))
    if operation == "put": vault[alias] = stdin; return ""
    if operation == "get":
        if alias not in vault: raise RuntimeError("The platform secret store could not complete the request")
        return json.dumps({"secret": {"value": vault[alias]}})
    if operation == "revoke": vault.pop(alias, None); return ""
    raise AssertionError("Unknown operation")


def request(*args, **kwargs):
    requests.append((args, kwargs))
    return {"connection": {"id": "link-python-qa", "capabilities": ["camera-view"]}, "token": token}


with tempfile.TemporaryDirectory(prefix="hexigrid-python-storage-") as root:
    client.CONFIG_DIR = Path(root) / ".hexigrid-link"
    client.VAULT_DIR = client.CONFIG_DIR / "vault"
    client.secret_cli = helper
    client.request = request
    args = SimpleNamespace(invite="http://127.0.0.1/agent-link/connect?invite=qa#secret=public-fixture", name="QA", framework="custom", external_id="qa", ephemeral=True)
    output = io.StringIO()
    with contextlib.redirect_stdout(output): client.pair(args)
    report = json.loads(output.getvalue())
    assert report["saved"] and report["storage"] == "platform-vault"
    assert token not in output.getvalue()
    diagnostic = io.StringIO()
    with contextlib.redirect_stdout(diagnostic): client.storage_status(SimpleNamespace(connection="link-python-qa"))
    assert json.loads(diagnostic.getvalue())["code"] == "SAVED_CONNECTION_READABLE"
    assert token not in diagnostic.getvalue()
    routing = vault.pop(client.routing_alias("link-python-qa"))
    shutil.rmtree(client.CONFIG_DIR)
    diagnostic = io.StringIO()
    with contextlib.redirect_stdout(diagnostic): client.storage_status(SimpleNamespace(connection="link-python-qa"))
    assert json.loads(diagnostic.getvalue())["code"] == "ROUTING_STORAGE_UNREADABLE"
    vault[client.routing_alias("link-python-qa")] = routing
    client.save_config(json.loads(routing))
    assert requests[0][1]["payload"]["identity"]["framework"] == "custom"
    before = client.load_config("link-python-qa")
    assert token not in (client.CONFIG_DIR / "link-python-qa.json").read_text()
    shutil.rmtree(client.CONFIG_DIR)
    restored, credential = client.context("link-python-qa")
    assert restored == before and credential == token
    assert restored["clientDeviceId"] == before["clientDeviceId"]
    with contextlib.redirect_stdout(io.StringIO()): client.forget(SimpleNamespace(connection="link-python-qa"))
    assert not vault, "forget removes credential and routing, not just a disposable cache"

    def unavailable(*args, **kwargs):
        error = RuntimeError("Unavailable")
        error.store_unavailable = True
        raise error

    client.secret_cli = unavailable
    requests.clear()
    try: client.pair(args)
    except RuntimeError as error: assert "invitation has not been used" in str(error)
    else: raise AssertionError("Ephemeral pairing proceeded without durable storage")
    assert not requests
    args.ephemeral = False
    args.framework = 'iLands'
    try: client.pair(args)
    except RuntimeError as error: assert 'invitation has not been used' in str(error)
    else: raise AssertionError('iLands pairing fell back to disposable files when --ephemeral was omitted')
    assert not requests
    def normalized_helper(operation, *args, stdin=None):
        result = helper(operation, *args, stdin=stdin)
        if operation == 'get':
            value = client.extract_secret_value(result)
            if value.startswith('{'): return json.dumps(dict(reversed(list(json.loads(value).items()))), indent=2)
        return result
    client.secret_cli = normalized_helper
    requests.clear()
    output = io.StringIO()
    with contextlib.redirect_stdout(output): client.pair(args)
    assert json.loads(output.getvalue())['saved'], 'equivalent JSON formatting is not a failed routing save'
    with contextlib.redirect_stdout(io.StringIO()): client.forget(SimpleNamespace(connection='link-python-qa'))
    def broken_routing(operation, *args, stdin=None):
        if operation == 'get' and f'--alias={client.routing_alias("link-python-qa")}' in args: return 'PRIVATE-PROVIDER-DIAGNOSTIC'
        return helper(operation, *args, stdin=stdin)
    client.secret_cli = broken_routing
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try: client.pair(args)
        except SystemExit as error: assert error.code == 1
        else: raise AssertionError('Broken routing save was reported as complete')
    report = json.loads(output.getvalue())
    assert report['code'] == 'ROUTING_SAVE_FAILED' and not report['saved']
    assert 'PRIVATE-PROVIDER-DIAGNOSTIC' not in output.getvalue() and token not in output.getvalue()
    def ilands_envelope(operation, *args, stdin=None):
        alias = next(item[8:] for item in args if item.startswith('--alias='))
        if operation != 'get': return helper(operation, *args, stdin=stdin)
        return json.dumps({'content': [{'type': 'text', 'text': 'Human-readable secret-store summary'}], 'details': {'status': 'retrieved' if alias in vault else 'not_found', 'alias': alias, **({'payload': {'value': vault[alias]}} if alias in vault else {})}})
    client.secret_cli = ilands_envelope
    output = io.StringIO()
    with contextlib.redirect_stdout(output): client.pair(args)
    assert json.loads(output.getvalue())['saved']
    shutil.rmtree(client.CONFIG_DIR)
    restored, credential = client.context('link-python-qa')
    assert credential == token and restored['storage'] == 'platform-vault'
    with contextlib.redirect_stdout(io.StringIO()): client.forget(SimpleNamespace(connection='link-python-qa'))
    for details in ({'status': 'not_found'}, {'status': 'retrieved', 'payload': {'value': None}}, {'status': 'not_found', 'payload': {'value': token}}):
        try: client.extract_secret_value(json.dumps({'content': [{'type': 'text', 'text': token}], 'details': details}))
        except RuntimeError: pass
        else: raise AssertionError('Metadata, display text or negative status was accepted as a credential')
    try: client.extract_secret_value(json.dumps({'isError': True, 'details': {'status': 'retrieved', 'payload': {'value': token}}}))
    except RuntimeError: pass
    else: raise AssertionError('Provider error was accepted as a credential')

    def reject_credential_aliases(operation, *args, stdin=None):
        alias = next(item[8:] for item in args if item.startswith('--alias='))
        if operation == 'put' and client.re.search(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', alias, client.re.I):
            raise RuntimeError('alias must not itself look like a credential')
        return helper(operation, *args, stdin=stdin)
    client.secret_cli = reject_credential_aliases
    output = io.StringIO()
    with contextlib.redirect_stdout(output): client.pair(args)
    assert json.loads(output.getvalue())['saved']
    routing_name = client.routing_alias('link-python-qa')
    record = json.loads(vault[routing_name])
    assert record['tokenAlias'].startswith('hexigrid-link.token.')
    assert len(record['tokenAlias']) <= 128 and len(routing_name) <= 128
    shutil.rmtree(client.CONFIG_DIR)
    assert client.context('link-python-qa')[1] == token
    with contextlib.redirect_stdout(io.StringIO()): client.forget(SimpleNamespace(connection='link-python-qa'))
    assert routing_name not in vault and record['tokenAlias'] not in vault

    client.secret_cli = helper
    legacy = {'connectionId':'link-legacy-qa','tokenAlias':'hexigrid-link-link-legacy-qa','mode':'direct-https','storage':'platform-vault','origin':'https://example.invalid'}
    client.save_token(legacy['tokenAlias'],token,True);client.save_config(legacy)
    shutil.rmtree(client.CONFIG_DIR)
    assert client.context('link-legacy-qa') == (legacy,token)
    with contextlib.redirect_stdout(io.StringIO()): client.forget(SimpleNamespace(connection='link-legacy-qa'))
    assert legacy['tokenAlias'] not in vault and 'hexigrid-link-routing-link-legacy-qa' not in vault

print("Python storage: pair/readback, sandbox reset/resume, provider identity, secret isolation, forget and preflight passed.")

failed = subprocess.run([sys.executable, str(source), 'storage-check', '--ephemeral'], capture_output=True, text=True,
    env={**os.environ, 'HEXIGRID_LINK_SECRET_COMMAND': json.dumps([sys.executable, '-c', "import sys;sys.stderr.write('PRIVATE-PROVIDER-DIAGNOSTIC');sys.exit(7)"])})
assert failed.returncode == 1
report = json.loads(failed.stdout)
assert report['stage'] == 'credential-write' and report['operation'] == 'put' and report['exitCode'] == 7
assert report['code'] == 'SECRET_STORE_OPERATION_FAILED' and not report['invitationUsed']
assert 'PRIVATE-PROVIDER-DIAGNOSTIC' not in failed.stdout + failed.stderr
print('Python CLI: failed protected operation is identified without exposing helper diagnostics.')

previous_command = os.environ.get('HEXIGRID_LINK_SECRET_COMMAND')
os.environ['HEXIGRID_LINK_SECRET_COMMAND'] = json.dumps([sys.executable, '-c', "import sys;sys.stdout.write('PRIVATE-HELPER-OUTPUT');sys.stderr.write('PRIVATE-PROVIDER-DIAGNOSTIC');sys.exit(7)"])
try:
    try: native_secret_cli('put', '--alias=public-disposable-fixture', stdin='public-fixture')
    except RuntimeError as error:
        assert error.provider_diagnostic == {'stdout': 'PRIVATE-HELPER-OUTPUT', 'stderr': 'PRIVATE-PROVIDER-DIAGNOSTIC'}
        assert 'PRIVATE-' not in str(error)
    else: raise AssertionError('Failed helper call was reported as successful')
finally:
    if previous_command is None: os.environ.pop('HEXIGRID_LINK_SECRET_COMMAND', None)
    else: os.environ['HEXIGRID_LINK_SECRET_COMMAND'] = previous_command
print('Python helper: native failure retained in memory for local inspection, not normal output.')
