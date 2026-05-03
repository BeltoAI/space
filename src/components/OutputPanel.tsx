import { useState } from 'react';
import type { ProcessingResult, DetectionClass } from '../lib/types';
import { formatBytes } from '../lib/reports';

interface Props {
  result: ProcessingResult | null;
  busy: boolean;
  liveTag?: string | null;
}

const CLASS_COLORS: Record<DetectionClass, string> = {
  fire: '#ff3b1c',
  cloud: '#22d3ee',
  water: '#fbbf24',
  vegetation: '#84cc16',
  terrain: '#a78bfa'
};

export default function OutputPanel({ result, busy, liveTag }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const [showJson, setShowJson] = useState(false);

  if (!result) {
    return (
      <div className="h-full bg-panel border border-border rounded-xl flex items-center justify-center shadow-panel">
        <div className="text-center px-8 max-w-sm">
          {busy ? (
            <>
              <div className="text-amber font-semibold tracking-widest2 text-[12px] mb-3 uppercase">processing on edge</div>
              <div className="h-1 bg-border/40 rounded overflow-hidden">
                <div className="h-full shimmer" />
              </div>
            </>
          ) : (
            <>
              <div className="text-textHi font-semibold tracking-widest2 text-[13px] mb-2 uppercase">
                Select a source
              </div>
              <div className="text-muted text-[13px] leading-relaxed">
                Try <span className="text-amber font-medium">GO LIVE</span> for the camera demo, or pick a sample tile.
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const { rule, payload, reportMd, detectionOverlayUrl, detections } = result;
  const isCritical = rule.priority === 'CRITICAL';
  const isHigh = rule.priority === 'HIGH';

  const priorityClasses =
    isCritical
      ? { wrap: 'border-critical/70 bg-critical/15 shadow-glowCritical', strip: 'bg-critical' }
      : isHigh
      ? { wrap: 'border-warn/70 bg-warn/10', strip: 'bg-warn' }
      : rule.priority === 'WARNING'
      ? { wrap: 'border-warn/40 bg-warn/5', strip: 'bg-warn/60' }
      : { wrap: 'border-border bg-panel2', strip: 'bg-border' };

  function download(filename: string, content: string, type = 'text/plain') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const HIDDEN_CLASSES = new Set(['terrain', 'vegetation']);
  const byClass = detections
    .filter(d => !HIDDEN_CLASSES.has(d.cls))
    .reduce<Record<string, number>>((acc, d) => {
      acc[d.cls] = (acc[d.cls] ?? 0) + 1;
      return acc;
    }, {});

  const savedPct = (payload.compression_ratio * 100).toFixed(1);
  const heroColor = isCritical ? 'text-critical' : isHigh ? 'text-warn' : 'text-amber';

  return (
    <div className="h-full flex flex-col bg-panel border border-border rounded-xl overflow-hidden shadow-panel">
      <div className="flex-1 overflow-auto">
        {detectionOverlayUrl && (
          <div className="relative border-b border-border bg-black flex items-center justify-center">
            <div className="w-full" style={{ maxHeight: '420px' }}>
              <img
                src={detectionOverlayUrl}
                alt="detections"
                className="w-full block object-contain"
                style={{ maxHeight: '420px' }}
              />
            </div>
            {liveTag && (
              <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/85 border border-critical/70 text-critical text-[10px] font-semibold tracking-widest2 backdrop-blur-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-critical live-pulse" />
                {liveTag}
              </div>
            )}
          </div>
        )}

        <div className="p-5 flex flex-col gap-5">
          <div className={`relative rounded-lg border ${priorityClasses.wrap} overflow-hidden`}>
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${priorityClasses.strip}`} />
            <div className="pl-5 pr-4 py-3.5">
              <div className="text-[10px] tracking-widest3 opacity-80 uppercase font-medium">
                {rule.priority} · {rule.rule}
              </div>
              <div className={`text-[16px] font-semibold tracking-tight mt-1 leading-tight ${
                isCritical ? 'text-critical' : isHigh ? 'text-warn' : 'text-textHi'
              }`}>
                {rule.action}
              </div>
            </div>
          </div>

          {/* Scene classification (when EuroSAT model is loaded, satellite/upload mode) */}
          {result.scene && result.sourceMode !== 'webcam' && (
            <div className="rounded-lg border border-border bg-panel2 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-muted uppercase tracking-widest3 font-medium">
                  EuroSAT scene class
                </div>
                <div className="text-[10px] text-muted tnum">
                  {result.scene.inferenceMs.toFixed(0)} ms
                </div>
              </div>
              <div className="text-textHi text-[15px] font-semibold mt-1 tracking-tight">
                {result.scene.topClass}
                <span className="text-muted text-[12px] font-normal ml-2 tnum">
                  conf {result.scene.confidence.toFixed(2)}
                </span>
              </div>
              <div className="flex gap-2 mt-2">
                {result.scene.top3.map((t, i) => (
                  <div
                    key={t.cls}
                    className={`flex-1 rounded px-2 py-1.5 ${
                      i === 0 ? 'bg-amber/10 border border-amber/40' : 'bg-bg border border-border'
                    }`}
                  >
                    <div className={`text-[10px] tracking-wider uppercase ${i === 0 ? 'text-amber' : 'text-muted'}`}>
                      {t.cls}
                    </div>
                    <div className="text-[12px] text-text font-medium tnum">
                      {(t.prob * 100).toFixed(1)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Edge node telemetry — only in webcam mode. This is the actual "wow":
              real-time CNN inference + change detection running on the laptop. */}
          {result.sourceMode === 'webcam' && (
            <div className="rounded-lg border border-amber/40 bg-amber/5 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber live-pulse" />
                <div className="text-[10px] text-amber uppercase tracking-widest3 font-medium">
                  edge node · laptop sensor active
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-widest2">cnn inference</div>
                  <div className="text-textHi text-[15px] font-semibold tnum mt-0.5">
                    {result.inferenceMs.toFixed(0)}<span className="text-[11px] text-muted ml-0.5">ms</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-widest2">scene Δ</div>
                  <div className="text-textHi text-[15px] font-semibold tnum mt-0.5">
                    {result.scores.anomaly.toFixed(3)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted uppercase tracking-widest2">activity</div>
                  <div className="text-textHi text-[15px] font-semibold tnum mt-0.5">
                    {result.scores.activity.toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-muted mt-2.5 leading-relaxed">
                ResNet-style CNN running fully in your browser at 1 Hz · zero server calls
              </div>
            </div>
          )}

          {/* Edge processing pipeline — narrative for satellite/upload demo.
              This tells the YC viewer the story: tile → analysis → decision → action */}
          {result.sourceMode !== 'webcam' && (
            <div className="rounded-lg border border-border bg-panel2 px-4 py-3">
              <div className="text-[10px] text-muted uppercase tracking-widest3 font-medium mb-2.5">
                edge processing pipeline
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <PipeStep label="INPUT" sub={formatBytes(result.rawBytes)} active />
                <PipeArrow />
                <PipeStep label="CNN" sub={`${result.inferenceMs.toFixed(0)}ms`} active />
                <PipeArrow />
                <PipeStep label="DECIDE" sub={rule.priority} active highlight={isCritical || isHigh} />
                <PipeArrow />
                <PipeStep
                  label={rule.decision === 'DISCARD_ONBOARD' ? 'DISCARD' : 'DOWNLINK'}
                  sub={rule.decision === 'DISCARD_ONBOARD' ? '0 B' : formatBytes(result.payloadBytes)}
                  active
                  highlight={rule.decision !== 'DISCARD_ONBOARD'}
                />
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border bg-panel2 p-5 text-center">
            <div className={`text-[44px] font-bold ${heroColor} tnum leading-none`}>
              {savedPct}<span className="text-[28px]">%</span>
            </div>
            <div className="text-[10px] text-muted uppercase tracking-widest3 font-medium mt-2">
              {rule.decision === 'DISCARD_ONBOARD' ? 'bandwidth saved by discarding' : 'downlink bandwidth saved'}
            </div>
            <div className="text-[12px] text-muted mt-1.5 tnum">
              {formatBytes(result.rawBytes)} raw → {formatBytes(result.payloadBytes)} payload
            </div>
          </div>

          {Object.keys(byClass).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {Object.entries(byClass).map(([cls, n]) => (
                <span
                  key={cls}
                  className="flex items-center gap-2 px-2.5 py-1 rounded-md border border-border bg-panel2 text-[12px]"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ backgroundColor: CLASS_COLORS[cls as DetectionClass] }}
                  />
                  <span className="uppercase tracking-widest2 text-muted text-[10px] font-medium">{cls}</span>
                  <span className="text-textHi font-semibold tnum">×{n}</span>
                </span>
              ))}
              <span className="ml-auto self-center text-[10px] text-muted tracking-widest2 uppercase">
                {Object.values(byClass).reduce((a, b) => a + b, 0)} mission features
              </span>
            </div>
          ) : (
            <div className="text-[12px] text-muted">no mission-relevant features detected</div>
          )}

          <div className="flex gap-2">
            <DownloadBtn onClick={() => download('belto-payload.json', JSON.stringify(payload, null, 2), 'application/json')}>
              ↓ payload.json
            </DownloadBtn>
            <DownloadBtn onClick={() => download('belto-report.md', reportMd, 'text/markdown')}>
              ↓ report.md
            </DownloadBtn>
          </div>

          <div className="flex flex-col gap-2 pt-1 border-t border-border">
            <Disclosure
              open={showDetails}
              onToggle={() => setShowDetails(s => !s)}
              label="scores · timing"
            >
              <div className="text-[12px] flex flex-col gap-2 pt-1">
                <div className="grid grid-cols-3 gap-x-5 gap-y-1.5 tnum">
                  {(['fire', 'cloud', 'water', 'vegetation', 'terrain', 'activity', 'anomaly'] as const).map(k => (
                    <div key={k} className="flex items-center gap-2">
                      <span className="text-muted uppercase tracking-widest2 w-16 text-[10px]">{k}</span>
                      <span className="ml-auto text-textHi font-medium">{result.scores[k].toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                <div className="text-muted flex gap-4 text-[11px] mt-1.5 tnum">
                  <span>cnn {result.inferenceMs.toFixed(0)}ms</span>
                  <span>spectral {result.spectralMs.toFixed(0)}ms</span>
                  <span>{result.framesProcessed} frame{result.framesProcessed > 1 ? 's' : ''}</span>
                </div>
              </div>
            </Disclosure>

            <Disclosure
              open={showJson}
              onToggle={() => setShowJson(s => !s)}
              label="json payload"
            >
              <pre className="bg-bg border border-border rounded-md p-3 overflow-auto text-[11px] leading-snug max-h-72 font-mono mt-1">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </Disclosure>
          </div>
        </div>
      </div>
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
  children
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <button
        onClick={onToggle}
        className="text-[10px] text-muted uppercase tracking-widest3 text-left hover:text-text transition flex items-center gap-2 py-1 font-medium"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        {label}
      </button>
      {open && children}
    </div>
  );
}

function DownloadBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 px-3 py-2 text-[13px] border border-border bg-panel2 rounded-md hover:border-amber/60 hover:bg-amber/5 hover:text-amber transition font-medium"
    >
      {children}
    </button>
  );
}

function PipeStep({
  label,
  sub,
  active,
  highlight
}: {
  label: string;
  sub: string;
  active?: boolean;
  highlight?: boolean;
}) {
  const borderClass = highlight
    ? 'border-amber/60 bg-amber/10'
    : active
    ? 'border-border bg-bg'
    : 'border-border/40 bg-bg/40';
  const textClass = highlight ? 'text-amber' : active ? 'text-textHi' : 'text-muted';
  return (
    <div className={`flex-1 rounded-md border ${borderClass} px-2 py-1.5 text-center min-w-0`}>
      <div className={`tracking-widest2 font-semibold uppercase ${textClass}`}>{label}</div>
      <div className="text-muted tnum truncate text-[10px] mt-0.5">{sub}</div>
    </div>
  );
}

function PipeArrow() {
  return <span className="text-muted/50 text-[10px] shrink-0">▸</span>;
}

