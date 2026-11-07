"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AsciiReveal } from "ascii-reveal";
import { motion } from "motion/react";
import { Activity, BookOpen, Brain, LogOut, Settings, Sparkles, Stethoscope } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { useSession } from "@/components/session/SessionProvider";
import { PERSONAS } from "@/lib/domain/personas";
import { CommandPalette } from "./CommandPalette";
import { EngineControls } from "./EngineControls";
import { ModeSwitch } from "./ModeSwitch";
import { PendingAlerts } from "./PendingAlerts";
import { PermissionBanner } from "./PermissionBanner";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Mission Control", icon: Activity },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/knowledge", label: "Conhecimento", icon: BookOpen },
  { href: "/learning", label: "Aprendizado", icon: Brain },
  { href: "/integrations", label: "Ambiente", icon: Stethoscope },
  { href: "/settings", label: "Configurações", icon: Settings },
] as const;

const PUBLIC_PATHS = ["/login", "/setup"];

function Wordmark() {
  const { state } = useEngine();
  const isWorking = state.activeTicketId !== null && state.running;
  return (
    <Link href="/" className="flex items-center gap-2 px-2 py-1">
      <span className="relative flex size-2.5">
        {isWorking && (
          <motion.span
            className="absolute inset-0 rounded-full bg-accent"
            animate={{ scale: [1, 2.4], opacity: [0.6, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className="relative size-2.5 rounded-full bg-accent" />
      </span>
      <span className="flex items-baseline gap-1.5 text-[17px] font-semibold tracking-[-0.02em]">
        Carbon
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-accent">SuperAgent</span>
      </span>
    </Link>
  );
}

function NavItem({ href, label, icon: Icon }: (typeof NAV)[number]) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className="relative flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] text-muted transition-colors hover:text-ink"
    >
      {isActive && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-lg border border-line bg-surface-muted"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
        />
      )}
      <Icon className={`relative size-4 ${isActive ? "text-ink" : ""}`} strokeWidth={1.6} />
      <span className={`relative ${isActive ? "text-ink" : ""}`}>{label}</span>
    </Link>
  );
}

function UserCard() {
  const { user, logout } = useSession();
  if (!user) return null;
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-surface p-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink font-mono text-[11px] text-bg">{initials}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{user.name}</p>
        <p className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">
          {PERSONAS[user.persona].label} · {user.role}
        </p>
      </div>
      <button type="button" onClick={() => void logout()} aria-label="Sair" className="rounded-full p-1.5 text-muted transition-colors hover:text-ink">
        <LogOut className="size-3.5" />
      </button>
    </div>
  );
}

export function AppShell({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const { state, mode } = useEngine();
  const { activeProject } = useSession();
  if (PUBLIC_PATHS.includes(pathname)) {
    return (
      <div className="relative min-h-dvh">
        <div aria-hidden className="blueprint pointer-events-none fixed inset-0" />
        <div className="relative">{children}</div>
      </div>
    );
  }
  return (
    <div className="relative min-h-dvh">
      <div aria-hidden className="blueprint pointer-events-none fixed inset-0" />
      <div className="relative flex min-h-dvh flex-col md:flex-row">
        <aside className="flex shrink-0 flex-row items-center gap-1 border-b border-line bg-bg/80 px-3 py-2 backdrop-blur-md md:sticky md:top-0 md:h-dvh md:w-60 md:flex-col md:items-stretch md:border-b-0 md:border-r md:px-3 md:py-5">
          <Wordmark />
          <nav aria-label="Principal" className="scroll-thin flex flex-1 gap-1 overflow-x-auto md:mt-6 md:flex-col md:overflow-visible">
            {NAV.map((item) => (
              <NavItem key={item.href} {...item} />
            ))}
          </nav>
          <div className="hidden flex-col gap-3 md:flex">
            <div className="rounded-xl border border-line bg-surface p-3">
              <p className="eyebrow">Modo de aceite</p>
              <p className="mt-1 font-mono text-[13px]">{state.acceptMode === "observe" ? "[ observe ]" : "[ act ]"}</p>
              <p className="mt-1 text-[12px] leading-snug text-muted">
                {state.acceptMode === "observe" ? "PRs saem como draft. Humano decide." : "PRs prontos. Merge segue humano."}
              </p>
            </div>
            <UserCard />
            <p className="px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-subtle">
              {mode === "demo" ? "modo demo · simulação" : "ao vivo · seu computador"}
            </p>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-line bg-bg/75 px-4 py-2.5 backdrop-blur-md md:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <ProjectSwitcher />
              <EngineControls />
            </div>
            <div className="flex items-center gap-2">
              <PermissionBanner />
              <ModeSwitch />
              <CommandPalette />
              <ThemeToggle />
            </div>
          </header>
          {/* Every navigation decodes the new page in through the ASCII grid. */}
          <AsciiReveal as="main" key={`${pathname}:${activeProject?.id ?? ""}`} revealOnHydrate preset="decode" origin="top-left" className="flex-1 px-4 py-6 md:px-8 md:py-8">
            {children}
          </AsciiReveal>
        </div>
      </div>
      <PendingAlerts />
    </div>
  );
}
