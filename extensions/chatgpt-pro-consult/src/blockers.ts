export interface ConsultBlocker {
  kind: string;
  message: string;
  code?: string;
  visibleText?: string;
  surfaceRef?: string;
  resumable?: boolean;
}

export function blockerText(blocker: ConsultBlocker | undefined, fallback: string): string {
  if (!blocker) return fallback;
  const surface = blocker.surfaceRef ? ` Surface left open at ${blocker.surfaceRef}.` : "";
  return `${blocker.message}${surface}`;
}
