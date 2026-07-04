export const BLOCK_OVERHEAD = 4;

export function estTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}
