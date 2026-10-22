// Keep command output private: search may contain a protected value. Only
// confirmed absence counts as strict cleanup; tool/service errors fail closed.
function cleanupError() {
  const error = new Error('Protected credential cleanup could not be verified. Unlock or repair the operating system credential service and retry.');
  error.code = 'VAULT_CLEANUP_FAILED'; error.status = 503;
  return error;
}

function macAbsent(error) {
  return error?.exitCode === 44 && /^security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain\.$/.test(String(error.stderr || '').trim());
}

export async function removePlatformCredentials(id, { platform, account, run, strict = false }) {
  if (!['linux', 'darwin'].includes(platform)) throw cleanupError();
  for (const brand of ['HexiGrid', 'Aveniq']) {
    if (!strict) {
      const args = platform === 'linux'
        ? ['clear', 'service', brand, 'id', id]
        : ['delete-generic-password', '-a', account || brand, '-s', brand + ':' + id];
      await run(platform === 'linux' ? 'secret-tool' : 'security', args).catch(() => {});
      continue;
    }
    try {
      if (platform === 'linux') {
        try { await run('secret-tool', ['clear', 'service', brand, 'id', id]); }
        catch (error) {
          // libsecret returns 1 without an error for no match; that alone
          // does not establish absence (a locked matching item may remain).
          if (error?.exitCode !== 1 || String(error.stderr || '').trim()) throw cleanupError();
        }
        const remaining = await run('secret-tool', ['search', '--all', 'service', brand, 'id', id]);
        if (remaining.trim()) throw cleanupError();
      } else {
        const selector = ['-a', account || brand, '-s', brand + ':' + id];
        try { await run('security', ['delete-generic-password', ...selector]); }
        catch (error) { if (!macAbsent(error)) throw cleanupError(); }
        // No -w: verification does not request the password itself.
        try { await run('security', ['find-generic-password', ...selector]); }
        catch (error) { if (macAbsent(error)) continue; throw cleanupError(); }
        throw cleanupError();
      }
    } catch { throw cleanupError(); }
  }
}
