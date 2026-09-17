#pragma once
#include <math.h>
#include <stdio.h>
#include <string.h>
namespace gateway {
inline bool readOnly(const char*c){return !strcmp(c,"ping")||!strcmp(c,"gatewayinfo")||!strcmp(c,"status");}
inline bool allowed(const char*c,float gear,float currentLimit){
  if(readOnly(c)||!strcmp(c,"stop")||!strcmp(c,"sleep")||!strcmp(c,"wake")||!strcmp(c,"recover"))return true;
  if(!strcmp(c,"sync status")||!strcmp(c,"sync off")||!strcmp(c,"sync stop"))return true;
  if(!strncmp(c,"sync force ",11)){
    int peer=0,duty=0,duration=0;float stiffness=0,damping=0,reflection=0,limit=0,offset=0;char extra=0;
    const int parsed=sscanf(c,"sync force %d %f %f %f %f %d %d %f %c",
        &peer,&stiffness,&damping,&reflection,&limit,&duty,&duration,&offset,&extra);
    return (parsed==7||parsed==8)&&peer>=1&&peer<=254&&isfinite(stiffness)&&
        isfinite(damping)&&isfinite(reflection)&&isfinite(limit)&&isfinite(offset)&&
        stiffness>=0&&stiffness<=1000&&damping>=0&&damping<=1000&&
        reflection>=0&&reflection<=4&&currentLimit>0&&
        limit>=10&&limit<=fminf(4500,currentLimit*800)&&
        duty>=12&&duty<=4095&&duration>=100&&duration<=30000&&fabsf(offset)<=36000;
  }
  char mode[16]{},extra;float value;int duty,duration;
  if(sscanf(c,"%15s %f %5d %4d %c",mode,&value,&duty,&duration,&extra)!=4||!isfinite(value)||duty<12||duty>4095||duration<100||duration>1000)return false;
  if(!strcmp(mode,"posout"))return fabsf(value)<=3600;
  if(!strcmp(mode,"velocity"))return gear>=1&&gear<=1000&&fabsf(value)<=fminf(60000,5400*gear);
  if(!strcmp(mode,"current"))return currentLimit>0&&fabsf(value)<=fminf(1000,currentLimit*800);
  return false;
}
}
