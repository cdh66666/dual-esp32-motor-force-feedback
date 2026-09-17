#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

namespace motor_wifi {
struct Request { uint32_t id, deadline; uint8_t address; char uid[17]; char command[97]; };
struct Response { uint32_t id; bool ok; char text[256]; };
bool begin(uint8_t address, uint64_t uid);
bool take(Request &request);
void reply(uint32_t id, bool ok, const char *text);
bool ready();
const char *ssid();
const char *password();
String diagnostics();
}
