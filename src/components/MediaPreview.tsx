interface Props {
  url: string;
  kind: 'image' | 'video' | 'tile';
}

export default function MediaPreview({ url, kind }: Props) {
  return (
    <div className="border border-border rounded overflow-hidden">
      <div className="px-2 py-1 border-b border-border text-[10px] uppercase tracking-wider text-muted">
        {kind === 'tile' ? 'live tile' : kind} preview
      </div>
      <div className="bg-black aspect-square flex items-center justify-center">
        {kind === 'video' ? (
          <video src={url} className="max-w-full max-h-full" controls muted />
        ) : (
          <img src={url} alt="preview" className="max-w-full max-h-full object-contain" />
        )}
      </div>
    </div>
  );
}
