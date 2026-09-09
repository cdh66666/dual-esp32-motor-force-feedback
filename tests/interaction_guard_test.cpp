#include "../firmware/include/interaction_guard.h"
#include <cassert>
#include <limits>
#include <iostream>
int main() {
  using namespace interaction;
  assert(fabsf(operatingCurrentLimit(1.5f)-1.2f)<.0001f);
  assert(fabsf(operatingCurrentLimit(2.f)-1.6f)<.0001f);
  assert(integrationStep(.02f,.0005f)==.0005f);
  assert(integrationStep(.0004f,.0005f)==.0004f);
  Guard g;
  for (unsigned t=0;t<2000;++t) {
    auto r=g.update(0,20,20,0,1.5f,.001f,t);
    assert(!r.fault && r.gain>=0 && r.gain<=1);
  }
  assert(g.gain>.999f);
  for (float s : {-5000.f,-4320.f,-3960.f,-3600.f,-721.f,0.f,721.f,3600.f,3960.f,4320.f,5000.f}) {
    Guard trial;trial.gain=1;
    auto r=trial.update(s,20,20,.2f,1.5f,.001f,0);
    assert(!r.fault);
    if (fabsf(s)>=4320) assert(r.gain==0);
    if (fabsf(s)==3960) assert(fabsf(r.gain-.5f)<.001f);
    if (fabsf(s)<=3600) assert(r.gain==1 && r.reason==Clear);
  }
  auto recovery=g.update(4320,20,20,.2f,1.5f,.001f,2001);
  assert(recovery.gain==0);
  recovery=g.update(0,20,20,.2f,1.5f,.001f,2002);
  assert(recovery.gain<=.0011f); // No snap-back after hand slowing.
  assert(recovery.reason==Speed); // No warning/clear chatter during recovery.
  const auto fast=g.update(721,20,20,.2f,1.5f,.001f,2003);
  assert(!fast.fault && fast.gain>0 && fast.reason==Speed);
  const auto faster=g.update(2500,20,20,.2f,1.5f,.001f,2004);
  assert(!faster.fault && faster.gain>0);
  assert(!g.update(0,20,20,1.81f,1.5f,.001f,2004).fault);
  for(float sign : {-1.f,1.f}) {
    Guard delayed;delayed.gain=1;
    for(unsigned t=0;t<5000;++t) {
      auto limited=delayed.update(0,20,20,sign*2.1f,1.5f,.001f,t);
      assert(!limited.fault && limited.gain==1 && limited.reason==Current);
    }
    assert(delayed.update(0,20,20,sign*2.1f,1.5f,.001f,5000).fault);
    Guard intermittent;
    assert(!intermittent.update(0,20,20,sign*2.1f,1.5f,.001f,0).fault);
    assert(!intermittent.update(0,20,20,.1f,1.5f,.001f,4999).fault);
    assert(!intermittent.update(0,20,20,sign*2.1f,1.5f,.001f,5000).fault);
    assert(!intermittent.update(0,20,20,sign*2.1f,1.5f,.001f,9999).fault);
    assert(intermittent.update(0,20,20,sign*2.1f,1.5f,.001f,10000).fault);
    Guard emergency;
    assert(emergency.update(0,20,20,sign*5.f,1.5f,.001f,0).fault);
    Guard wrap;
    assert(!wrap.update(0,20,20,sign*2.f,1.5f,.001f,0xfffffff0u).fault);
    assert(wrap.update(0,20,20,sign*2.f,1.5f,.001f,4984u).fault);
  }
  assert(g.update(0,16.9f,20,0,1.5f,.001f,2005).fault);
  assert(g.update(0,23.1f,20,0,1.5f,.001f,2006).fault);
  assert(g.update(std::numeric_limits<float>::quiet_NaN(),20,20,0,1.5f,.001f,2007).fault);
  Guard sag;sag.gain=1;
  auto r=sag.update(0,18,20,0,1.5f,.001f,0);
  assert(!r.fault && r.reason==Supply && r.gain<1);
  Guard amps;amps.gain=1;
  r=amps.update(0,20,20,1.65f,1.5f,.001f,0);
  assert(!r.fault && r.reason==Current && r.gain==1);
  r=amps.update(0,20,20,.2f,1.5f,.001f,1);
  assert(!r.fault && r.gain==1); // Current PI is never gated off by normal limiting.
  r=amps.update(0,20,20,1.51f,1.5f,.001f,2);
  assert(!r.fault && r.gain==1);
  r=amps.update(0,20,20,1.3f,1.5f,.001f,3);
  assert(!r.fault && r.gain==1);
  for(unsigned t=4;t<110;++t) {
    r=amps.update(0,20,20,.2f,1.5f,.001f,t);
    assert(!r.fault);
  }
  assert(r.gain>.999f); // Normal force recovers without session rearming.
  for(float a : {-1.5f,1.5f,-1.79f,1.79f}) {
    r=amps.update(0,20,20,a,1.5f,.001f,2);
    assert(!r.fault && r.gain==1 && r.reason==Current);
  }
  Guard oscillation;
  for(float emf : {-50.f,-10.f,0.f,10.f,50.f}) {
    const float lo=currentVoltageBound(emf,2.f,-1.2f,20.f,4095.f);
    const float hi=currentVoltageBound(emf,2.f,1.2f,20.f,4095.f);
    assert(lo<=hi && lo>=-4095 && hi<=4095);
    assert(fabsf(lo+currentVoltageBound(-emf,2.f,1.2f,20.f,4095.f))<.01f);
  }
  assert(fabsf(currentVoltageBound(0,2,1.2f,20,4095)-491.4f)<.01f);
  for(unsigned t=0;t<6;++t) assert(!oscillation.update(t%2?4000.f:-4000.f,20,20,0,1.5f,.001f,t*100).fault);
  assert(oscillation.update(-4000,20,20,0,1.5f,.001f,600).reason==Oscillation);
  Guard manual;
  for(unsigned t=0;t<1000;++t)assert(!manual.update(t%2?3600.f:-3600.f,20,20,0,1.5f,.001f,t).fault);
  Guard reset;
  assert(!reset.update(0,20,20,0,1.5f,.001f,0).fault);
  std::cout << "PASS interaction derating, coast, recovery, hard faults, oscillation\n";
}
