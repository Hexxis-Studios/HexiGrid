"""Opt-in worker authentication for the installed local codex-lb engine.
Reuses upstream key/account enforcement; never changes ordinary client auth.
No credentials are stored by this adapter. See docs/MODEL-POOL-INTEGRATION.md.
"""
import argparse
import sys
from pathlib import Path

WORKER_HEADER = 'x-hexigrid-pool-worker'

def install_worker_auth(auth):
    original = auth.validate_proxy_api_key_authorization
    async def validate(authorization, *, request=None):
        values = request.headers.getlist(WORKER_HEADER) if request is not None else []
        if values:
            if values != ['1']:
                raise auth.ProxyAuthError('Invalid worker authentication selector')
            return await auth.validate_required_proxy_api_key_authorization(authorization)
        return await original(authorization, request=request)
    auth.validate_proxy_api_key_authorization = validate

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--port', type=int, default=2455)
    args = parser.parse_args()
    sys.path.insert(0, str(args.upstream.resolve()))
    import app.core.auth.dependencies as auth
    install_worker_auth(auth)
    import uvicorn
    from app.main import app
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='error', access_log=False)
