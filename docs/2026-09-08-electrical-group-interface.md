# 电气模型与 PI 成组接口：软件阶段

固件新增 `cascade electrical` 高精度读回及 `cascade electrical R Ke KP KI MAX_PWM` 成组设置。所有参数验证及停机/未使能同步/未辨识检查先于写入；仅 RAM 候选，不写 NVS，不改变 1.5 A 电机设置、5.2 减速比或启动运动。

主机工具 `tools/electrical_configuration.cjs` 提供 STOP、整组快照、设置 ACK 与再次读回匹配；设置/读回失败会尝试 STOP 后恢复整组原值，恢复失败单独报告。旧固件接口不可用时不发送候选。恢复工具已允许 electrical 配置命令。

服务端增加命令范围校验及精度保留；原 cascade ACK 规则可识别新接口。没有修改网页自动整定调用，新工具尚未接入实机验证脚本。

## 验证

- PlatformIO esp32-s3-devkitc-1 编译成功，RAM 86252 bytes、Flash 449645 bytes。
- firmware.bin SHA256：F16F25F7B72C6A52CD9B671BC1FDC4089E7351D0C8D56EEE2DF74EB61A2E9BE3。
- JS 成组接口与恢复模拟测试共 4 项通过。
- 服务命令合约测试 18 项通过，包含新接口、越界、非数值与多余字段。

本轮尚未烧录，运行服务尚未重启到新代码，不能说设备已支持该接口。固件版本字符串仍为 0.5.9-sync-trace，新增 CAPS electrical_group=1；后续必须以能力、哈希及实机读回区分本构建，不得只看版本字符串。

仍需：板端部署与无运动读回/回退验收，验证脚本接入成组应用；COM23 模型方向误差尚未解决；全三环与力反馈仍不通过。
