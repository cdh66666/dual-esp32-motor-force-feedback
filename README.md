# Dual ESP32-S3 Motor Control and Force Feedback

同一套 ESP32-S3 固件驱动两块相同电路板，提供：

- 2 kHz 电流环、200 Hz 速度环、200 Hz 位置环；
- MT6701 多圈位置、INA240A1 电机支路电流和母线电压遥测；
- 1 Mbaud、8N1、CRC16 的地址化单线 DATA 总线；
- 双板位置同步与双向虚拟弹簧/阻尼力反馈框架；
- 实时 USB 网页调试台和 CSV 原始过程导出。

当前已验收两块带载板通过各自 USB 同时进行电流、速度和位置闭环；DATA 总线曾在空载状态通过 1 Mbaud 双向通信，但按当前调试范围，带载同步和力反馈暂未验收，网页会明确显示这一状态。

## 统一固件原则

两块板烧录 `firmware/` 生成的同一个二进制文件。控制算法和默认环路参数不按 COM 口、USB 序列号或 MAC 分叉。每块板只在 NVS 中保存允许不同的装配校准：电机方向、电流检测极性、编码器零点和 DATA 总线地址。

## 安全状态

上电和复位默认 `nSLEEP=0`、PWM=0。任何闭环动作前先确认母线电压、`nFAULT=1`、编码器连续和电流零点正常。板级 SS6952T 参考限流约 4.98 A；外环默认上限 4.8 A。固件只为短时限流验证接受最高 7 A 的诊断目标，实测电流仍由硬件钳位在约 5 A，不能把 7 A 当作连续工作能力。

## 目录

- `firmware/`：PlatformIO/Arduino ESP32-S3 固件；
- `web/`：本机串口网页后端与前端；
- `tools/`：电流、速度、位置参数辨识和阶跃测试；
- `tests/`：网页与双板联调冒烟测试；
- `docs/`：硬件关系、协议和验收指标；
- `evidence/`：脱敏后的版本测试结果。

## 换电脑直接运行

Windows 11 安装 Git、Python 3 和 PowerShell 7 后，在 PowerShell 7 执行：

```powershell
git clone https://github.com/cdh66666/dual-esp32-motor-force-feedback.git
cd dual-esp32-motor-force-feedback
python .\tools\launch_dashboard.py
```

脚本会安装 `pyserial`、启动本机网页服务并打开 `http://127.0.0.1:8766/`。网页实时枚举当前电脑的 ESP32 USB 串口，不依赖 COM18/COM19 这些历史端口号。给另一台电脑上的 Codex 仓库链接和一句“按 README 启动调试台”即可复现界面；实际控制前仍须确认新电脑识别到板卡并且板上固件版本一致。

## 编译与烧录

```powershell
python -m pip install platformio
cd firmware
pio run
pio run -t upload --upload-port COMx

cd ..\web
python -m pip install -r ..\requirements.txt
python server.py
```

浏览器打开 `http://127.0.0.1:8766/`。固件烧录前必须重新枚举 USB 身份，不能只相信历史 COM 号。

## 限时诊断与复位

- 电流目标每次拖动默认只保持 1.0 秒，范围 0.1–10 秒，到时由固件停止；
- 速度目标每次拖动默认只保持 3.0 秒，范围 0.1–30 秒，到时由固件停止；
- 电流和速度诊断不自动续租，位置保持仍按安全看门狗续租；
- `全部 STOP` 会停止并重新准备驱动；旁边的 `复位全部` 会对所有在线板执行 STOP、功率通路恢复和状态读取，不会恢复旧目标；
- 显示单位默认使用圈和 rps，可切换为角度和 °/s。
