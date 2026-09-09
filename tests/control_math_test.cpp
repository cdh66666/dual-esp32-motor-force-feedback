#include "../firmware/include/control_math.h"
#include "../firmware/include/usb_tx_policy.h"
#include <assert.h>
#include <stdio.h>
#include <thread>
#include <string>
using namespace motor_control;

int main() {
  // Reproduce yesterday's stationary, 360 deg/s request. With the OLD
  // ordering the 0.1 A static term froze I at roughly 0.145 A indefinitely.
  float integral = 0, applied = 0;
  for (int tick = 0; tick < 500; ++tick) {
    const float candidate = integral + 360.0f * .002f;
    const float previous = .00012f * 360 + .0005f * integral + .100350f;
    if (integralAllowed(360, .00012f * 360 + .0005f * candidate + .100350f,
                        previous, applied, .5f, .006f, false)) integral = candidate;
    applied = slew(applied, .0432f + .0005f * integral + .100350f, .006f);
  }
  assert(applied > .30f && applied < .33f);
  assert(!integralAllowed(100, .6f, .6f, .5f, .5f, .006f, false));
  assert(integralAllowed(-100, .4f, .5f, .5f, .5f, .006f, false));
  assert(!integralAllowed(100, .2f, .2f, .2f, .5f, .006f, true));
  assert(fabsf(slew(.25f, .026f, .006f) - .244f) < 1e-5f);
  assert(fabsf(rescaleIntegral(2, 100, 200, 4095) - 1) < 1e-5f);
  assert(rescaleIntegral(2, 100, 0, 4095) == 0);
  uint32_t vLast=0, pLast=0; int v=0, p=0;
  for (uint32_t t=1; t<=1000000; t+=500) {
    if (due(t,vLast,2000)) { vLast=t; ++v; }
    if (due(t,pLast,5000)) { pLast=t; ++p; }
  }
  assert(v==500 && p==200);
  assert(due(100, UINT32_MAX-3000, 2000));
  uint32_t next=0; int ticks=0;
  for (uint32_t t=1; t<1000001; t+=77) {
    if (takeDeadline(t,next,500)) ++ticks;
  }
  assert(ticks==2000); // work-time jitter must not reduce the mean loop rate
  assert(takeDeadline(next+100000,next,500));
  assert(!takeDeadline(next-1,next,500)); // no burst of stale catch-up ticks
  for (uint32_t late = 0; late <= 2500; late += 20) {
    uint32_t scheduled = 1000;
    const uint32_t observed = scheduled + late;
    assert(takeDeadline(observed, scheduled, 500));
    assert(scheduled > observed && scheduled - observed <= 500);
    assert(!takeDeadline(observed, scheduled, 500));
  }
  next = UINT32_MAX - 199;
  assert(takeDeadline(750, next, 500));
  assert(next == 800 && !takeDeadline(750, next, 500));
  assert(!takeDeadline(1000, next, 0));
  assert(lowPassAlpha(0, 1000) == 0);
  const float fullAlpha = lowPassAlpha(1000, 1522.05f);
  const float firstAlpha = lowPassAlpha(300, 1522.05f);
  const float secondAlpha = lowPassAlpha(700, 1522.05f);
  assert(fabsf(fullAlpha - (firstAlpha + (1-firstAlpha)*secondAlpha)) < 1e-6f);
  assert(fabsf(lowPassAlpha(500,1522.05f)-.28f) < .0001f);
  DeltaVelocityWindow window;
  for (int n = 0; n < 100; ++n) {
    const uint32_t dt = n % 2 ? 600 : 1400;
    assert(fabsf(window.update(-360.f*dt/1000000.f, dt) + 360) < .001f);
  }
  window.reset();
  // Synthetic +/- one-count encoder noise; not a motor performance claim.
  uint32_t random = 721;
  float oldSpeed = 0, newSpeed = 0, priorAngle = 0;
  double oldEnergy = 0, newEnergy = 0;
  for (int n = 0; n < 10000; ++n) {
    random = 1664525u*random + 1013904223u;
    const float noisyAngle = (int((random >> 16) % 3) - 1) * (360.f/16384.f);
    const float delta = noisyAngle - priorAngle;
    priorAngle = noisyAngle;
    oldSpeed += (delta*1000 - oldSpeed) / 3;
    newSpeed += (window.update(delta,1000) - newSpeed) / 3;
    if (n > 20) { oldEnergy += oldSpeed*oldSpeed; newEnergy += newSpeed*newSpeed; }
  }
  assert(newEnergy < oldEnergy*.35);
  window.reset(); newSpeed = 0;
  for (int n = 0; n < 8; ++n) window.update(0,1000);
  int reaches90AtMs = 0;
  for (int n = 1; n <= 12; ++n) {
    newSpeed += (window.update(.360f,1000) - newSpeed) / 3;
    if (!reaches90AtMs && newSpeed >= 324) reaches90AtMs = n;
  }
  assert(reaches90AtMs > 0 && reaches90AtMs <= 10);
  window.reset();
  assert(window.update(0,1000) == 0); // rebase cannot emit a stale speed
  printf("SYNTHETIC ONLY: velocity noise RMS ratio=%.4f, 90%% estimator step=%d ms\n",
         sqrt(newEnergy/oldEnergy), reaches90AtMs);
  // Actual archived failure: 3.23 ms gap at 44,119 deg/s. A successful
  // due read at 3.23 ms is fresh; a failed read must still stop the drive.
  assert(encoderStale(13230,10000,44119.4f));
  assert(!encoderStale(13280,13230,44119.4f));
  assert(encoderDeadlineUs(44119.4f) == 2719);
  assert(encoderDeadlineUs(120000.0f) == 1000);
  assert(encoderStale(500, UINT32_MAX-700, 120000.0f));
  assert(!encoderStale(500, UINT32_MAX-100, 120000.0f));
  assert(encoderStale(10001,0,0));
  assert(!encoderStale(10001,1,0));
  assert(encoderStale(20002,1,0));
  struct FakeUsb {
    size_t room=0, writes=0, flushes=0;
    size_t available() { return room; }
    size_t write(const uint8_t *, size_t n) { ++writes; room-=n; return n; }
    void flush() { ++flushes; room=64; }
  } usb;
  const uint8_t packet[100]={};
  assert(usb_link::pumpOnce(usb,packet,sizeof packet)==0);
  assert(usb.flushes==1 && usb.writes==0); // full, dormant FIFO is kicked
  assert(usb_link::pumpOnce(usb,packet,sizeof packet)==64);
  assert(usb.flushes==2 && usb.writes==1); // exactly one write, no spin
  usb_link::Recovery retained={};
  usb_link::boot(retained,true);
  assert(usb_link::requestRecovery(retained,1501));
  usb_link::boot(retained,false);
  assert(retained.count==1 && retained.pending==1 && retained.stallMs==1501);
  retained.pending=0;
  assert(usb_link::requestRecovery(retained,1502));
  usb_link::boot(retained,false);
  assert(retained.count==2 && !usb_link::requestRecovery(retained,1503));
  usb_link::boot(retained,true);
  assert(retained.count==0); // only power-on/invalid data clear the cap
  // Full queues reject the whole frame; wrap at both the ring boundary and
  // UINT32_MAX must preserve every byte in order.
  usb_link::SpscBytes<8> ring(UINT32_MAX - 3);
  const uint8_t abc[] = {0,1,2,3,4,5,6,7};
  assert(ring.push(abc, 8));
  assert(!ring.push(abc, 1) && ring.size() == 8);
  const uint8_t *bytes = nullptr;
  size_t read = 0;
  while (ring.size()) {
    const size_t n = ring.peek(bytes);
    for (size_t i=0; i<n; ++i) assert(bytes[i] == read++);
    ring.consume(n);
  }
  assert(read == 8 && ring.size() == 0);
  assert(ring.push(abc, 5));
  assert(ring.discard() == 5 && ring.size() == 0);
  assert(!ring.push(abc, 9) && ring.size() == 0);
  usb_link::SpscBytes<1024> concurrent(UINT32_MAX - 200);
  constexpr size_t total = 1000000;
  std::thread producer([&] {
    for (size_t i=0; i<total;) {
      uint8_t frame[31];
      const size_t n = total-i < sizeof(frame) ? total-i : sizeof(frame);
      for (size_t j=0; j<n; ++j) frame[j] = uint8_t((i+j)*17);
      if (concurrent.push(frame, n)) i += n;
      else std::this_thread::yield();
    }
  });
  for (size_t i=0; i<total;) {
    const size_t n = concurrent.peek(bytes);
    for (size_t j=0; j<n; ++j) assert(bytes[j] == uint8_t((i+j)*17));
    concurrent.consume(n); i += n;
    if (!n) std::this_thread::yield();
  }
  producer.join();
  assert(concurrent.size() == 0);
  usb_link::CommandLine<16> parser;
  int accepted=0, rejected=0;
  auto feed = [&](const std::string &s) {
    for (const char c : s) {
      const auto result = parser.feed(c);
      if (result == usb_link::LineResult::Ready) ++accepted;
      if (result == usb_link::LineResult::Rejected) ++rejected;
    }
  };
  feed("current 9" + std::string(50, ' ') + "bad\r\n");
  assert(accepted == 0 && rejected == 1); // never execute a truncated prefix
  feed(std::string("wake\0invalid\n", 13));
  assert(accepted == 0 && rejected == 2);
  feed("stop\r\n");
  assert(accepted == 1 && std::string(parser.text()) == "stop");
  feed("veloc"); parser.clear(); feed("status\n");
  assert(accepted == 2 && std::string(parser.text()) == "status");
  printf("PASS: SPSC 1,000,000 bytes, uint32 rollover, full-frame rejection, bounded command parser\n");
  printf("PASS: torque builds to %.6f A; bounded handoff; I rescale; 500/200 Hz schedule; timer rollover\n",applied);
}
