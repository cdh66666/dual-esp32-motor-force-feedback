#include "../firmware/include/link_indicator.h"
#include <assert.h>
int main(){
 gateway::LinkIndicator led;
 assert(!led.lit(false,0));assert(led.lit(true,0));
 led.activity(100);assert(led.lit(false,100));assert(led.lit(false,3099));
 assert(!led.lit(false,3100));led.activity(UINT32_MAX-100);
 assert(led.lit(false,100));assert(!led.lit(false,3100));
 return 0;
}
