import { useRef } from 'react';
import { SAMPLES } from '../lib/samples';

interface Props {
  busy: boolean;
  webcamActive: boolean;
  streamActive: boolean;
  webcamVideoRef: React.RefObject<HTMLVideoElement>;
  webcamPreviewCanvasRef: React.RefObject<HTMLCanvasElement>;
  onWebcamToggle: () => void;
  onStreamToggle: () => void;
  onGoesOnce: () => void;
  onLiveTile: () => void;
  onSample: (id: string) => void;
  onTimelapse: () => void;
  onUploadImage: (url: string) => void;
  onUploadVideo: (url: string) => void;
}

export default function InputPanel({
  busy,
  webcamActive,
  streamActive,
  webcamVideoRef,
  webcamPreviewCanvasRef,
  onWebcamToggle,
  onStreamToggle,
  onGoesOnce,
  onLiveTile,
  onSample,
  onTimelapse,
  onUploadImage,
  onUploadVideo
}: Props) {
  const imgRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>, isVideo: boolean) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    if (isVideo) onUploadVideo(url);
    else onUploadImage(url);
    e.target.value = '';
  }

  return (
    <div className="h-full flex flex-col bg-panel border border-border rounded-xl overflow-hidden shadow-panel">
      <div className="px-4 py-3 border-b border-border bg-panel2/50">
        <div className="text-[10px] text-muted uppercase tracking-widest3 font-medium">Source</div>
      </div>

      <div className="p-4 flex flex-col gap-4 overflow-auto">
        {/* HERO: Webcam */}
        <div className="flex flex-col gap-2">
          <button
            disabled={busy}
            onClick={onWebcamToggle}
            className={`w-full px-4 py-3.5 rounded-lg border transition text-left disabled:opacity-40 disabled:cursor-not-allowed ${
              webcamActive
                ? 'border-critical bg-critical/15 text-critical shadow-glowCritical'
                : 'border-amber/70 bg-amber/5 text-amber hover:bg-amber/10 shadow-glow'
            }`}
          >
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-widest2">
              <span className={`w-2 h-2 rounded-full ${webcamActive ? 'bg-critical live-pulse' : 'bg-amber live-pulse'}`} />
              {webcamActive ? 'STOP LIVE WEBCAM' : 'GO LIVE — WEBCAM SENSOR'}
            </div>
            <div className="text-[12px] text-muted mt-1 leading-snug font-normal">
              {webcamActive ? 'Processing your camera at 1 Hz' : 'Use your laptop camera as an edge sensor'}
            </div>
          </button>

          {/* Always-mounted hidden video + visible canvas mirror */}
          <video
            ref={webcamVideoRef}
            autoPlay
            playsInline
            muted
            style={{ display: 'none' }}
          />
          {webcamActive && (
            <div className="rounded-lg overflow-hidden border border-critical/40 bg-black relative">
              <canvas
                ref={webcamPreviewCanvasRef}
                className="w-full block"
              />
              <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/80 border border-critical/60 text-critical text-[9px] font-semibold tracking-widest2">
                <span className="w-1 h-1 rounded-full bg-critical live-pulse" />
                LIVE
              </div>
            </div>
          )}
        </div>

        {/* Streaming GOES */}
        <button
          disabled={busy}
          onClick={onStreamToggle}
          className={`w-full px-4 py-3 rounded-lg border transition text-left disabled:opacity-40 disabled:cursor-not-allowed ${
            streamActive
              ? 'border-critical bg-critical/10 text-critical'
              : 'border-border hover:border-amber/60 hover:bg-amber/5 text-text'
          }`}
        >
          <div className="flex items-center gap-2 text-[12px] font-semibold tracking-widest2">
            <span className={`w-2 h-2 rounded-full ${streamActive ? 'bg-critical live-pulse' : 'bg-amber'}`} />
            <span className={streamActive ? '' : 'text-amber'}>
              {streamActive ? 'STOP STREAMING GOES' : 'STREAM GOES-19 LIVE'}
            </span>
          </div>
          <div className="text-[12px] text-muted mt-1 leading-snug font-normal">
            {streamActive ? 'Polling every 30 sec · NOAA STAR CDN' : 'Real-time · NOAA East · Continental US'}
          </div>
        </button>

        <Divider />

        <Section label="Real-time NASA / NOAA">
          <Btn onClick={onGoesOnce} disabled={busy}>
            <div className="flex flex-col">
              <span>Latest GOES-19 snapshot</span>
              <span className="text-[10px] text-muted mt-0.5 leading-tight">Continental US, refreshes every 5 min</span>
            </div>
          </Btn>
          <Btn onClick={onLiveTile} disabled={busy}>
            <div className="flex flex-col">
              <span>Latest natural event (EONET)</span>
              <span className="text-[10px] text-muted mt-0.5 leading-tight">NASA's open event tracker · live wildfires/storms</span>
            </div>
          </Btn>
          <Btn onClick={onTimelapse} disabled={busy}>
            <div className="flex flex-col">
              <span>Park Fire timelapse · 6 days</span>
              <span className="text-[10px] text-muted mt-0.5 leading-tight">Watch decision change as fire evolves</span>
            </div>
          </Btn>
        </Section>

        <Section label="Historical samples">
          {SAMPLES.map(s => {
            const isFireSample = s.id === 'wildfire';
            return (
              <button
                key={s.id}
                onClick={() => onSample(s.id)}
                disabled={busy}
                className={`px-3 py-2 text-left border rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition group ${
                  isFireSample
                    ? 'border-critical/40 bg-critical/5 hover:border-critical/70 hover:bg-critical/10'
                    : 'border-border hover:border-amber/60 hover:bg-amber/5'
                }`}
              >
                <div className={`text-[13px] transition flex items-center gap-1.5 ${
                  isFireSample ? 'text-critical' : 'group-hover:text-amber'
                }`}>
                  {isFireSample && <span className="text-[10px]">🔥</span>}
                  {s.label}
                </div>
                <div className="text-[10px] text-muted mt-0.5 leading-tight">{s.caption}</div>
              </button>
            );
          })}
        </Section>

        <Section label="Upload">
          <div className="flex gap-2">
            <Btn onClick={() => imgRef.current?.click()} disabled={busy} className="flex-1 text-center">Image</Btn>
            <Btn onClick={() => vidRef.current?.click()} disabled={busy} className="flex-1 text-center">Video</Btn>
          </div>
          <input ref={imgRef} type="file" accept="image/*" hidden onChange={e => onFile(e, false)} />
          <input ref={vidRef} type="file" accept="video/*" hidden onChange={e => onFile(e, true)} />
        </Section>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-border" />;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] text-muted uppercase tracking-widest3 font-medium">{label}</div>
      {children}
    </div>
  );
}

function Btn({
  onClick,
  disabled,
  className = '',
  children
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 text-left text-[13px] border border-border rounded-md hover:border-amber/60 hover:bg-amber/5 hover:text-amber disabled:opacity-40 disabled:cursor-not-allowed transition ${className}`}
    >
      {children}
    </button>
  );
}
