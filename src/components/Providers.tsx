"use client";

import { MotionConfig } from "motion/react";
import { EngineProvider } from "@/components/engine/EngineProvider";
import { SessionProvider } from "@/components/session/SessionProvider";
import { AppShell } from "@/components/shell/AppShell";

export function Providers({ children }: { readonly children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SessionProvider>
        <EngineProvider>
          <AppShell>{children}</AppShell>
        </EngineProvider>
      </SessionProvider>
    </MotionConfig>
  );
}
