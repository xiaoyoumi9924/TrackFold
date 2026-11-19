const commonVariables = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LANGUAGE",
  "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC", "TZ",
];
const windowsVariables = [
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT",
  "HOMEDRIVE", "HOMEPATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
];

export function mediaProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = process.platform === "win32" ? [...commonVariables, ...windowsVariables] : commonVariables;
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
