#pragma once
#include <cstddef>
#include <cstdint>
#include <atomic>
#include <cstring>

namespace usb_link {
// One producer (control task), one consumer (USB task). Endpoints and FIFO
// calls never run in the producer. Publish a complete frame in one release.
template <size_t Capacity> class SpscBytes {
  static_assert(Capacity > 0, "nonzero capacity required");
  static_assert((Capacity & (Capacity - 1)) == 0, "power-of-two capacity required");
  static_assert(Capacity < 0x80000000u, "counter distance must be unambiguous");
 public:
  explicit SpscBytes(uint32_t cursor = 0) : head_(cursor), tail_(cursor) {}
  bool push(const uint8_t *data, size_t count) {
    const uint32_t head = head_.load(std::memory_order_relaxed);
    const uint32_t tail = tail_.load(std::memory_order_acquire);
    if (count > Capacity || count > Capacity - uint32_t(head - tail)) return false;
    for (size_t i = 0; i < count; ++i) data_[(head + i) & (Capacity - 1)] = data[i];
    head_.store(head + uint32_t(count), std::memory_order_release);
    return true;
  }
  size_t size() const {
    const uint32_t tail = tail_.load(std::memory_order_acquire);
    return uint32_t(head_.load(std::memory_order_acquire) - tail);
  }
  size_t peek(const uint8_t *&bytes) const {
    const uint32_t tail = tail_.load(std::memory_order_relaxed);
    const size_t count = uint32_t(head_.load(std::memory_order_acquire) - tail);
    const size_t contiguous = Capacity - (tail & (Capacity - 1));
    bytes = data_ + (tail & (Capacity - 1));
    return count < contiguous ? count : contiguous;
  }
  void consume(size_t count) {
    tail_.store(tail_.load(std::memory_order_relaxed) + uint32_t(count),
                std::memory_order_release);
  }
  size_t discard() {
    const uint32_t head = head_.load(std::memory_order_acquire);
    const uint32_t tail = tail_.load(std::memory_order_relaxed);
    tail_.store(head, std::memory_order_release);
    return uint32_t(head - tail);
  }
 private:
  uint8_t data_[Capacity] = {};
  std::atomic<uint32_t> head_, tail_;
};

enum class LineResult { None, Ready, Rejected };
template <size_t Capacity> class CommandLine {
  static_assert(Capacity > 1, "command and terminator required");
 public:
  LineResult feed(char c) {
    if (c == '\r' || c == '\n') {
      if (bad_) { clear(); return LineResult::Rejected; }
      if (!length_) return LineResult::None;
      bytes_[length_] = 0;
      length_ = 0;
      return LineResult::Ready;
    }
    if (bad_) return LineResult::None;
    if ((static_cast<uint8_t>(c) < 32 && c != '\t') ||
        static_cast<uint8_t>(c) > 126 || length_ >= Capacity - 1) {
      bad_ = true;
      return LineResult::None;
    }
    bytes_[length_++] = c;
    return LineResult::None;
  }
  const char *text() const { return bytes_; }
  void clear() { length_ = 0; bad_ = false; bytes_[0] = 0; }
 private:
  char bytes_[Capacity] = {};
  size_t length_ = 0;
  bool bad_ = false;
};

// One bounded attempt: even a full FIFO needs a flush/retry kick. It can
// contain bytes without an IN transfer in flight after a failed claim.
// Never spin until space becomes available in the motor-control task.
template <class Transport>
size_t pumpOnce(Transport &usb, const uint8_t *bytes, size_t count) {
  const size_t room = usb.available();
  if (room == 0) { usb.flush(); return 0; }
  const size_t sent = usb.write(bytes, count < room ? count : room);
  usb.flush();
  return sent;
}

// Stored with RTC_NOINIT_ATTR, not RTC_DATA_ATTR: normal software startup
// reinitializes .rtc.data. Validate retained bytes before trusting a limit.
struct Recovery {
  uint32_t magic, count, inverse, pending, stallMs;
};
constexpr uint32_t recoveryMagic = 0x55425232;
inline void boot(Recovery &r, bool powerOn) {
  if (powerOn || r.magic != recoveryMagic || r.count > 2 ||
      r.inverse != ~r.count || r.pending > 1) {
    r = {recoveryMagic, 0, ~uint32_t(0), 0, 0};
  }
}
inline bool requestRecovery(Recovery &r, uint32_t stallMs) {
  if (r.count >= 2) return false;
  ++r.count;
  r.inverse = ~r.count;
  r.pending = 1;
  r.stallMs = stallMs;
  return true;
}
} // namespace usb_link
