#pragma once
#include <stdint.h>
namespace gateway {
class LinkIndicator {
 public:
  void activity(uint32_t now) { seen_=true; last_=now; }
  bool lit(bool usbOpen, uint32_t now) const {
    return usbOpen || (seen_ && uint32_t(now-last_)<3000);
  }
 private:
  bool seen_=false;
  uint32_t last_=0;
};
}
