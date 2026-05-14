import type { Session } from "next-auth";

/**
 * TEMPORARY LOCAL DEVELOPMENT AUTH BYPASS
 * Remove this file and all imports once real local auth/OAuth is configured.
 */
export const DEV_BYPASS_USER = {
  email: "test@local.dev",
  username: "localtest",
};

type DevBypassSession = Session & {
  user: NonNullable<Session["user"]> & {
    id: string;
    accessToken: string;
  };
};

export const DEV_BYPASS_SESSION: DevBypassSession = {
  user: {
    id: "local-dev-bypass-user",
    email: DEV_BYPASS_USER.email,
    name: DEV_BYPASS_USER.username,
    accessToken: "DEV_BYPASS_ACCESS_TOKEN",
  },
  expires: "2999-12-31T23:59:59.999Z",
};

export function isDevelopmentAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}
