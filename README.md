# Dual ESP32-S3 Motor Control and Force Feedback

同一套 ESP32-S3 固件驱动两块相同电路板，提供：

- 2 kHz 电流环、200 Hz 速度环、100 Hz 位置环；
- MT6701 多圈位置、INA240A1 电机支路电流和母线电压遥测；
- 1 Mbaud、8N1、CRC16 的地址化单线 DATA 总线；
- 双板位置同步与双向虚拟弹簧/阻尼力反馈；
- 实时 USB 网页调试台和 CSV 原始过程导出。

## 统一固件原则

两块板烧录 `firmware/` 生成的同一个二进制文件。控制算法和默认环路参数不按 COM 口、USB 序列号或 MAC 分叉。每块板只在 NVS 中保存允许不同的装配校准：电机方向、电流检测极性、编码器零点和 DATA 总线地址。

## 安全状态

上电和复位默认 `nSLEEP=0`、PWM=0。任何闭环动作前先确认母线电压、`nFAULT=1`、编码器连续和电流零点正常。板级 SS6952T 参考限流约 5 A，统一固件软件上限为 4.5 A；调试应从更低电流开始。

## 目录

- `firmware/`：PlatformIO/Arduino ESP32-S3 固件；
- `web/`：本机串口网页后端与前端；
- `tools/`：电流、速度、位置参数辨识和阶跃测试；
- `tests/`：网页与双板联调冒烟测试；
- `docs/`：硬件关系、协议和验收指标；
- `evidence/`：脱敏后的版本测试结果。

## 本地运行

```powershell
cd firmware
pio run

cd ..\web
python server.py
```

浏览器打开 `http://127.0.0.1:8766/`。固件烧录前必须重新枚举 USB 身份，不能只相信历史 COM 号。

