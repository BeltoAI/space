export type LogLevel = 'info' | 'ok' | 'warn' | 'critical';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
}

class LogStream {
  private listeners: Set<(e: LogEntry) => void> = new Set();
  private start = Date.now();

  subscribe(fn: (e: LogEntry) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private fmtTs() {
    const elapsed = Date.now() - this.start;
    const ms = elapsed % 1000;
    const s = Math.floor(elapsed / 1000) % 60;
    const m = Math.floor(elapsed / 60000) % 60;
    const h = Math.floor(elapsed / 3600000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad3(ms)}`;
  }

  emit(message: string, level: LogLevel = 'info') {
    const entry: LogEntry = { ts: this.fmtTs(), level, message };
    this.listeners.forEach(fn => fn(entry));
  }

  // Back-compat: existing call sites use `await log.streamed(...)`. Keep but
  // remove artificial delay — it was causing multi-second freezes when many
  // emits queued during a stream tick.
  async streamed(message: string, level: LogLevel = 'info', _delayMs = 0) {
    this.emit(message, level);
  }
}

function pad(n: number) { return String(n).padStart(2, '0'); }
function pad3(n: number) { return String(n).padStart(3, '0'); }

export const log = new LogStream();
