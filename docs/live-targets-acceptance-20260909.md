# 力反馈显示与换向门槛

用户本轮明确确认当前力反馈手感验收通过。此确认不扩展为新固件全部工况、持续热负载或电源反灌安全验收。未更改手感增益。

- 主界面测量/目标/坐标刻度统一两位小数，控制值、采样和原始日志不截断。
- 实测实线与目标虚线使用同一通道纵轴，自动量程同时包含目标。PWM 无独立目标，不伪造虚线；力反馈没有速度环目标时不画虚假速度参考。
- S 遥测末尾追加 modelTargetPositionDegrees 与 force-active 标记；旧列位置保留。力反馈位置虚线来自板端对端位置加偏移，而非把电流目标当位置。
- 力反馈启动清除冻结，运行中保持实时视图和数值刷新。保持原有 50 Hz USB 遥测；位置、速度、电流、PWM 数值即使通道未勾选也更新。过期数据显示过期，不伪造实时值。
- 高速换向计数从旧输出轴 120°/s 改为超过 3600°/s，即 10 r/s。1 秒内达到 6 次高速方向变化仍保护；每窗口重置方向，避免跨窗口计数。0–10 r/s 的交替手动摆动不触发这条高速换向保护。其他电气/反馈保护保留。
- 两板刷写日志：evidence/live-targets-COM4-20260909.log、COM23 同名。SHA256 B9A3ADEC5CD1D96A5C3545DB733DAC42C6622A50AD9AABB1F7EE1E7038176942。
- interaction_guard_test、scope_contract_test、quick_control_test、force_lifecycle_contract_test、interaction_ui_test 通过。在线确认两板遥测已扩展为 27 列，PWM=0、awake=0。未主动重复用户受力测试、未自动恢复运动。
- evidence/live-targets-offline.png 为模拟样本 UI 测试截图，不是电机实测性能证据。
