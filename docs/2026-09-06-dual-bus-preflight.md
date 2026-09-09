# 双板 DATA 总线实查（2026-09-06）

通过现有 8766 后台查询，未重启、烧录或启用运动。

| 项目 | COM23 | COM4 |
|---|---|---|
| USB 序列号 | 68EE8F52A79C | 68EE8F5381E4 |
| 固件实读 | 0.5.4-usb-dcd-guard | 0.5.5-control-timing |
| 电机档案实读 | 36gp555-24v-1538rpm | 775-12-24v |
| DATA 地址 | 1 | 184 |
| 电压遥测 | 约 19.46 V | 约 19.35 V |
| 初始状态 | awake=0, pwm=0, sync off | awake=0, pwm=0, sync off |

USB 两板均有新鲜遥测，model/status 查询收到真实回执。

依次以 1000000、115200、1000000 baud 双向发送 ping，每个请求含两次重试。最终已恢复两板 1000000 baud。

- COM23：rx_bytes=0, valid=0, cmd_rx=0, tx=9, response_tx=0。
- COM4：rx_bytes=126, valid=9, addressed=9, cmd_rx=9, tx=18, response_tx=9。
- 初次双向查询都出现 BUS_TIMEOUT；COM4 的接收及回复计数证明 COM23 到 COM4 的请求可达，反向未被 COM23 接收到。降速后同样无 COM23 接收字节。
- 这些证据还不能区分 COM4 发射电路、线缆、COM23 接收电路或 UART 状态。需要断电后的接线检查和受控恢复，再重复测试；不能直接认定 U6 损坏。

后台未给 businfo/sync status 配置 wait_ack 匹配器。本次使用普通下发后读取当前日志中的 BUS/SYNC 实际回包验证，没有把 HTTP 发送成功算作总线成功。

首次检查时提出断电恢复；随后用户明确要求保持供电，并确认两台实物均为 36GP-555。按此继续进行了以下带电、驱动休眠检查，没有复位或烧录。历史 dual_force_test.py 默认 2 A 和自动 wake 未运行。双板力反馈尚未验收。

## 保持供电的后续实测

- COM4 执行 `motorprofile 36gp555` 收到板端确认，并回读为 `36gp555-24v-1538rpm`，gear=5.20。新档案 identified=0/0，说明本装配尚未做参数辨识；没有复制 COM23 的个体标定。
- 执行 `tools/dual_bus_preflight.py`，以 115200、250000、500000、750000、1000000 baud 分别双向发起 5 次 ping。
- 每档 COM23 → COM4：COM23 发出 15 帧（包括重试），COM4 接收 15 个有效请求、生成 15 次回复；COM23 接收仍为 0。
- 每档 COM4 → COM23：COM4 发出 15 帧（包括重试），COM23 接收为 0。
- 全部测试合计 COM4 收到 75 个有效请求并生成 75 次回复；COM23 始终未收到字节。降速不能恢复这次故障。
- 结束已恢复双方 1 Mbaud，真实 STATUS 回执均为 awake=0、PWM=0、control=idle，母线约 19.46/19.35 V。

原始日志：`evidence/2026-09-06-powered-dual-bus.jsonl`（14 条 JSON 记录）。UART 软件发送计数不等于实际引脚波形；当前仍无法仅靠计数区分发射电路、接收电路或 UART 状态。现有固件没有独立 GPIO 边沿诊断或 UART 重初始化命令。下一步有效证据是 COM4 GPIO41/BUS_TX、DATA、COM23 GPIO42/BUS_RX 的同步波形，用于判断信号在哪一段消失。不能据此直接宣告硬件已坏或力反馈已调好。
