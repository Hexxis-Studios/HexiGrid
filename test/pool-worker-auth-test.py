import asyncio
import importlib.util
import pathlib
import unittest
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('worker_auth', pathlib.Path(__file__).parents[1]/'scripts/pool-worker-auth.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Headers:
 def __init__(self, values): self.values=values
 def getlist(self, name): return self.values if name==m.WORKER_HEADER else []
class TestAuth(unittest.IsolatedAsyncioTestCase):
 async def test_opt_in_enforces_key_without_changing_ordinary_clients(self):
  calls=[]
  async def ordinary(value, *, request=None): calls.append('ordinary');return None
  async def required(value):
   calls.append('required')
   if value!='Bearer synthetic': raise ValueError('missing key')
   return {'assigned_accounts':['synthetic-account']}
  auth=SimpleNamespace(validate_proxy_api_key_authorization=ordinary,validate_required_proxy_api_key_authorization=required,ProxyAuthError=ValueError)
  m.install_worker_auth(auth)
  invoke=auth.validate_proxy_api_key_authorization
  self.assertIsNone(await invoke(None,request=SimpleNamespace(headers=Headers([]))))
  with self.assertRaises(ValueError): await invoke(None,request=SimpleNamespace(headers=Headers(['1'])))
  self.assertEqual(await invoke('Bearer synthetic',request=SimpleNamespace(headers=Headers(['1']))),{'assigned_accounts':['synthetic-account']})
  for values in [['0'],['1','1']]:
   with self.assertRaises(ValueError): await invoke('Bearer synthetic',request=SimpleNamespace(headers=Headers(values)))
  self.assertEqual(calls,['ordinary','required','required'])
if __name__=='__main__':unittest.main()
