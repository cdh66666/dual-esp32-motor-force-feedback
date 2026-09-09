#pragma once
#include <cmath>
#include <cstdint>

// Commissioning guard, not a calibrated motor thermal model or speed servo.
// Derating never reverses requested torque; a zero gain requests bridge coast.
namespace interaction {
// Output-shaft units, independent of the motor-side encoder/gear ratio.
constexpr float speedDerateStartDps = 10.f * 360.f;
constexpr float speedCoastDps = 12.f * 360.f;
// Reserve tracking/transient headroom without raising the measured-current trip.
inline float operatingCurrentLimit(float configuredAmps) { return configuredAmps * .8f; }
inline float integrationStep(float elapsed, float nominal) { return fminf(elapsed, nominal); }
inline float currentVoltageBound(float emf, float resistance, float amps, float bus, float rail) {
  const float pwm=(emf+resistance*amps)/fmaxf(bus,2.f)*4095.f;
  return fminf(rail,fmaxf(-rail,pwm));
}
enum Reason { Clear, Speed, Supply, Current, Invalid, Overspeed, Overcurrent,
              SupplyFault, Oscillation };
inline const char *name(Reason r) {
  switch(r) {
    case Speed: return "speed_derating";
    case Supply: return "supply_derating";
    case Current: return "current_derating";
    case Invalid: return "invalid_feedback";
    case Overspeed: return "overspeed";
    case Overcurrent: return "overcurrent";
    case SupplyFault: return "supply_fault";
    case Oscillation: return "oscillation";
    default: return "clear";
  }
}
inline float clamp01(float x) { return fminf(1.f, fmaxf(0.f,x)); }
struct Result { float gain; Reason reason; bool fault; };
struct Guard {
  float gain = 0.f; // Fresh activation always ramps in.
  Reason activeReason = Clear;
  int lastDirection = 0;
  unsigned reversals = 0;
  uint32_t windowStart = 0;
  uint32_t currentLimitedAt = 0;
  bool currentNoticePending = false;
  bool overcurrentTiming = false;
  uint32_t overcurrentSince = 0;
  Result update(float outputDps, float bus, float referenceBus, float amps,
                float currentLimit, float dt, uint32_t now) {
    if (!std::isfinite(outputDps) || !std::isfinite(bus) ||
        !std::isfinite(referenceBus) || referenceBus < 8 ||
        !std::isfinite(amps) || !std::isfinite(currentLimit) || currentLimit <= 0 ||
        !std::isfinite(dt) || dt <= 0)
      return {0, Invalid, true};
    const float speed = fabsf(outputDps), ratio = bus/referenceBus;
    // Fast manual motion is not proof of a hardware fault. At high speed
    // torque is removed below, but the session stays alive. Encoder freshness,
    // supply/current faults and oscillation still have their own exit paths.
    // Normal current regulation stays active; persistent failure is timed.
    // Keep an absolute emergency ceiling at the user's board-tested boundary.
    if (fabsf(amps) >= 5.f) return {0, Overcurrent, true};
    if (fabsf(amps) >= currentLimit) {
      if (!overcurrentTiming) { overcurrentTiming=true;overcurrentSince=now; }
      if (uint32_t(now-overcurrentSince) >= 5000u) return {0, Overcurrent, true};
    } else overcurrentTiming=false;
    if (ratio < .85f || ratio > 1.15f || bus < 8 || bus > 50)
      return {0, SupplyFault, true};
    if (uint32_t(now-windowStart) >= 1000) {
      windowStart=now; reversals=0; lastDirection=0;
    }
    const int direction=outputDps > speedDerateStartDps ? 1 : outputDps < -speedDerateStartDps ? -1 : 0;
    if (direction && lastDirection && direction!=lastDirection) ++reversals;
    if (direction) lastDirection=direction;
    if (reversals >= 6) return {0, Oscillation, true};
    // Report saturation without gating the signed current regulator off.
    // The inner PI and its voltage envelope continuously reduce excess current.
    if (fabsf(amps) >= currentLimit) {
      currentLimitedAt=now;currentNoticePending=true;activeReason=Current;
    }
    const float speedGain=clamp01((speedCoastDps-speed)/(speedCoastDps-speedDerateStartDps));
    const float supplyGain=clamp01((.15f-fabsf(ratio-1.f))/.07f);
    float wanted=speedGain; Reason reason=wanted<.999f ? Speed : Clear;
    if (supplyGain<wanted) {wanted=supplyGain;reason=Supply;}
    // Fast reduction; slow restoration (at most 1 full scale per second).
    gain=fminf(wanted,gain+fminf(dt,.01f));
    // Keep the notice during recovery; jitter around the start must not flash
    // warning/clear at the control-loop rate while torque is still derated.
    if (reason != Clear) activeReason=reason;
    else if (gain >= .999f) {
      if (currentNoticePending && uint32_t(now-currentLimitedAt)<250) activeReason=Current;
      else {activeReason=Clear;currentNoticePending=false;}
    }
    return {gain,activeReason,false};
  }
};
} // namespace interaction
