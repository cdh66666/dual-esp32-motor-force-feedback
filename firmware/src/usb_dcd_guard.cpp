// Project-local serialization of the pinned legacy ESP32 USB DCD.
// The SDK's dcd_esp32sx.c ISR and dcd_edpt_xfer both change xfer_status
// and USB FIFO masks. A single USB task does not exclude an ISR on the
// other CPU. Guard both sides of these short, nonblocking operations.
// Linker wrapping leaves the global Arduino SDK and other peripherals alone.
#include <Arduino.h>
#include "usb_dcd_guard.h"

#if defined(PROJECT_USB_DCD_GUARD) && ARDUINO_USB_CDC_ON_BOOT && !ARDUINO_USB_MODE
#include "device/dcd.h"
#include "esp_intr_alloc.h"
#include "esp_timer.h"
#include "soc/periph_defs.h"

static portMUX_TYPE dcdMux = portMUX_INITIALIZER_UNLOCKED;
static UsbDcdGuardStats stats{};
static intr_handler_t originalUsbIsr = nullptr;
static void *originalUsbArgument = nullptr;

static void guardedUsbIsr(void *) {
  portENTER_CRITICAL_ISR(&dcdMux);
  const uint32_t start = static_cast<uint32_t>(esp_timer_get_time());
  originalUsbIsr(originalUsbArgument);
  ++stats.irqCalls;
  const uint32_t elapsed = static_cast<uint32_t>(esp_timer_get_time()) - start;
  if (elapsed > stats.irqMaxUs) stats.irqMaxUs = elapsed;
  portEXIT_CRITICAL_ISR(&dcdMux);
}

extern "C" esp_err_t __real_esp_intr_alloc(int, int, intr_handler_t, void *, intr_handle_t *);
extern "C" esp_err_t __wrap_esp_intr_alloc(int source, int flags,
    intr_handler_t handler, void *arg, intr_handle_t *handle) {
  if (source != ETS_USB_INTR_SOURCE || !handler) {
    return __real_esp_intr_alloc(source, flags, handler, arg, handle);
  }
  // Pinned SDK uses a non-shared, non-IRAM USB ISR. Refuse an incompatible
  // future driver rather than wrapping shared/IRAM code with flash code.
  if ((flags & (ESP_INTR_FLAG_SHARED | ESP_INTR_FLAG_IRAM)) || stats.installed) {
    return ESP_ERR_INVALID_STATE;
  }
  originalUsbIsr = handler;
  originalUsbArgument = arg;
  const esp_err_t result = __real_esp_intr_alloc(source, flags, guardedUsbIsr, nullptr, handle);
  stats.installed = result == ESP_OK;
  return result;
}

class DcdSection {
 public:
  DcdSection() { portENTER_CRITICAL(&dcdMux); }
  ~DcdSection() { portEXIT_CRITICAL(&dcdMux); }
};

extern "C" bool __real_dcd_edpt_xfer(uint8_t, uint8_t, uint8_t *, uint16_t);
extern "C" bool __wrap_dcd_edpt_xfer(uint8_t port, uint8_t endpoint, uint8_t *buffer, uint16_t length) {
  DcdSection lock;
  const uint32_t start = static_cast<uint32_t>(esp_timer_get_time());
  const bool result = __real_dcd_edpt_xfer(port, endpoint, buffer, length);
  ++stats.transferCalls;
  const uint32_t elapsed = static_cast<uint32_t>(esp_timer_get_time()) - start;
  if (elapsed > stats.transferMaxUs) stats.transferMaxUs = elapsed;
  return result;
}

extern "C" bool __real_dcd_edpt_open(uint8_t, tusb_desc_endpoint_t const *);
extern "C" bool __wrap_dcd_edpt_open(uint8_t port, tusb_desc_endpoint_t const *descriptor) {
  DcdSection lock;
  return __real_dcd_edpt_open(port, descriptor);
}
extern "C" void __real_dcd_edpt_close_all(uint8_t);
extern "C" void __wrap_dcd_edpt_close_all(uint8_t port) {
  DcdSection lock; __real_dcd_edpt_close_all(port);
}
// Do NOT wrap dcd_edpt_stall: the legacy driver polls hardware there and
// holding an interrupt critical section across its waits would be unsafe.
extern "C" void __real_dcd_edpt_clear_stall(uint8_t, uint8_t);
extern "C" void __wrap_dcd_edpt_clear_stall(uint8_t port, uint8_t endpoint) {
  DcdSection lock; __real_dcd_edpt_clear_stall(port, endpoint);
}
extern "C" void __real_dcd_set_address(uint8_t, uint8_t);
extern "C" void __wrap_dcd_set_address(uint8_t port, uint8_t address) {
  DcdSection lock; __real_dcd_set_address(port, address);
}

UsbDcdGuardStats usbDcdGuardStats() {
  DcdSection lock;
  return stats;
}
#else
UsbDcdGuardStats usbDcdGuardStats() { return {}; }
#endif
