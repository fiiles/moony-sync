// Number, size and time formatting. Everything goes through Intl with the chosen language.

const KB = 1024;

/** "41 MB", "1.6 TB": MB, GB or TB with at most one decimal. Below 0.1 MB: "< 0.1 MB". */
export function formatBytes(bytes: number, lang: string): string {
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  const mb = bytes / KB / KB;
  if (bytes <= 0) return `${nf.format(0)} MB`;
  if (mb < 0.05) return `< ${nf.format(0.1)} MB`;
  if (mb < KB) return `${nf.format(mb)} MB`;
  const gb = mb / KB;
  if (gb < KB) return `${nf.format(gb)} GB`;
  return `${nf.format(gb / KB)} TB`;
}

/** "4 min ago" / "před 4 min." for a unix time in seconds; a plain date after a month. */
export function formatRelative(unixSeconds: number, lang: string, nowMs: number = Date.now()): string {
  const diff = Math.round(nowMs / 1000 - unixSeconds);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
  if (diff < 60) return rtf.format(0, "second");
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), "hour");
  if (diff < 30 * 86400) return rtf.format(-Math.floor(diff / 86400), "day");
  return formatDate(unixSeconds, lang);
}

export function formatDate(unixSeconds: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(new Date(unixSeconds * 1000));
}

/** The absolute time, for a title attribute. */
export function formatDateTime(unixSeconds: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(unixSeconds * 1000));
}
