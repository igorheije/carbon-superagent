interface PanelProps {
  readonly eyebrow: string;
  readonly title?: string;
  readonly aside?: React.ReactNode;
  readonly className?: string;
  readonly children: React.ReactNode;
}

/** Base surface: hairline border, 16px radius, mono eyebrow. */
export function Panel({ eyebrow, title, aside, className = "", children }: PanelProps) {
  return (
    <section data-ascii="surface" className={`card flex min-w-0 flex-col p-4 md:p-5 ${className}`}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {eyebrow}
          </p>
          {title && <h2 className="mt-1 truncate text-[15px] font-medium tracking-[-0.01em]">{title}</h2>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}
