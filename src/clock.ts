/** Unix seconds. Every time-based rule reads the time through this, so tests can move it. */
export type Clock = () => number;

export const systemClock: Clock = () => Math.floor(Date.now() / 1000);
