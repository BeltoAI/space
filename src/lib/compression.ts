export async function compressFrame(
  imageData: ImageData,
  quality = 0.3
): Promise<{ blob: Blob; dataUrl: string; bytes: number }> {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')!.putImageData(imageData, 0, 0);
  const blob: Blob = await new Promise(resolve =>
    canvas.toBlob(b => resolve(b!), 'image/jpeg', quality)
  );
  const dataUrl = await blobToDataUrl(blob);
  return { blob, dataUrl, bytes: blob.size };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error('FileReader error'));
    r.readAsDataURL(blob);
  });
}

export function utf8ByteLength(s: string): number {
  return new Blob([s]).size;
}

export function downscaleImageData(imageData: ImageData, maxDim = 256): ImageData {
  const { width: w, height: h } = imageData;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale === 1) return imageData;
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  src.getContext('2d')!.putImageData(imageData, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = dw;
  dst.height = dh;
  const ctx = dst.getContext('2d')!;
  ctx.drawImage(src, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}
