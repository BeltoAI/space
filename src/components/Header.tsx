interface Props {
  liveBadge?: string | null;
}

export default function Header({ liveBadge }: Props) {
  return (
    <header className="border-b border-border bg-panel/80 backdrop-blur-sm px-6 py-4 flex items-center gap-6 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-md bg-amber/15 border border-amber/40 flex items-center justify-center">
          <span className="text-amber font-bold text-[14px] tracking-widest2">B</span>
        </div>
        <div>
          <div className="font-semibold text-textHi tracking-widest2 text-[13px] leading-none">BELTO</div>
          <div className="text-[11px] text-muted leading-none mt-1.5">
            edge intelligence for satellites
          </div>
        </div>
      </div>
      <div className="hidden md:block w-px h-9 bg-border" />
      <div className="flex-1 min-w-[280px]">
        <div className="text-textHi text-[15px] leading-snug font-medium">
          The satellite already knows what to send home.
        </div>
        <div className="text-[12px] text-muted leading-tight mt-1">
          Detection · decision · compression — running fully on your laptop.
        </div>
      </div>
      {liveBadge && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-critical/60 bg-critical/10 text-critical text-[11px] font-semibold tracking-widest2 shadow-glowCritical">
          <span className="w-1.5 h-1.5 rounded-full bg-critical live-pulse" />
          {liveBadge}
        </div>
      )}
    </header>
  );
}
