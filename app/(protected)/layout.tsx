"use client";

import { DOC_ROUTES } from "@/lib/routes";
import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { isDevelopmentAuthBypassEnabled } from "@/lib/auth/devBypass";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const isLocalDevGenerateBypass =
    isDevelopmentAuthBypassEnabled() &&
    pathname.startsWith(DOC_ROUTES.GENERATE);

  useEffect(() => {
    if (status === "loading") return;
    if (!session && !isLocalDevGenerateBypass) {
      router.push(DOC_ROUTES.AUTH.LOGIN);
    }
  }, [session, status, router, isLocalDevGenerateBypass]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-lg font-medium text-muted-foreground">
          <span className="w-8 h-8 animate-spin rounded-full border-4 border-t-transparent border-muted" />
          Loading...
        </div>
      </div>
    );
  }

  if (!session && !isLocalDevGenerateBypass) {
    return null;
  }

  return <>{children}</>;
}
