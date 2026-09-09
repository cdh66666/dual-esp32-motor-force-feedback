# USB 换口识别修正

2026-09-09：现场读取 /api/ports，COM4（68EE8F5381E4）和 COM23（68EE8F52A79C）均有有效遥测，未复现当前断连。后台已动态枚举 ESP32 USB 端口；前端原先仅以 COM 号缓存板对象，缺少身份迁移处理。

前端现在通过 USB SER 匹配同一块板，忽略 USB LOCATION。COM 变化或同 COM 换板时，销毁旧卡片和事件流、取消旧运动续发，重新建立板状态并读取板端参数；不复制旧目标或参数，不自动恢复运动。保留原有自动连接新枚举端口机制。没有序列号时不猜测板身份。连接摘要区分有效遥测和等待遥测。

验证：node --check，以及 usb_identity_contract、connect_recovery_contract、link_recovery_ui_test、scope_contract_test、quick_control_test 全部通过。换口及同口换板使用隔离模拟验证；没有进行物理 USB 插拔验收，也没有启动运动或烧录。当前修正不能替代 Windows USB 枚举故障或板端无响应的硬件排查。

前端版本 usb-identity-20260909；静态文件更新，无需重启后台。
