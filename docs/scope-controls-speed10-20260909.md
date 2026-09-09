# 双窗操作台与高速起点调整

- 默认通道：位置、电流。原有四通道纵轴、缩放、冻结保留。
- 图下三行：位置偏移、速度、电流；选择两台或上/下窗单台。
- 小/中/大半量程：位置 0.025/0.25/1 圈，速度 0.1/1/3 r/s，电流 0.1/0.3/0.6 A。目标仍检查板端电流配置；量程切换保留当前目标，不发送。
- 首次点执行，随后同模式松开滑条更新。每台仅一种主控模式；双台经 USB 分别发指令，不是硬件同步触发。位置偏移相对本轮起点。原有固件租约/运行时限保留。
- 速度减力起点改为输出轴 10 r/s，12 r/s 到零增益滑行，不因此结束会话。其余电流、供电、反馈和振荡保护不变。
- 固件 SHA256：B51E2CC75653EF05A91B5B8BC621FAA32FF2D160FC3705440C30F49E7E09293E。
- COM4 / COM23 已按 USB 身份匹配烧录并校验，最终 idle、awake=0、PWM=0。日志为 evidence/speed10-flash-COM4-20260909.log 与 COM23 同名日志。
- 通过：interaction_guard_test、scope_contract_test、quick_control_test、interaction_ui_test、force_lifecycle_contract_test、JS 语法与固件编译。界面截图 evidence/quick-controls-20260909.png。
- 验证边界：本轮没有运行实机高速或带载力反馈；阈值变更不等于 10 r/s 稳定性、手感或持续电气/热安全验收。未自动恢复运动。
