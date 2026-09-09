# 发布证据

本目录只挑选当前交付所需的证据。原始故障快照、长时间采集、历史模型探索结果默认留在本机，不随提交上传；不会删除本机文件。

- `position-authority-live-1788927099947.json`：COM4 四项小幅位置验证通过，随后 COM23 USB 写超时，整轮 passed=false。
- `position-authority-live-1788927355377.json`：USB 恢复后仅 COM23 四项补测通过，最终两板 STOP/sleep。
- `position-authority-COM4-20260909.log`、`position-authority-COM23-20260909.log`：对应镜像编译、身份校验、写入及状态回读。

详细解释见 [位置修复与补测](../docs/position-authority-20260909.md)。不得隐藏失败记录后只引用成功样本，也不得将小幅测试换称高速或长期稳定性验收。仓库中更早已跟踪的证据文件保留，但不代表当前版本。
