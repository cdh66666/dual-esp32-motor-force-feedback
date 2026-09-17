#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Control-task-only observer. An ACK means the command handler accepted the
// request, not that a motion reached its target. Never infer success from TX.
namespace gateway {
class CommandResult {
 public:
  void begin() { active_=true; ok_=false; error_=false; size_=0; }
  void observe(uint8_t c) {
    if(!active_)return;
    if(c=='\n') {
      line_[size_]=0;
      if(strncmp(line_,"ERR ",4)==0 || strncmp(line_,"CASCADE fault",13)==0)error_=true;
      if(strncmp(line_,"OK ",3)==0)ok_=true;
      size_=0;
    } else if(c!='\r' && size_<sizeof(line_)-1)line_[size_++]=c;
  }
  bool finish() { active_=false; return ok_&&!error_; }
 private:
  bool active_=false,ok_=false,error_=false;
  size_t size_=0;
  char line_[96]{};
};
}
