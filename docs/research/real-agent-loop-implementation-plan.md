# OpenScience 一期 Agent 闭环实施方案

以 [规格 #54](https://github.com/guch96/open-science/issues/54) 和它的子任务为准。起点是
`real-agent-loop.md`、`real-agent-loop-completed-20261120-evidence.json` 与
`recovery-interface-notes.md` 的历史调研。调研证明过核心 Notebook 与包迁移路径，不能作为本次构建的验收结果。
本轮代码核对基线：`b41cbc4be84e56c56f8c5e75581e50bcd181c7e2`。

一期保证外部 Agent、MCP 进程和 OpenScience 服务同机并共享可访问的文件系统。外部 Agent 从 README
英文提示语进入，安装或启动、发现本版本能力、检查准备状态，再按用户授权完成研究及交付。迁移时只把
`.science` 包带到另一个独立环境，先只读检查，用户同意后才 Fork、二次研究并再次导出。

## 基线核对与实施取舍

| 路径 | 可复用入口 | 本轮契约 |
| --- | --- | --- |
| 发现与准备 | SDK `doctor`、`bootstrap`、现有登录和配置流程 | CLI/MCP 共用能力定义、Schema、默认值、Handler 和错误；分别判断适配器已注册、服务是否支持、Agent/Notebook 是否就绪。服务未启动也可读本地指南。 |
| 研究提交与恢复 | `submitRun`、`getSubmission`、`waitForSubmission` 和服务端 TaskSubmissions | 显式 `projectId`；无 `sessionId` 新建。MCP 发送前持有并传入 `requestId`；CLI 自动生成时先落恢复记录。超时只结束观察，重连或重启后查原回执。 |
| Notebook | 现有 runtime、memory policy 和 execution intent | 外层 Run 状态独立于 dispatch、执行和人工停止。停止态只提供定位和用户继续入口，无自动重试或规避动作；检查 readiness 不创建执行域。 |
| Artifact | SDK 列举与内容响应、Artifact Owner | 显式区分 lineage、version 和 downloadId；MCP 与 CLI 共用无覆盖的本地交付。报告和结果表需对应当前研究；可信源端的大小与 SHA-256 匹配时才可验证交付。 |
| 包操作 | SDK export/import/fork 与既有 Package Owner | 复用 `.science` 格式。操作结果须与原操作关联；仅有相似快照时返回 `unconfirmed` 并停止自动重试。 |
| 敏感导出 | 服务端扫描与现有 Web/Desktop 风险审阅 | 确认须绑定具体导出及内容。Web RPC 的本地认证或默认 human caller 本身不能充当确认；自动调用方只观察原操作并获取已获准的交付。 |

验收分别检查 **readiness**（能否开始）、**execution**（实际执行了什么）和 **delivery**（实际交付了什么）。
文件核验通过不能证明计算正确，使用已知数据另行核对报告和结果表。以上三层状态、统一错误和敏感确认均为一期门槛。
既有 SDK 和持久数据兼容；旧 CLI/MCP 协议、远端文件交付、跨 Agent 模型迁移和订阅复用不在本期。

## 任务依赖与验证

1. [#55](https://github.com/guch96/open-science/issues/55) 建立共享注册、发现和基础 doctor。
   用真实 MCP stdio、CLI JSON 核对本地发现、Schema 与错误。
   当前入口为 CLI `tools list/describe/call --json` 和 MCP `list_capabilities`、`describe_capability`；
   指南通过 `openscience://agent/guide` 或 `get_agent_guide` 读取。目录默认离线，显式探测复用
   SDK 的 `/api/bootstrap`；旧服务未公告 doctor 时，可用只读 doctor 请求核对支持情况。
   `readiness.agent` 根据已有服务端检查投影，Notebook 状态目前保留 `unconfirmed`。
2. [#56–#61](https://github.com/guch96/open-science/issues/54) 接入资源、runtime/provider、Notebook readiness、持久研究、执行状态及 Artifact。
   在两个公开入口对齐语义；复用 Owner 测试验证重启、审批边界及源端文件校验。
3. [#62–#65](https://github.com/guch96/open-science/issues/54) 接入包导出、导入、Fork、查询和敏感确认。
   以真实 `.science` 和原操作关联证据区分可验证交付、待确认和未知结果。
4. [#66–#67](https://github.com/guch96/open-science/issues/54) 以实际构建的 npm 包运行 README 两条验收路径。
   只给提示语时，准备好后等用户研究指令；给包时在无源数据库、Notebook 工作目录或凭据的独立环境先只读检查。
5. [#68](https://github.com/guch96/open-science/issues/68) 在目标版本发布后从 registry 复验。
   本次实现与本地打包不发布 npm，也不以旧 registry 版本替代当前构建。

记录实际构建、环境隔离方式、用户动作、Project/Session/request/Run/operation 关联、Notebook dispatch、
Artifact/包校验和已知统计值。分别注明协议夹具、真实服务、真实 Notebook、registry 的结果；证据不含密钥或原始凭据。
