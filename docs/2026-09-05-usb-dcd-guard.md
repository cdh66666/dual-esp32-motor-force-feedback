# 2026-09-05：COM23 烧录完成，USB 稳定性仍未通过

后续状态已更新：8766 后台现在已自动重启并部署修复，独立串口通过一次 600 s，但真实后台仍复现失联；0.5.5 控制改进仅已编译。下文“后台未部署”保留为 21:33 历史记录，最新结果见 [22:32 更新](2026-09-05-control-timing-and-haptic-lever.md)。

对象：ESP32-S3，USB 序列号 `68EE8F52A79C`，36GP-555，后轴 MT6701，减速比 5.2。本次没有发送电机运动、WAKE 或校准写入命令。烧录前实时遥测 VM 为 0.26–0.28 V、PWM=0、awake=0；正常应用端口 COM23、下载端口 COM18 是同一 MAC，不是两块板。

## 1. 实际安装及证据

- 21:00 已安装 0.5.3，日志 `evidence/flashing/20260905-210002-usb-serialized-flash.log`。回读版本、STOP、SLEEP 成功。
- 21:26 已安装 **0.5.4-usb-dcd-guard**，日志 `evidence/flashing/20260905-212628-dcd-guard-flash.log`。所有写入分区通过 esptool 哈希校验，回读版本、STOP、SLEEP 成功。没有擦除 NVS 校准数据。
- 0.5.4 二进制 SHA256：`4c979d683fbc2e48b0183c03af4931bfe50174a5a1d2bee078deb40151f5fb70`。
- 21:28 状态证据：`evidence/link-stability/20260905-212807-state.json`。`USB_DCD_GUARD installed=1 irq_calls=60318 xfer_calls=25763 irq_max_us=77 xfer_max_us=27`，说明保护确实运行，不只是编译进去了。`USB_RECOVERY count=0`，驱动休眠。
- 压测失败后，21:33 在两帧实时断电状态通过预检后重新安装同一版本并恢复回包：`evidence/flashing/20260905-213303-dcd-guard-recovery.log`。交接快照为 `evidence/link-stability/20260905-213630-state.json`；恢复成功不是压测通过。
- 方向、电流极性、R=6.20926 Ω、Ke=0.022754 V/(rad/s)、电流 PI 600/600000、速度 PI 0.0008/0.016、外环 0.6 A 包络和 5.2 减速比保留。

## 2. 真实双向通信测试：两轮都失败

测试由网页后台提供实际串口读写，100 Hz 板端遥测，同时额外约 20 Hz MODEL 只读查询。计划每轮 120 s；失败即结束，不将断线重连算成连续通过。

| 固件 | 实际时长 | 成功查询 | 采样帧 | 帧率 | 最大帧间隔 | 回执中位/最大延时 | 结果 |
|---|---:|---:|---:|---:|---:|---:|---|
| 0.5.3-usb-serialized | 68.721 s | 1,335 | 6,718 | 100 Hz | 12 ms | 5.389 / 34.040 ms | MODEL 超时，随后写超时 |
| 0.5.4-usb-dcd-guard | 84.491 s | 1,649 | 8,295 | 100 Hz | 11 ms | 5.609 / 31.612 ms | MODEL 超时，随后写超时 |

原始文件：

- `evidence/link-stability/20260905-210043-report.json`、同名前缀 `-raw.jsonl`
- `evidence/link-stability/20260905-212807-report.json`、同名前缀 `-raw.jsonl`
- 故障后完整状态：`20260905-210304-state.json`、`20260905-213046-state.json`

**重要区别：失去命令回执后，S 帧及 MCU 时间仍在前进。** 波形能显示不代表电脑到板子的命令通道可用。0.5.3 故障后普通关闭/重开串口未恢复命令回包。本次两轮故障在电机供电关闭时复现，所以“只有 >1 A 电流才会触发”不成立；也不能由此证明全部硬件毫无问题。失败时间稍晚不是统计学稳定性改善证据。

## 3. 修复内容与未证实的假设

0.5.3 已将应用发送及 flush 调度到 TinyUSB 任务。检查本机 SDK 归档实际使用的是 `dcd_esp32sx.c.obj`，不是新 DWC2 驱动。旧驱动在任务和中断路径中都修改端点状态和 FIFO 掩码，因此 0.5.4 增加项目内链接包装，共用短临界区保护 USB ISR 与 `dcd_edpt_xfer/open/close_all/clear_stall/set_address`。没有修改全局 SDK；含硬件轮询等待的 `dcd_edpt_stall` 不放入临界区。

该并发风险是**待验证假设，不是已确认唯一根因**；0.5.4 实测仍失败，证明此改动不足以修好连接。进一步应对比独立串口客户端与网页后台，并记录 OUT 端点/接收队列状态；不能继续把调大 PID 或减少报错弹窗当作链路修复。

检索技能服务本次不可用，回退到官方原始代码核对：

- [TinyUSB 0.15.0 ESP32 DCD](https://raw.githubusercontent.com/hathach/tinyusb/0.15.0/src/portable/espressif/esp32sx/dcd_esp32sx.c)
- [TinyUSB 0.15.0 CDC 接收/发送实现](https://raw.githubusercontent.com/hathach/tinyusb/0.15.0/src/class/cdc/cdc_device.c)
- [Arduino ESP32 同类历史 USB 问题讨论](https://github.com/espressif/arduino-esp32/issues/6221) 仅作定位线索，不能替代本板根因证明。

## 4. 后台、工具及测试

- `recover_link` 不再因为 RX 新鲜就认定 OUT 正常：需写状态健康且 STOP/status 双向探测成功，否则走显式重开。不自动 WAKE、不恢复旧目标。
- 校验 `serial.write()` 返回的完整字节数；短写、0 写入视为失败，禁止默默当作成功或重发运动命令。
- **上述两项后端代码已修改并通过测试，但尚未部署。** 当前 8766 仍是 20:05 启动的 PID 81516；核对端口、PID、命令行后尝试仅重启此后台，被执行策略拦截。没有改用其他方式绕过策略。
- 全套 10 组离线检查最终通过，包括 29 项后端测试。一次并发测试因用 20 ms 睡眠碰撞 20 ms 超时而不稳定；已改为显式等待进入队列的同步屏障，保持“旧目标不得跨会话发送”的断言不变。
- 离线先前失败与最终通过报告分别保留在 `evidence/link-stability-offline/0.5.4-usb-dcd-guard/20260905-212948/checks.json` 和 `20260905-213243/checks.json`。工具中的 `flashed=false` 表示该离线测试脚本本身不执行烧录；实际安装证据见上节。
- 3 项烧录预检单测通过。第一次 0.5.4 烧录尝试因两次快照未前进而中止，没有发复位。预检改为最多 3 s 有界轮询，但仍要求真实新帧、会话一致、VM<1 V、PWM=0、awake=0；MCU 时间回退或供电开启立即拒绝。异常、陈旧遥测及任意“授权”标记不能替代电气状态证据。

## 5. 验收边界

烧录和版本回读已完成；持续双向 USB、通电大电流、连续运动、旋钮手感与温升均**没有通过本次验收**。保留保护和原参数。恢复后短时间回包只能表示当时可通信，不能覆盖上述两轮失败。继续运动验证前，先完成后台修复部署及不少于 120 s、继而 600 s 的连续双向链路测试。
