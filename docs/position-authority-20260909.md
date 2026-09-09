# 位置/速度电流环权限修复

用户确认力反馈已通过，本轮保留电流/力反馈/旋钮的模型电压边界和参数。仅 CONTROL_POSITION / CONTROL_VELOCITY 不再被尚未辨识的 R/Ke 电压边界截断，电流 PI 可使用已有 PWM/电压硬上限；目标仍限于配置电流的 80%。36GP 外环默认及电机配置加载后上限对齐 80%（本次 1.20 A）。位置最大速度仍为 28080 电机度/秒，即输出轴 15 r/s。网页默认跟随上述修改。

代码路径回归、interaction_guard、force_lifecycle、quick_control、编译通过。两板身份核对、带电静止预检、写入校验及回读成功，SHA256 B93C5BE73606784FEB432C89AC28B48C286900843FA4916E832C9FED10056D22。

用户本轮明确允许无人接触的小幅测试，执行 tools/verify_position_authority.cjs，逐台计划 +18/0/-18/0 输出度，保留原增益。证据 evidence/position-authority-live-1788927099947.json：COM4 四项通过，进入 ±0.5° 的时间 509/345/541/479 ms，末段平均绝对误差 0.0211/0.0212/0.0140/0.0135°，峰值电流最大 0.522 A。该测试不验证达到 15 r/s，也没有前版同条件基准，不能据此给出提速倍数。

COM23 wake 出现回执超时及 USB Write timeout，尚未开始位置运动。显式 recover-link 也返回 Write timeout；仍有新鲜 RX 遥测，样本确认 awake0、control idle、PWM0、速度0。没有通过绕过 STOP ACK 预检进行强制复位。总体测试 passed=false，需恢复 COM23 USB 后补测。COM4 最终 STOP/sleep 回执确认。

页面版本 position-current-authority-20260909；工具中心登记和 HTTP 健康检查通过，后台未重启。

## USB 恢复后的补测

用户回复 ok 后，新鲜枚举确认 COM23 USB 身份不变、写入和遥测均正常。仅对 COM23 执行同样四次 ±18° 小幅往返（--port=COM23），全部通过；报告 evidence/position-authority-live-1788927355377.json，passed=true。COM4 不重复运动。两板最终 STOP/sleep 回执确认，awake0、PWM0、idle。结合上一报告的 COM4 四项结果，两板均已完成本次小幅测试；USB 长期稳定性与实际 15 r/s 高速性能仍未验收。
