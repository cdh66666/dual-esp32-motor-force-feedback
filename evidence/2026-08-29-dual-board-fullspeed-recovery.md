# 双板 USB 与全速位置控制验收（2026-08-29）

## 软件修复

- 页面不再用 `focus=COM18` 过滤其他 ESP32；focus 只控制排序。
- 电流、速度和未到位的位置命令每 10 s 续租一次 30 s 固件看门狗；浏览器断开后仍会在 30 s 内安全停止。
- 位置到位/释放后停止续租，避免每 10 s 周期性重新启动。
- 串口写失败、续租失败、nFAULT、驱动休眠、母线欠压和固件超时使用居中阻塞弹窗提示。
- 位置环采用最大速度巡航与 `v=sqrt(2*a*x)` 近目标制动，默认加速度 100000 deg/s^2。
- 后端同时识别 ESP32-S3 HWCDC 与 TinyUSB CDC，并以 `DTR=true, RTS=false` 打开软件 CDC。

## USB 恢复

- COM18（MAC `68:EE:8F:52:A7:9C`）：ROM 无 stub 直写成功，运行固件 `0.4.5-fullspeed-position-watchdog-ui`。
- 原 COM19（MAC `68:EE:8F:53:81:E4`）：硬件 Serial/JTAG CDC OUT 持续 Write timeout；通过按序列号选择的 USB-JTAG 写入 TinyUSB 构建后恢复双向 CDC，Windows 重新分配为 COM4。
- COM18 与 COM4 均在网页后端达到 `active=true, write_ok=true`，均输出 100 Hz 遥测。

## 实机过程结果

### COM18

- 500 mA 电流指令：状态帧实测约 497 mA。
- 速度 1500 -> 3000 deg/s 连续改速：没有先回零；编码器过程行程 3444 deg，速度峰值 4689 deg/s。
- 360 deg 全速位置过程：速度目标峰值 6000 deg/s，实测峰值 4826 deg/s，电流峰值 2.76 A，PWM 峰值 592/4095，母线最低 19.28 V，nFAULT 始终为 1。
- 到位释放后最终 360.35 deg；反向回零释放后停在 12.26 deg，后者为磁槽释放策略的邻近停位。

### COM4（原 COM19）

- 速度 1500 -> 3000 deg/s 连续改速：编码器过程行程 3258 deg，速度峰值 4042 deg/s，电流峰值 1.79 A，PWM 峰值 347/4095。
- 360 deg 全速位置过程：速度目标峰值 6000 deg/s，实测峰值 5165 deg/s，电流峰值 3.44 A，PWM 峰值 1034/4095，最终 360.62 deg（误差 -0.62 deg）。
- 母线最低 19.28 V，nFAULT 始终为 1，无固件错误。

## 自动验证

- PlatformIO HWCDC 与 TinyUSB 两种构建均成功。
- 浏览器交互测试验证：双板可见、STOP 后自动准备、电流/速度/位置滑块可重新输出、跨模式最后目标生效、模拟 CDC Write timeout 时阻塞弹窗出现。
- 服务会话生命周期测试验证：旧读线程不会在重连后复活，监控线程不会自动 WAKE 驱动。
