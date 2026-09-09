# 用户确认后带电部署与成组参数实机验证

用户回复“测试过可以继续”，结合此前明确的带电烧录要求、手柄拆除及隔离防护说明，本轮按电机接线仍连接的真实条件执行。新增显式 --attached-guarded 流程，与断电/接线拔下流程分开；要求 STOP/sync off/sleep ACK、idle、PWM0、速度近零、nFAULT1、8–21 V，再复查。不能与“接线拔下”或无 ACK 被动恢复选项混用。没有执行运动命令。

两板写入相同新镜像，各段 esptool Hash of data verified：
- COM4 USB 68EE8F5381E4，ROM COM19，返回 COM4。
- COM23 USB 68EE8F52A79C，ROM COM18，返回 COM23。

COM4 写入成功后，PlatformIO Python 缺 esptool 模块导致工具退出；没有重复写入，核实 ROM 身份后用已安装 esptool 的 Python313 完成复位，恢复维护锁与连接。COM23 用 Python313 完整流程退出0。工具现已在复位之前检查 platformio/esptool 模块，避免再在写入后才暴露依赖缺失。

## 新鲜实机验证

记录 `evidence/electrical-group-roundtrip-1788881910856.json`：两板均 passed=true。在休眠状态将 R/Ke/Kp/Ki/maxPWM 五字段改为不同值，ACK和重新查询一致，然后恢复原值，读回确认成功。该测试不是电机运动性能验收。

原值恢复为 R2、Ke.011、Kp600、Ki600000、maxPWM4095。两板 motorprofile 读回均保留1.50 A / 5.20，母线约19.6–19.7 V。最终 awake0、PWM0、idle、速度0；复位后多圈坐标为0，没有自动恢复旧位置目标。

本轮证明写入校验、应用重连、新配置接口及回退可用，不证明复位期间驱动输出没有瞬态：该阶段没有独立示波器测量。也不能据此认证所有故障条件下在线烧录。新镜像版本字符串仍为0.5.9-sync-trace，以新增接口实测和既有SHA256记录区分构建。

原断电等待条件因用户再次明确继续带电测试而解除；后续继续模型与PI配套实测。COM23模型方向误差、三环参数和受力稳定性仍未验收。
