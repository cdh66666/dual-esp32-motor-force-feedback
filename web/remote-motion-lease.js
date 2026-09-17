export const REMOTE_MOTION_REFRESH_MS = 500;
export const REMOTE_TELEMETRY_STALE_MS = 2000;

// DATA motion commands intentionally have a 1 s firmware lease. Refresh the
// active target while telemetry is fresh; on a lost gateway/UI link the board
// still stops promptly without depending on a longer blind timeout.
export function remoteMotionLeaseAction(motion, now, lastSentAt, lastTelemetryAt) {
  if (!motion) return 'none';
  if (Number.isFinite(motion.expiresAt) && now >= motion.expiresAt) return 'expire';
  if (!Number.isFinite(now) || !Number.isFinite(lastSentAt) ||
      !Number.isFinite(lastTelemetryAt) || now - lastTelemetryAt > REMOTE_TELEMETRY_STALE_MS) {
    return 'stale';
  }
  if (motion.mode === 'pwm') return 'wait';
  return now - lastSentAt >= REMOTE_MOTION_REFRESH_MS ? 'refresh' : 'wait';
}
