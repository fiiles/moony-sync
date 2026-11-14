import qrcode from "qrcode-generator";
import { useMemo } from "preact/hooks";

const QUIET = 4;

/** A QR code as inline SVG: one path of unit squares on a white plate (a scanner needs dark on
 *  light in both themes; the colours are set in app.css). */
export function Qr({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
    }
    return { size: n + QUIET * 2, path: d };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect class="qr__plate" width={size} height={size} />
      <path class="qr__dots" d={path} />
    </svg>
  );
}
