# 持续低速辨识与旧补偿对照：未完成整定验收

## 当前事实

两块板均为 0.5.9-sync-trace，COM4 序列号 68EE8F5381E4，COM23 序列号 68EE8F52A79C。实机供电约 19.6–19.7 V，配置仍为 1.5 A 上限、5.2 减速比。没有重新烧录或启动力反馈。

## 排查与新实测

1. 对已有同步短脉冲，用位置的中心差分代替有滤波延迟的速度信号。两板机械模型仍未达到 25% 留出误差标准。附加方向偏差、简单周期项也未通过；这些探索不是可采用的校准。
2. 已检查本项目原理图 evidence/schematic_full_zoom.png：INA240A1 跨接 R15 10 mΩ，R15 串在 OUT1 与 MOTOR+ 之间。固件以 20 V/V × 10 mΩ = 0.2 V/A 换算。该拓扑不支持“直接把电源平均电流当成绕组电流”的猜测；并不证明实际焊接、器件型号或采样绝对精度已实测校准。
3. 使用 tools/collect_moving_mechanics.cjs，保留原 PI，临时把速度环上限从 0.6 A 降至 0.3 A，执行每段 600 ms 的输出轴 ±10/±20°/s 指令。每板 8 段，保留 25° 位移限制，并增加 180°/s、0.4 A、17–21 V 试验停止条件。板端租期 800 ms，USB/遥测失效中止；不是取消原固件保护。
4. 两板完成测试且未触发上述停止条件，但速度性能明显不合格。COM4/COM23 正负速度指令期间未观察到超过 2°/s 的反向运动样本；这不能排除未采到的瞬态或代表双向力反馈验收。

## 旧补偿差异与对照结果

新鲜 COGGING_CFG 回读：COM4 scale=0；COM23 scale=1、coulomb=0.137 A、offset=-0.0121 A。固件 rotorFeedforwardA 会把该补偿直接叠加到速度环电流指令，限幅 ±0.3 A。

第二轮使用 --neutral-compensation，临时将两板补偿比例置零，其他测试程序及 PI 不变。结束后恢复原比例，未写 NVS、未清除谐波表。

| 输出轴指标 | COM4 原配置 | COM4 补偿关闭对照 | COM23 原配置 | COM23 补偿关闭 |
|---|---:|---:|---:|---:|
| 全阶段速度跟踪 RMS / °/s | 10.461 | 10.425 | 18.864 | 12.175 |
| 实测速度绝对峰值 / °/s | 58.750 | 59.558 | 110.962 | 62.635 |

这是一次顺序对照，不是随机重复试验；起始角度、摩擦等可能变化。结果支持把旧补偿列为重要干扰项，但不能宣称它解释所有波动或已完全解决失控。

## 代码修复

- 网页自动整定现在要求新鲜的角度补偿回读，把原比例/库仑项/偏置加入回退记录。
- 辨识和复测时禁用旧补偿；失败恢复原值；若整套新参数通过，保留验证时的禁用状态，避免测试完成后另加未验证的补偿。
- 新增离线诊断 tools/diagnose_mechanical_trace.cjs、tools/analyze_moving_mechanics.cjs；探索模型不能写参数。
- auto_tune_cancel_test 覆盖补偿回退；语法、数据契约、三环合成数据和力反馈生命周期回归通过。
- 工具中心登记描述更新为 0.5.9 与实际验收状态；目标 HTTP200、工具中心 API 检查通过。未重启串口服务。

## 原始证据

- evidence/moving-mechanics-1788871968519.json：原补偿状态。
- evidence/moving-mechanics-1788872339029.json：补偿关闭对照及恢复回执。
- 第二轮最终两板均 idle、PWM0、速度约零；恢复原速度环 max_current=0.6 A；COM23 原补偿比例 1 已恢复。

## 仍需完成

机械模型在持续低速数据上仍不通过，不能据此直接采用外环增益。需要确认当前输出端真实负载，并把速度环非线性/补偿与参数搜索分别验证。没有宣称“最佳三环”或受力稳定性通过。

摩擦项探索参考 MathWorks 的 [Friction Modeling](https://www.mathworks.com/help/ident/ug/friction-modeling-matlab-file-modeling-of-static-siso-system.html) 与 [Rotational Friction](https://www.mathworks.com/help/simscape/ref/rotationalfriction.html)；这些参考不构成本电机的模型验收依据。
