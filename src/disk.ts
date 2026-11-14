// Free space on the data volume, for the floor that uploads must leave.

import { statfs } from "node:fs/promises";
import { FREE_SPACE_FLOOR_BYTES } from "./limits.js";

/** Bytes free on the data volume, or null when it cannot be told. */
export type FreeBytes = () => Promise<number | null>;

export async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const fs = await statfs(dir);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

/** True when `incoming` more bytes still leave the floor free; an unknown free space allows it. */
export function hasRoom(free: number | null, incoming: number): boolean {
  return free === null || free - incoming >= FREE_SPACE_FLOOR_BYTES;
}
