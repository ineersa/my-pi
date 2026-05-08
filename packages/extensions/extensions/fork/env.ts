const PI_OFFLINE_ENV = "PI_OFFLINE";

function defineEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
): void {
  Object.defineProperty(env, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function buildChildEnv(
  environment: Record<string, string> = {},
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    defineEnvValue(env, key, value);
  }
  for (const [key, value] of Object.entries(environment)) {
    defineEnvValue(env, key, value);
  }
  defineEnvValue(env, PI_OFFLINE_ENV, "1");
  defineEnvValue(env, "PI_FORK", "1");
  return env;
}
