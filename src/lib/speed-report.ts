export const PING_ATTEMPTS = 10;

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

export function summarizePings(samples: number[], attempts = PING_ATTEMPTS) {
  const replies = samples.filter((value) => Number.isFinite(value) && value >= 0 && value <= 120000).slice(0, attempts);
  if (!replies.length) return null;
  return {
    attempts,
    replies: replies.length,
    minMs: round1(Math.min(...replies)),
    avgMs: round1(replies.reduce((sum, value) => sum + value, 0) / replies.length),
    maxMs: round1(Math.max(...replies)),
  };
}

export function previewPings(baseMs: number, salt: number) {
  const base = Math.max(1, baseMs);
  return Array.from({ length: PING_ATTEMPTS }, (_, index) => round1(Math.max(0.1, base + Math.sin(salt + index * 0.7) * base * 0.12)));
}

export function averageThroughput(rxMbps: number, txMbps: number) {
  const values = [rxMbps, txMbps].filter((value) => Number.isFinite(value) && value >= 0);
  if (!values.length) return 0;
  return round1(values.reduce((sum, value) => sum + value, 0) / values.length);
}
