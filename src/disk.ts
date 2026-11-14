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

/** The bytes that uploads still streaming have declared but not yet written. Blob and snapshot
 *  uploads share one, so the floor holds across all of them together. */
export interface SpaceReservation {
  /** Reserves `length` when it still leaves the floor free (counting what is reserved already);
   *  returns the release function, or null when there is no room. Synchronous, so the check and
   *  the reservation cannot be interleaved by another request. */
  tryReserve(free: number | null, length: number): (() => void) | null;
}

export function createSpaceReservation(): SpaceReservation {
  let reserved = 0;
  return {
    tryReserve(free, length) {
      if (!hasRoom(free === null ? null : free - reserved, length)) return null;
      reserved += length;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reserved -= length;
      };
    },
  };
}
