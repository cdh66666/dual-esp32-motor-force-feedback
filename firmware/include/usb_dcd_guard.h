#pragma once
#include <stdint.h>

struct UsbDcdGuardStats {
  uint32_t irqCalls, transferCalls, irqMaxUs, transferMaxUs;
  bool installed;
};
UsbDcdGuardStats usbDcdGuardStats();
