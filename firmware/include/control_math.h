#pragma once
#include <math.h>
#include <stdint.h>

// Portable control primitives; the desktop regression compiles this same file.
namespace motor_control {
// Keep an accepted angle below 120 degrees of travel; the old 2.5 ms
// minimum was unsafe above 8,000 rpm. At near-zero speed, allow one missed
// 1 kHz sample without tripping a stationary motor: the main loop can briefly
// service USB/telemetry while the rotor has made no meaningful blind travel.
// A fresh read must still precede this check once the grace window expires.
inline uint32_t encoderDeadlineUs(float speedDps) {
  const float speed = fabsf(speedDps);
  const float travelDeadline = 120000000.0f / (speed > 1 ? speed : 1);
  const uint32_t maxDeadline = speed < 250.0f ? 20000u : 10000u;
  return static_cast<uint32_t>(travelDeadline < 500 ? 500 :
                               travelDeadline > maxDeadline ? maxDeadline : travelDeadline);
}
inline bool encoderStale(uint32_t now, uint32_t acceptedAt, float speedDps) {
  return acceptedAt == 0 || now - acceptedAt > encoderDeadlineUs(speedDps);
}
inline float clamp(float x, float lo, float hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}
inline bool integralAllowed(float error, float candidate, float previousDemand,
                            float applied, float limit, float step,
                            bool assisting) {
  if (assisting) return false;
  // Include ALL feed-forward terms before calling this function. A negative
  // tracking error must not freeze a positive integral (and vice versa).
  const bool saturated = (candidate > limit && error > 0.0f) ||
                         (candidate < -limit && error < 0.0f);
  const float lag = clamp(previousDemand, -limit, limit) - applied;
  const bool chasingLimiter = fabsf(lag) > 2.0f * step && lag * error > 0.0f;
  return !saturated && !chasingLimiter;
}
inline float slew(float applied, float request, float step) {
  return applied + clamp(request - applied, -step, step);
}
// Smooth only the disturbance feed-forward estimate, NOT current feedback,
// position feedback, or protection input. Actual current PI stays fast.
inline float emfVelocityEstimate(float previous, float measured, float dt) {
  if (!(dt > 0.0f) || !isfinite(measured)) return previous;
  return previous + (measured - previous) * -expm1f(-dt / 0.010f);
}
// Position PD already reduces its reference as the target approaches. A
// second symmetric slew limiter delays that braking request. Ramp up speed,
// but pass deceleration to the current-limited velocity loop immediately.
// On retarget reversal first request braking to zero; accelerate in the new
// direction only once measured motion is inside one acceleration step.
inline float positionVelocityReference(float previous, float requested,
                                      float measured, float step) {
  if (requested * measured < 0.0f && fabsf(measured) > step) return 0.0f;
  if (previous * requested < 0.0f) return 0.0f;
  if (fabsf(requested) <= fabsf(previous)) return requested;
  return slew(previous, requested, step);
}
struct PositionTrajectoryState {
  float positionDeg;
  float velocityDps;
  float accelerationDps2;
};
// Jerk-limited critically damped position reference. The planner runs locally
// on the MCU; host/DATA command timing only changes the goal, never the loop
// rate. A missed scheduler window is skipped rather than integrated as one
// large, discontinuous move.
inline PositionTrajectoryState positionTrajectoryStep(
    PositionTrajectoryState state, float targetDeg, float maxVelocityDps,
    float maxAccelerationDps2, float maxJerkDps3, float bandwidthRadS,
    float dtSeconds) {
  if (!isfinite(state.positionDeg) || !isfinite(state.velocityDps) ||
      !isfinite(state.accelerationDps2) || !isfinite(targetDeg) ||
      !isfinite(maxVelocityDps) || !isfinite(maxAccelerationDps2) ||
      !isfinite(maxJerkDps3) || !isfinite(bandwidthRadS) ||
      !isfinite(dtSeconds) || maxVelocityDps <= 0.0f ||
      maxAccelerationDps2 <= 0.0f || maxJerkDps3 <= 0.0f ||
      bandwidthRadS <= 0.0f || dtSeconds <= 0.0f || dtSeconds > 0.020f) {
    return state;
  }
  const float distance = targetDeg - state.positionDeg;
  if (fabsf(distance) <= 0.001f && fabsf(state.velocityDps) <= 0.05f) {
    return {targetDeg, 0.0f, 0.0f};
  }
  const float bandwidth = clamp(bandwidthRadS, 0.2f, 20.0f);
  const float desiredAcceleration = clamp(
      bandwidth * bandwidth * distance -
          2.0f * bandwidth * state.velocityDps,
      -maxAccelerationDps2, maxAccelerationDps2);
  const float jerkStep = maxJerkDps3 * dtSeconds;
  const float acceleration = clamp(
      state.accelerationDps2 + clamp(
          desiredAcceleration - state.accelerationDps2,
          -jerkStep, jerkStep),
      -maxAccelerationDps2, maxAccelerationDps2);
  const float velocity = clamp(
      state.velocityDps + acceleration * dtSeconds,
      -maxVelocityDps, maxVelocityDps);
  const float position = state.positionDeg +
      0.5f * (state.velocityDps + velocity) * dtSeconds;
  // Do not let numerical integration carry the reference through its target.
  if ((distance > 0.0f && position >= targetDeg) ||
      (distance < 0.0f && position <= targetDeg)) {
    return {targetDeg, 0.0f, 0.0f};
  }
  return {position, velocity, acceleration};
}
inline float positionVelocityTrackingCommand(
    float referencePositionDeg, float measuredPositionDeg,
    float referenceVelocityDps, float measuredVelocityDps,
    float kp, float kd, float reverseKdScale = 1.0f) {
  if (!isfinite(referencePositionDeg) || !isfinite(measuredPositionDeg) ||
      !isfinite(referenceVelocityDps) || !isfinite(measuredVelocityDps) ||
      !isfinite(kp) || !isfinite(kd) || !isfinite(reverseKdScale)) return 0.0f;
  const float directionalKd = referenceVelocityDps < -0.01f
      ? kd * clamp(reverseKdScale, 0.1f, 5.0f) : kd;
  return referenceVelocityDps + kp *
      (referencePositionDeg - measuredPositionDeg) + directionalKd *
      (referenceVelocityDps - measuredVelocityDps);
}
inline float rescaleIntegral(float integral, float oldKi, float newKi, float limit) {
  return newKi > 1.0e-9f
      ? clamp(oldKi * integral, -limit, limit) / newKi : 0.0f;
}
inline bool due(uint32_t now, uint32_t last, uint32_t period) {
  return last == 0 || now - last >= period;
}
inline bool takeDeadline(uint32_t now, uint32_t &next, uint32_t period) {
  if (period == 0) return false;
  if (next != 0 && static_cast<int32_t>(now - next) < 0) return false;
  // Skip every missed slot, not only stalls longer than four periods. A
  // delayed ADC/I2C transaction used to trigger several near-zero-dt PI
  // updates against the same measurement. Preserve phase during normal
  // scheduling, but always leave the next deadline strictly in the future.
  next = next == 0 ? now + period
      : next + ((now - next) / period + 1u) * period;
  return true;
}
inline float lowPassAlpha(uint32_t elapsedUs, float timeConstantUs) {
  if (elapsedUs == 0) return 0;
  if (timeConstantUs <= 0) return 1;
  return -expm1f(-static_cast<float>(elapsedUs) / timeConstantUs);
}

// Small control-side filter for bilateral damping. Peer speed arrives at
// 200 Hz and inherits encoder quantization; this suppresses alternating
// one-count torque chatter without filtering position, current protection,
// or telemetry. A real step reaches 90% in about 10 ms.
inline float bilateralVelocityError(float previous, float sample,
                                    uint32_t elapsedUs, bool initialized,
                                    float timeConstantUs = 4000.0f) {
  if (!isfinite(sample)) return initialized && isfinite(previous) ? previous : 0.0f;
  if (!initialized || elapsedUs == 0 || elapsedUs > 50000 ||
      !isfinite(previous) || !isfinite(timeConstantUs) || timeConstantUs <= 0.0f) {
    return sample;
  }
  return previous + lowPassAlpha(elapsedUs, timeConstantUs) * (sample - previous);
}

inline float gearedPositionDeadband(float configuredMotorDeg, float gearRatio,
                                    float minimumOutputDeg) {
  if (!isfinite(configuredMotorDeg) || !isfinite(gearRatio) ||
      !isfinite(minimumOutputDeg) || configuredMotorDeg < 0.0f ||
      gearRatio < 1.0f || minimumOutputDeg < 0.0f) return 0.0f;
  return fmaxf(configuredMotorDeg, gearRatio * minimumOutputDeg);
}

inline bool positionSettledHysteresis(bool settled, float errorDeg,
                                      float velocityDps, float quietBandDeg,
                                      float rearmMarginDeg, float enterSpeedDps,
                                      float exitSpeedDps) {
  if (!isfinite(errorDeg) || !isfinite(velocityDps) ||
      !isfinite(quietBandDeg) || !isfinite(rearmMarginDeg) ||
      !isfinite(enterSpeedDps) || !isfinite(exitSpeedDps) ||
      quietBandDeg < 0.0f || rearmMarginDeg < 0.0f ||
      enterSpeedDps < 0.0f || exitSpeedDps < enterSpeedDps) return false;
  const float band = quietBandDeg + (settled ? rearmMarginDeg : 0.0f);
  const float speed = settled ? exitSpeedDps : enterSpeedDps;
  return fabsf(errorDeg) <= band && fabsf(velocityDps) <= speed;
}

// Blend the median increment into velocity differentiation only where
// one-count MT6701 noise dominates. At/above threshold keep the raw accepted
// increment so the estimator does not round off real high-speed motion.
inline float encoderVelocityDelta(float rawDeltaDegrees,
                                  float medianDeltaDegrees,
                                  float rawVelocityDps,
                                  float blendBelowDps,
                                  float medianBlend) {
  if (!isfinite(rawDeltaDegrees) || !isfinite(medianDeltaDegrees) ||
      !isfinite(rawVelocityDps) || !isfinite(blendBelowDps) ||
      !isfinite(medianBlend) || blendBelowDps <= 0.0f) {
    return rawDeltaDegrees;
  }
  if (fabsf(rawVelocityDps) >= blendBelowDps) return rawDeltaDegrees;
  const float blend = clamp(medianBlend, 0.0f, 1.0f);
  return rawDeltaDegrees + (medianDeltaDegrees - rawDeltaDegrees) * blend;
}

// Differentiate accepted encoder increments over a short physical time
// window. Never integrate a median of increments into the position: doing
// so can lose real counts. The raw angle/unwrapped position stay untouched.
// Fractional oldest intervals avoid changes when sampling jitter moves an
// interval across the window boundary. Input and output units are degrees.
class DeltaVelocityWindow {
 public:
  void reset() { count_ = 0; next_ = 0; }
  float update(float deltaDegrees, uint32_t elapsedUs, uint32_t windowUs = 4000) {
    if (!elapsedUs) return 0;
    samples_[next_] = {deltaDegrees, elapsedUs};
    next_ = (next_ + 1) % capacity;
    if (count_ < capacity) ++count_;
    float angle = 0;
    uint32_t span = 0;
    for (unsigned n = 0; n < count_ && span < windowUs; ++n) {
      const auto &s = samples_[(next_ + capacity - 1 - n) % capacity];
      const uint32_t remaining = windowUs - span;
      const uint32_t used = s.us < remaining ? s.us : remaining;
      angle += s.degrees * static_cast<float>(used) / s.us;
      span += used;
    }
    return span ? angle * 1000000.0f / span : 0;
  }
 private:
  static constexpr unsigned capacity = 16;
  struct Sample { float degrees; uint32_t us; } samples_[capacity]{};
  unsigned count_ = 0, next_ = 0;
};
}
