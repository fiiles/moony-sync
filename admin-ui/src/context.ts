import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { AuthState } from "./api";

export interface AppContext {
  state: AuthState;
  /** Reads /admin/api/state again (after login, setup, enrolment, logout). */
  refresh(): Promise<void>;
}

export const AppCtx = createContext<AppContext | null>(null);
export const useApp = (): AppContext => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("outside App");
  return c;
};
