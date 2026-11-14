/** Starts the browser's download of a file the server sends as an attachment (the page stays). */
export function startDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
