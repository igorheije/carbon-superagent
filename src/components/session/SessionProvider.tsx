"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { api, type ExecutorAvailability, type ProjectInfo, type PublicSettings, type SessionUser } from "@/lib/client/api";

interface SessionValue {
  readonly user: SessionUser | null;
  readonly settings: PublicSettings | null;
  readonly executors: ExecutorAvailability | null;
  readonly projects: readonly ProjectInfo[];
  readonly activeProject: ProjectInfo | null;
  readonly switchProject: (id: string) => Promise<void>;
  readonly isLoading: boolean;
  readonly refresh: () => Promise<void>;
  readonly logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const PUBLIC_PATHS = ["/login", "/setup"];

export function SessionProvider({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [executors, setExecutors] = useState<ExecutorAvailability | null>(null);
  const [projects, setProjects] = useState<readonly ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isPublic = PUBLIC_PATHS.includes(pathname);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: SessionUser; settings: PublicSettings; executors: ExecutorAvailability; projects: ProjectInfo[]; activeProject: ProjectInfo | null }>("/api/auth/me");
      setProjects(data.projects);
      setActiveProject(data.activeProject);
      setUser(data.user);
      setSettings(data.settings);
      setExecutors(data.executors);
    } catch {
      setUser(null);
      setSettings(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPublic) {
      setIsLoading(false);
      return;
    }
    void refresh();
  }, [isPublic, refresh]);

  const switchProject = useCallback(
    async (id: string) => {
      await api("/api/projects/active", { body: { id } });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    window.location.href = "/login";
  }, []);

  return <SessionContext.Provider value={{ user, settings, executors, projects, activeProject, switchProject, isLoading, refresh, logout }}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
