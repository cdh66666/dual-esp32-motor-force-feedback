#pragma once
#include <Arduino.h>
#include "usb_tx_policy.h"
#if ARDUINO_USB_CDC_ON_BOOT && !ARDUINO_USB_MODE
#include "tusb.h"
#include "device/usbd_pvt.h"
#endif

// Control owns framing/production. TinyUSB's usbd task is the sole caller
// of the application TX operations, serializing them with CDC completion.
// usbd_defer_func can block on its event queue, so ONLY a dedicated worker
// invokes it; never the control loop or an interrupt. One job outstanding.
class DualConsole final : public Print {
 public:
  bool begin() {
#if ARDUINO_USB_CDC_ON_BOOT && !ARDUINO_USB_MODE
    lastServiceMs_.store(millis());
    ready_ = xTaskCreatePinnedToCore(scheduleTask, "usb_tx_schedule", 3072, this,
                                    2, &worker_, 0) == pdPASS;
#else
    ready_ = true;
#endif
    return ready_;
  }
  bool ready() const { return ready_; }
  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t *data, size_t count) override {
    if (!data) return 0;
    // Print may split one line into multiple writes. Publish/drop entire
    // newline-delimited records so a full queue never creates a fake frame.
    for (size_t i = 0; i < count; ++i) {
      const uint8_t c = data[i];
      if (!frameOverflow_) {
        if (frameSize_ < sizeof(frame_)) frame_[frameSize_++] = c;
        else frameOverflow_ = true;
      }
      if (c == '\n') {
        if (frameOverflow_ || !queue_.push(frame_, frameSize_)) {
          droppedBytes_.fetch_add(frameSize_);
          droppedFrames_.fetch_add(1);
        }
        frameSize_ = 0;
        frameOverflow_ = false;
      }
    }
    return count;
  }
  void pump() {
#if !(ARDUINO_USB_CDC_ON_BOOT && !ARDUINO_USB_MODE)
    const uint8_t *bytes;
    const size_t count = queue_.peek(bytes);
    const int room = Serial.availableForWrite();
    if (count && room > 0) queue_.consume(Serial.write(bytes, min(count, size_t(room))));
#endif
  }
  size_t pendingBytes() const { return queue_.size(); }
  uint32_t droppedBytes() const { return droppedBytes_.load(); }
  uint32_t droppedFrames() const { return droppedFrames_.load(); }
  uint32_t retryFlushes() const { return retryFlushes_.load(); }
  uint32_t disconnects() const { return disconnects_.load(); }
  uint32_t callbacks() const { return callbacks_.load(); }
  uint32_t maxServiceUs() const { return maxServiceUs_.load(); }
  uint32_t lastProgressMs() const { return lastProgressMs_.load(); }
  uint32_t stalledMs() const {
    if (!connected_.load()) return 0;
    const bool stalled = fifoStalled_.load();
    const uint32_t since = stalledSinceMs_.load();
    const uint32_t lastService = lastServiceMs_.load();
    const bool pending = queue_.size() != 0;
    // Load the clock AFTER worker timestamps; otherwise a tick between reads
    // could look like a UINT32_MAX-long stall and falsely trigger a restart.
    const uint32_t now = millis();
    const uint32_t fifoStall = stalled ? now - since : 0;
    const uint32_t serviceStall = pending ? now - lastService : 0;
    return max(fifoStall, serviceStall);
  }
 private:
#if ARDUINO_USB_CDC_ON_BOOT && !ARDUINO_USB_MODE
  static void scheduleTask(void *argument) {
    auto *self = static_cast<DualConsole *>(argument);
    for (;;) {
      if (!self->scheduled_.exchange(true)) {
        usbd_defer_func(service, self, false);
      }
      vTaskDelay(1); // no spin and at most one pending USB event
    }
  }
  static void service(void *argument) {
    auto *self = static_cast<DualConsole *>(argument);
    const uint32_t start = micros();
    const uint32_t now = millis();
    const bool connected = tud_cdc_n_connected(0);
    if (!connected) {
      if (self->connected_.exchange(false)) self->disconnects_.fetch_add(1);
      self->droppedBytes_.fetch_add(self->queue_.discard());
      self->fifoStalled_.store(false);
    } else {
      self->connected_.store(true);
      const uint8_t *bytes;
      const size_t count = self->queue_.peek(bytes);
      if (count) {
        struct Transport {
          size_t available() { return tud_cdc_n_write_available(0); }
          size_t write(const uint8_t *data, size_t size) { return tud_cdc_n_write(0, data, size); }
          void flush() { tud_cdc_n_write_flush(0); }
        } transport;
        const size_t sent = usb_link::pumpOnce(transport, bytes, min(count, size_t(64)));
        if (sent) {
          self->queue_.consume(sent);
          self->fifoStalled_.store(false);
          self->lastProgressMs_.store(now);
        } else {
          self->retryFlushes_.fetch_add(1);
          if (!self->fifoStalled_.load()) {
            self->stalledSinceMs_.store(now);
            self->fifoStalled_.store(true);
          }
        }
      } else {
        self->fifoStalled_.store(false);
      }
    }
    self->callbacks_.fetch_add(1);
    self->lastServiceMs_.store(now);
    const uint32_t elapsed = micros() - start;
    if (elapsed > self->maxServiceUs_.load()) self->maxServiceUs_.store(elapsed);
    self->scheduled_.store(false);
  }
  TaskHandle_t worker_ = nullptr;
#endif
  usb_link::SpscBytes<8192> queue_;
  uint8_t frame_[2048] = {};
  size_t frameSize_ = 0;
  bool frameOverflow_ = false, ready_ = false;
  std::atomic<bool> connected_{false}, scheduled_{false};
  std::atomic<bool> fifoStalled_{false};
  std::atomic<uint32_t> droppedBytes_{0}, droppedFrames_{0}, retryFlushes_{0};
  std::atomic<uint32_t> disconnects_{0}, callbacks_{0}, maxServiceUs_{0};
  std::atomic<uint32_t> stalledSinceMs_{0}, lastServiceMs_{0}, lastProgressMs_{0};
};
