#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace gateway {
// Covers the sender's two 80 ms retries. Fixed lifetime (not refreshed by
// duplicates) avoids suppressing later intentional commands indefinitely.
class BusCommandCache {
 public:
  const char *find(uint8_t source, uint8_t seq, const char *command, uint32_t now) const {
    for (const auto &entry : entries_) {
      if (entry.valid && uint32_t(now - entry.at) <= 300 &&
          entry.source == source && entry.seq == seq && !strcmp(entry.command, command))
        return entry.response;
    }
    return nullptr;
  }
  void remember(uint8_t source, uint8_t seq, const char *command,
                const char *response, uint32_t now) {
    if (strlen(command) >= sizeof(entries_[0].command) ||
        strlen(response) >= sizeof(entries_[0].response)) return;
    auto &entry = entries_[next_];
    next_ = (next_ + 1) % 8;
    entry.valid = true; entry.source = source; entry.seq = seq; entry.at = now;
    strcpy(entry.command, command); strcpy(entry.response, response);
  }
 private:
  struct Entry {
    bool valid = false;
    uint8_t source = 0, seq = 0;
    uint32_t at = 0;
    char command[97] = {}, response[160] = {};
  } entries_[8];
  size_t next_ = 0;
};
}
