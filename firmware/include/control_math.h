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
