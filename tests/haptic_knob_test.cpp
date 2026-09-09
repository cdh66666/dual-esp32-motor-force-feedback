#include "../firmware/include/haptic_knob.h"
#include <cassert>
#include <iostream>
#include <limits>

int main() {
  haptic::Config c;
  assert(haptic::valid(c));
  for (int mode = 0; mode < 4; ++mode) {
    c.effect = mode;
    for (int i = -4000; i <= 4000; ++i) {
      for (float speed : {-720.f, -10.f, 0.f, 10.f, 720.f}) {
        const auto r = haptic::evaluate(c, i * .1f, speed, 0);
        assert(r.valid && std::isfinite(r.currentA));
        assert(fabsf(r.currentA) <= haptic::currentLimitA);
      }
    }
  }
  c.effect = haptic::Detents;
  assert(haptic::evaluate(c, 1, 0, 0).currentA < 0);
  assert(haptic::evaluate(c, -1, 0, 0).currentA > 0);
  for (int n = -100; n <= 100; ++n) {
    const float edge = (n + .5f) * c.spacingDeg;
    const auto a = haptic::evaluate(c, edge - .0002f, 0, 0);
    const auto b = haptic::evaluate(c, edge + .0002f, 0, 0);
    assert(fabsf(a.currentA - b.currentA) < .0001f);
    assert(fabsf(haptic::evaluate(c, n * c.spacingDeg, 0, 0).currentA) < .00001f);
  }
  c.effect = haptic::Damping;
  for (float speed : {-720.f, -1.f, 0.f, 1.f, 720.f})
    assert(haptic::evaluate(c, 17, speed, 0).currentA * speed <= 0);
  c.effect = haptic::Bounded;
  c.rangeDeg = 91; // Both endpoints align to a true detent, not a discontinuity.
  assert(haptic::evaluate(c, 91, 0, 0).currentA < 0);
  assert(haptic::evaluate(c, -91, 0, 0).currentA > 0);
  assert(fabsf(haptic::evaluate(c, 90-.0002f, 0, 0).currentA -
               haptic::evaluate(c, 90+.0002f, 0, 0).currentA) < .0001f);
  assert(haptic::evaluate(c, 0, 721, 0).valid);
  assert(haptic::evaluate(c, 0, 2500, 0).valid); // Speed alone is not invalid data.
  assert(!haptic::evaluate(c, std::numeric_limits<float>::quiet_NaN(), 0, 0).valid);
  c.strengthA = 7; assert(!haptic::valid(c));
  c = haptic::Config{}; c.dampingAperDps = -1; assert(!haptic::valid(c));
  c = haptic::Config{}; c.spacingDeg = 0; assert(!haptic::valid(c));

  haptic::Lease lease;
  assert(!lease.keep(1, 0));
  assert(lease.start(123, 0));
  assert(!lease.keep(124, 500));
  assert(lease.keep(123, 500));
  assert(lease.alive(1499));
  assert(!lease.alive(1500));
  assert(!lease.keep(123, 1500)); // Expiration never auto-restarts.
  assert(lease.start(125, 2000)); lease.stop();
  assert(!lease.keep(125, 2001));
  assert(lease.start(126, UINT32_MAX - 10));
  assert(lease.keep(126, 100)); // Correct across 32-bit millis wrap.
  assert(!lease.alive(1100));
  lease.start(127, 0);
  for (uint32_t t = 0; t < 60000; t += 200) assert(lease.keep(127, t));
  assert(!lease.keep(127, 60000)); // Local hard cap, regardless of host renewals.

  // Hypothetical mechanics, NOT measured hardware: 500 Hz haptic / 2 kHz
  // current response with an assumed 3 ms lag and three example inertias.
  // Check bounded transients and the complete 10 s tail, not only arrival.
  c = haptic::Config{};
  for (double inertia : {.0001, .001, .003}) {
    double angle = 3, speed = 0, current = 0, target = 0, maximum = 0, tail = 0;
    for (int n = 0; n < 30000; ++n) {
      if (n % 4 == 0) {
        const auto r = haptic::evaluate(c, float(angle), float(speed), 0);
        assert(r.valid); target = r.currentA;
      }
      current += (target-current) * (.0005/.003);
      speed += current * .1 / inertia * (180.0 / haptic::pi) * .0005;
      angle += speed * .0005;
      maximum = fmax(maximum, fabs(angle));
      if (n >= 10000) tail = fmax(tail, fabs(angle));
    }
    assert(maximum < 4 && tail < .1);
    std::cout << "simulated_J=" << inertia << " peak_deg=" << maximum << " last_10s_max_deg=" << tail << "\n";
  }
  std::cout << "PASS haptic force law, continuity, damping sign, limits, leases and simulated transients\n";
}
