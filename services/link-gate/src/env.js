const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SERVER_B_URL',
];

const DEFAULT_FORWARD_TIMEOUT_MS = 65000;

function normalizeForwardTimeoutMs(value) {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_FORWARD_TIMEOUT_MS;
  }

  return Math.floor(parsedValue);
}

export function validateEnv(vars) {
  const missing = REQUIRED.filter((name) => !vars[name]);
  const envError =
    missing.length > 0
      ? `Configuration error: ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } not set`
      : null;

  return {
    envError,
    env: {
      SUPABASE_URL: vars.SUPABASE_URL,
      SUPABASE_ANON_KEY: vars.SUPABASE_ANON_KEY,
      SERVER_B_URL: vars.SERVER_B_URL,
      FORWARD_TIMEOUT_MS: normalizeForwardTimeoutMs(vars.FORWARD_TIMEOUT_MS),
    },
  };
}

const result = validateEnv(process.env);

export const envError = result.envError;
export const env = result.env;
