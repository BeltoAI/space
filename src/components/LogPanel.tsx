import { useEffect, useRef, useState } from 'react';
import { log, type LogEntry } from '../lib/logs';

const MAX_ENTRIES = 250;

export default function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = log.subscribe(e => {
      setEntries(prev => {
        const next = [...prev, e];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    });
    return () => {
      unsub();
    };
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);

  return (
    <div className="h-full flex flex-col bg-panel border border-border rounded-xl overflow-hidden shadow-panel">
      <div className="px-4 py-3 border-b border-border bg-panel2/50 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-ok live-pulse" />
          <div className="text-[10px] text-muted uppercase tracking-widest3 font-medium">
            Edge processing log
          </div>
        </div>
        <button
          onClick={() => setEntries([])}
          className="text-[10px] text-muted hover:text-text uppercase tracking-widest2 transition"
        >
          clear
        </button>
      </div>
      <div ref={ref} className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-relaxed">
        {entries.length === 0 ? (
          <div className="text-muted italic">awaiting input…</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-muted shrink-0 select-none opacity-60">{e.ts}</span>
              <span
                className={
                  e.level === 'critical'
                    ? 'text-critical'
                    : e.level === 'warn'
                    ? 'text-warn'
                    : e.level === 'ok'
                    ? 'text-ok'
                    : 'text-text'
                }
              >
                {e.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
