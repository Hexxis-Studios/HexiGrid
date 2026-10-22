(function installHexiGridPreferences(scope) {
  const allowedKeys = new Set([
    'hexigrid-theme',
    'hexigrid-motion',
    'hexigrid-compact',
    'hexigrid-sidebar-collapsed',
    'hexigrid-button-sounds',
    'aveniq-theme',
    'aveniq-motion',
    'aveniq-compact',
    'aveniq-button-sounds'
  ]);
  const memory = new Map();

  function getItem(key) {
    if (!allowedKeys.has(key)) return null;
    if (memory.has(key)) return memory.get(key);
    try {
      return scope.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function setItem(key, value) {
    if (!allowedKeys.has(key)) return;
    const storedValue = String(value);
    try {
      scope.localStorage.setItem(key, storedValue);
      memory.delete(key);
    } catch {
      memory.set(key, storedValue);
    }
  }

  scope.HexiGridPreferences = Object.freeze({ getItem, setItem });
})(typeof window !== 'undefined' ? window : globalThis);
