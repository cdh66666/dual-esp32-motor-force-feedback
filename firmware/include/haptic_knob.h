#pragma once
#include <cmath>
#include <cstdint>

// Original, portable haptic law. Coordinates are OUTPUT-shaft degrees;
// current is winding amperes, not a claim of calibrated output torque.
namespace haptic {
constexpr float pi = 3.14159265358979323846f;
constexpr float currentLimitA = 0.6f;
constexpr uint32_t leaseMs = 1000, sessionMs = 60000;
enum Effect { Detents = 0, Spring = 1, Damping = 2, Bounded = 3 };
struct Config {
  int effect = Detents;
  float spacingDeg = 15, strengthA = 0.20f, dampingAperDps = 0.001f, rangeDeg = 90;
};
inline float clamp(float x, float lo, float hi) { return fminf(hi, fmaxf(lo, x)); }
inline bool valid(const Config &c) {
  return c.effect >= Detents && c.effect <= Bounded &&
      std::isfinite(c.spacingDeg) && c.spacingDeg >= 2 && c.spacingDeg <= 90 &&
      std::isfinite(c.strengthA) && c.strengthA >= 0 && c.strengthA <= currentLimitA &&
      std::isfinite(c.dampingAperDps) && c.dampingAperDps >= 0 && c.dampingAperDps <= .01f &&
      std::isfinite(c.rangeDeg) && c.rangeDeg >= c.spacingDeg && c.rangeDeg <= 720;
}
struct Output { float currentA = 0, centerDeg = 0; bool valid = false; };
inline Output evaluate(const Config &c, float angle, float velocity, float origin) {
  Output out;
  if (!valid(c) || !std::isfinite(angle) || !std::isfinite(velocity) ||
      !std::isfinite(origin)) return out;
  const float x = angle - origin;
  if (!std::isfinite(x) || fabsf(x / c.spacingDeg) > 1000000) return out;
  const float index = roundf(x / c.spacingDeg);
  const float local = x - index * c.spacingDeg;
  float force = 0;
  out.centerDeg = origin;
  if (c.effect == Detents || c.effect == Bounded) {
    // Periodic potential: force is continuous at +/- half a cell, including
    // center changes. Unlike a snapped proportional error it never jumps.
    force = -c.strengthA * sinf(2 * pi * local / c.spacingDeg);
    out.centerDeg = origin + index * c.spacingDeg;
    if (c.effect == Bounded) {
      const float end = floorf(c.rangeDeg / c.spacingDeg) * c.spacingDeg;
      out.centerDeg = origin + clamp(index * c.spacingDeg, -end, end);
      if (fabsf(x) > end) {
        const float over = x - clamp(x, -end, end);
        force = -c.strengthA * tanhf(4 * over / c.spacingDeg);
      }
    }
  } else if (c.effect == Spring) {
    force = -c.strengthA * tanhf(x / c.spacingDeg);
  } else {
    out.centerDeg = angle;
  }
  out.currentA = clamp(force - c.dampingAperDps * velocity, -currentLimitA, currentLimitA);
  out.valid = true;
  return out;
}

// A KEEP cannot start, revive an expired lease, or adopt another session.
// The 60 s hard session cap bounds an unattended bench haptic test.
struct Lease {
  uint32_t token = 0, deadline = 0, hardDeadline = 0;
  bool active = false;
  bool alive(uint32_t now) const {
    return active && int32_t(now - deadline) < 0 && int32_t(now - hardDeadline) < 0;
  }
  bool start(uint32_t id, uint32_t now) {
    if (id == 0) return false;
    token = id; deadline = now + leaseMs; hardDeadline = now + sessionMs; active = true;
    return true;
  }
  bool keep(uint32_t id, uint32_t now) {
    if (!alive(now) || id != token) return false;
    deadline = now + leaseMs; return true;
  }
  void stop() { active = false; token = 0; }
};
} // namespace haptic
