import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { useTranslation } from 'react-i18next';

export function QrImage({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(text, { margin: 1, width: 440, errorCorrectionLevel: 'M' }).then(setSrc);
  }, [text]);
  return <div className="qr-box">{src && <img src={src} alt={label} />}</div>;
}

/** Camera QR scanner (Android scans the desktop's code, FR-CLI-03). */
export function QrScanner({ onResult, onError }: { onResult(text: string): void; onError(e: string): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      const v = video.current;
      if (!done && v && v.readyState >= 2 && ctx) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          done = true;
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        raf = requestAnimationFrame(tick);
      })
      .catch(() => onError(t('connect.cameraError')));
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onResult, onError, t]);
  return <video ref={video} className="scanner" muted playsInline aria-label={t('connect.scan')} />;
}
