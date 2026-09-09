# 80% 工作电流限幅与示波器显示

网页和固件均按已配置电流的 80% 限制力反馈目标；固件电流内环最终目标统一限幅，手动电流页面同步限幅。双板本次回读 current_limit=1.50 A，对应工作目标上限 1.20 A（手动滑条仍是 ±1 A）。不提高保护阈值：实测达到配置上限时当前周期撤去 PWM，保持会话；超过配置上限 1.2 倍的严重过流仍停止。指令限幅不构成实测电流无尖峰的证明。

截图对应故障已不在读取时的环形日志窗口，无法报告该次峰值或确认全部原因。原代码允许工作指令达到 100% 配置值，未预留本次要求的余量。

COM4 第一次预检 sync off 被另一个 STOP 取消，未烧录；停止两板后重试成功。COM4、COM23 均完成身份核对、带电静止预检、写入校验、重新连接和 STOP/sleep 回读，PWM=0、awake=0、idle，无运动测试。保留各板原方向和三环增益。

镜像 SHA256：DE2BC2B3F5A6B2EC63CC8B446C6EA83E832DF64601B8ADDBBEFBABCB49BEFD5C。
日志：evidence/current80-flash-COM4-20260909.log、current80-flash-COM4-retry-20260909.log、current80-flash-COM23-20260909.log。

目标虚线改为 #ff4055、2.4 px、9/5 虚线；加红色图例。图窗常规高度 300–540 px，矮屏 240 px（之前最低 200 px），保留 980×670 下滑条同屏。scope_contract、quick_control、force_lifecycle、interaction_guard、interaction_ui、usb_identity 测试通过。网页/工具中心健康检查通过。图形测试数据为模拟数据，不是实机性能验收。
