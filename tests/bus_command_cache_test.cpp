#include "../firmware/include/bus_command_cache.h"
#include <assert.h>
#include <string.h>
int main() {
  gateway::BusCommandCache cache;
  cache.remember(1, 42, "current 50 100 1000", "ACK,42,accepted", 1000);
  assert(cache.find(1,42,"current 50 100 1000",1080));
  assert(cache.find(1,42,"current 50 100 1000",1160));
  assert(!cache.find(2,42,"current 50 100 1000",1080));
  assert(!cache.find(1,43,"current 50 100 1000",1080));
  assert(!cache.find(1,42,"current 60 100 1000",1080));
  assert(!cache.find(1,42,"current 50 100 1000",1301));
  cache.remember(1, 0, "wake", "NACK,0,rejected", UINT32_MAX-40);
  assert(!strcmp(cache.find(1,0,"wake",40),"NACK,0,rejected"));
  assert(!cache.find(1,0,"wake",400));
  for (int i=0; i<8; ++i) cache.remember(2,i,"arm","ACK",500);
  assert(!cache.find(1,0,"wake",500));
  return 0;
}
