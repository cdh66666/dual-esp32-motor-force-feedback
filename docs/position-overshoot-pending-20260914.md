# 不超调优化：未完成，COM23 USB 恢复待处理

2026-09-14 用户要求不超调且响应接近当前性能。此前测试仅要求尾段定位稳定，未验收整个过程不越过目标。

基线 `position-authority-live-1789356569254.json`：COM4 峰值超调最大 0.7481°，COM23 最大 1.2289°（后轴推算输出角度，100 Hz 遥测）。不能称为不超调。

本轮增加 `overshootDeg`、`settleHalfDegreeMs` 指标；现有 `passed` 仍只表示原尾段定位标准，不表示不超调通过。

未采用的候选：

- 增加位置 Kd=0.25：COM4 超调仍达 1.48°，尾段失败，记录 `position-authority-live-1789357057782.json`。
- 降低速度 Ki=0.001：明显变慢并出现超调，记录 `position-authority-live-1789357105150.json`。
- 原增益、位置加速度设为 5000：仍有超调，记录 `position-authority-live-1789357176961.json`；已把两台 RAM 加速度恢复到 40000。
- 仅 COM23 烧录位置减速时速度积分按 25/s 衰减的候选：原 Kd=0.05 最大超调 0.702°；Kd=0.4 仍达 0.546°且部分步骤变慢。记录 `position-authority-live-1789357267674.json` 和 `position-authority-live-1789357294313.json`。未验收、未保存候选增益。
- 进一步 100/s 衰减候选编译成功，但在进入 ROM 时失败，未烧录：`evidence/position-braking-fast-unwind-20260914.log`。

## 交接状态（重要）

- COM4 没有烧录本轮候选，已恢复原独立参数和加速度，保持停止。
- **COM23 上仍是 25/s 衰减的未验收候选固件**。最后通信时 RAM 的位置 Kd=0.4；NVS 仍为已验收 Kd=0.05，其余独立增益未保存更改。
- 进入 USB 维护前真实读回 awake=0、PWM=0、idle；随后 Windows ERROR_GEN_FAILURE(31)，未能进入 ROM，应用 COM23 名称仍存在但不能配置串口。
- 已退出后台 maintenance 并尝试 recover-link，仍报同一 Windows 错误。需要物理重新插拔 COM23 USB，恢复后先核对序列号、STOP/sleep，再恢复已验收固件与参数；不得自动恢复运动。
- **源码已撤回积分衰减候选，恢复本轮之前的固件逻辑；尚不能把源码回退说成板端回退。** `.pio` 中最后构建镜像是未烧录的 100/s 候选，不能直接拿旧缓存烧录，必须重新编译当前源码。
- 用户常用行程和负载已通过非阻塞问题询问，尚未答复；只有 ±18° 空载样本，不能外推所有运动工况零超调。
