/**
 * TEMPORARY LOCAL DEVELOPMENT AUTH BYPASS
 * Remove this file and all imports once real local auth/OAuth is configured.
 */
export const DEV_BYPASS_USER = {
  email: "test@local.dev",
  username: "localtest",
  password: "local-dev-auth-bypass",
};

export function isDevelopmentAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

