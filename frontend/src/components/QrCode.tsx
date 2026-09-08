'use client';

import { useMemo } from 'react';
import { encodeQr, qrToSvgPath, type QrErrorCorrection } from '@/lib/qr';

const QUIET_ZONE = 4;

interface QrCodeProps {
  /** Text to encode (UTF-8). */
  value: string;
  /** Rendered width/height in CSS pixels. */
  size?: number;
  errorCorrection?: QrErrorCorrection;
  /** Accessible name for the image. */
  label?: string;
  className?: string;
}

/**
 * Inline-SVG QR code. Colours are fixed to black-on-white so the code stays
 * scannable regardless of the app theme.
 */
export function QrCode({
  value,
  size = 176,
  errorCorrection = 'M',
  label = 'QR code',
  className,
}: QrCodeProps) {
  const qr = useMemo(() => {
    try {
      return encodeQr(value, { errorCorrection });
    } catch (err) {
      console.warn('QR code could not be generated:', err);
      return null;
    }
  }, [value, errorCorrection]);

  if (!qr) {
    return (
      <div
        className={`flex items-center justify-center text-center text-xs text-gray-500 ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        Too long to show as a QR code.
      </div>
    );
  }

  const total = qr.size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className={className}
      data-qr-version={qr.version}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={qrToSvgPath(qr, QUIET_ZONE)} fill="#000000" />
    </svg>
  );
}
