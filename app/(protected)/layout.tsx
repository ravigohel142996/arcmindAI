"use client";

import { DOC_ROUTES } from "@/lib/routes";
import { SessionProvider, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  DEV_BYPASS_SESSION,
  isDevelopmentAuthBypassEnabled,
} from "@/lib/auth/devBypass";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isLocalDevAuthBypass = isDevelopmentAuthBypassEnabled();
  const effectiveSession =
    session ?? (isLocalDevAuthBypass ? DEV_BYPASS_SESSION : null);

  useEffect(() => {
    if (status === "loading" || isLocalDevAuthBypass) return;
    if (!effectiveSession) {
      router.push(DOC_ROUTES.AUTH.LOGIN);
    }
  }, [effectiveSession, status, router, isLocalDevAuthBypass]);

  if (status === "loading" && !isLocalDevAuthBypass) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-lg font-medium text-muted-foreground">
          <span className="w-8 h-8 animate-spin rounded-full border-4 border-t-transparent border-muted" />
          Loading...
        </div>
      </div>
    );
  }

  if (!effectiveSession) {
    return null;
  }

  if (isLocalDevAuthBypass && !session) {
    return <SessionProvider session={DEV_BYPASS_SESSION}>{children}</SessionProvider>;
  }

  return <>{children}</>;
}
