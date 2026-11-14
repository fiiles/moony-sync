// History API routing without a library. Paths: / /people /people/:id /backup /settings.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

const EVENT = "moony:navigate";

const clean = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path) || "/";

export function navigate(path: string, replace = false): void {
  if (clean(path) === clean(window.location.pathname)) return;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo?.(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(() => clean(window.location.pathname));
  useEffect(() => {
    const update = () => setPath(clean(window.location.pathname));
    window.addEventListener("popstate", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return path;
}

interface LinkProps {
  to: string;
  class?: string;
  "aria-current"?: "page";
  "aria-label"?: string;
  children?: ComponentChildren;
}

/** An ordinary link that does not reload the page. */
export function Link({ to, children, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={to}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
