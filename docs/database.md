# SpacetimeDB 接入与规则说明

`spacetimedb/src/index.ts` 是实际的 TypeScript 数据库模块，SDK 固定为 `2.13.0`。`submit_evidence` Reducer 在数据库事务内部调用 `packages/domain/src/index.ts` 中的规则，再原子更新资产、依赖、任务和通知表。本地服务器复用同一份规则来提供无需账号的演示环境。

当前交付已通过 TypeScript 检查、纯规则测试和官方 SpacetimeDB 内存数据存储测试。尚未向真实 SpacetimeDB 发布，也没有预先配置你的数据库身份或凭证；本地模式不等同于已连接 SpacetimeDB。

## 模块边界

```text
Agent A/B/C/D (each with a separate identity)
  ├─ SELECT * FROM my_sources    ← only that agent's assigned raw document
  ├─ update_agent_status         ← reading / extracting / error / stopped
  └─ submit_evidence             ← source id + extracted facts only
         │
         ▼ SpacetimeDB transaction
      Validate identity, source and payload
      Rule A: deployed version ∈ affected range
      Rule B: reverse dependency reachability
      Rule C: severity + business importance + dependency reach
      Rule D: ownership → incident task + department notification
         │
         ▼ committed subscriptions
      asset_risk / incident_task / department_notification / dashboard_world
```

Agent 没有写最终风险、优先级或任务的 Reducer。跨 Agent 写证据、引用他人的资料、在证据中添加 `finalRisk` / `tasks` 等额外字段都会被拒绝。管理员、操作员与 Agent 使用不同身份。

## 表与视图

| 名称 | 访问 | 用途 |
| --- | --- | --- |
| `raw_source` | private | 公告、依赖、生产部署、负责人四份原始资料 |
| `evidence` | private | Agent 提交的结构化证据及原始资料 ID |
| `world_state` | private | 同一事务内持久化的完整世界快照 |
| `admin` / `operator` / `agent_identity` | private | 发布者、指挥界面和 A/B/C/D 的身份授权 |
| `my_sources` | caller-scoped public view | 只返回该 Agent 的资料；未注册身份返回空集 |
| `dashboard_world` | operator-scoped public view | 管理员或操作员的完整快照；Agent 返回空集 |
| `incident` | public read | 唯一漏洞事件 |
| `asset_risk` | public read | 推导状态、原因、证据 ID、影响路径 |
| `dependency` | public read | 组件和服务依赖关系 |
| `incident_task` | public read | 由规则产生的部门抢修任务 |
| `department_notification` | public read | Inbox 实际读取的通知记录 |
| `agent_state` | public read | 每个 Agent 的调查进度 |

Public 表仍然只能通过 Reducer 修改。Agent 运行时仅订阅 `my_sources`；不会订阅其他 Agent 或指挥视图。

## 规则与可追溯性

1. **直接影响**：只采纳 `production` 部署；使用数字三段版本比较，而非字符串比较。受影响区间两端均包含。A 和 C 的证据共同构成判断依据。
2. **下游影响**：沿服务依赖反向搜索。支持多层依赖，循环通过 visited 集合终止。下游节点保留完整路径以及 A/B/C 的证据 ID。不存在直接影响源头时，依赖循环不会自行产生风险。
3. **待确认**：A+B 已到、C 未到时，使用 TokenGate 及依赖这些服务的节点显示 `possible`；此时不会提前生成抢修任务。C 到达后在一次事务内更新结论。
4. **优先级**：直接影响且漏洞 Critical，同时业务 Critical 或存在下游范围，分配 P0；其他直接影响为 P1。下游业务 High/Critical 为 P1，Medium 为 P2。
5. **部门通知**：必须同时有确认的直接/下游影响和负责人证据。任务 ID 为 `incidentId:assetId`，通知 ID 为 `notification:taskId`。部门、负责人、优先级、版本和影响原因都来自证据与规则。修复建议使用模板；不存在前端预置的三条任务。
6. **避免重复通知**：`projections.ts` 按主键同步，只有新记录 INSERT、变化记录 UPDATE、移除记录 DELETE。未变化的通知不写入；状态消息和重复证据不会再触发通知 INSERT。相同证据重新提交会把该 Agent 的状态恢复为 submitted。
7. **持久化**：停止 Agent 保留证据、资产风险、任务、通知。停止后提交会被 Reducer 拒绝；`resume_agents` 可恢复调查。只有管理员/操作员主动 `reset_demo` 才清空这次演示。Reset 后 revision 继续递增。
8. **过期调用隔离**：`my_sources` 返回额外的 `epoch`。每个 Agent run 第一次读资料时固定该 epoch；提交和状态更新携带 `expectedEpoch`。Reset、stop、resume 都会递增数据库 epoch，因此上一轮尚未结束的模型请求无法污染新一轮调查。每次新 run 创建新的 `SpacetimeAgentDatabase` 实例；不要在进行中的实例里换 epoch。

此 MVP 接受稳定的 `MAJOR.MINOR.PATCH` 版本；预发布标签、缺段、通配符和无限范围会被拒绝。原始资料是虚构且可复现的固定场景，不是任意企业漏洞扫描器。

## 发布和生成绑定

先安装与 SDK 兼容的 SpacetimeDB 2.x CLI。以下命令在项目根目录运行，数据库名可以自行替换：

```powershell
spacetime start
```

在另一个终端：

```powershell
spacetime build --module-path spacetimedb
spacetime publish --server http://127.0.0.1:3000 --module-path spacetimedb lattice-demo
spacetime generate --lang typescript --module-path spacetimedb --out-dir packages/integrations/src/generated
```

CLI 的 `--module-path` 是 2.x 参数。模块通过相对路径引用 `packages/domain` 和 `packages/contracts`，所以请保留完整仓库结构，不要只复制 `spacetimedb/` 子目录。

首次 publish 的身份会写入 private `admin` 表。保留这个身份用于后续注册；不要给 Agent 使用管理员 token。使用生成的 SDK 在管理员连接上调用：

```ts
await adminConnection.reducers.registerAgent({ identity: agentAIdentity, agentId: 'A' });
await adminConnection.reducers.registerAgent({ identity: agentBIdentity, agentId: 'B' });
await adminConnection.reducers.registerAgent({ identity: agentCIdentity, agentId: 'C' });
await adminConnection.reducers.registerAgent({ identity: agentDIdentity, agentId: 'D' });
await adminConnection.reducers.registerOperator({ identity: dashboardIdentity });
```

这些 `Identity` 值应从各自真实连接的 `onConnect` 回调获得；不要把四个 Agent 配置为同一 identity。首次发布之后重新发布普通代码会保留数据，切勿为每次演示使用删除数据库的数据清除选项；演示重置由 `reset_demo` 完成。

## 对接已有适配器

生成 SDK 之后，为前端和每个 Agent 分别建立连接，并等待订阅的 `onApplied` 再读取本地缓存。所有调用均等待 Reducer Promise，失败时展示或记录错误。

| 上层接口 | 真实数据库操作 |
| --- | --- |
| Agent `readAssignedSources()` | 订阅 `SELECT * FROM my_sources`，从 `connection.db.mySources.iter()` 返回资料 |
| Agent `submitEvidence(sourceId, payloadJson, expectedEpoch)` | `connection.reducers.submitEvidence({ sourceId, payloadJson, expectedEpoch })` |
| Agent `updateStatus(status, message, expectedEpoch)` | `connection.reducers.updateAgentStatus({ status, message, expectedEpoch })` |
| Dashboard world subscription | 订阅 `SELECT * FROM dashboard_world`；把 `snapshotJson` 解析为 `WorldSnapshot` |
| Inject incident | `connection.reducers.injectIncident()` |
| Stop all agents | 取消本地四个 worker，并调用 `connection.reducers.stopAgents()` |
| Resume agents | `connection.reducers.resumeAgents()`，再启动四个独立 worker |
| Reset | `connection.reducers.resetDemo()` |

前端拿到的真实 snapshot 的 `mode` 是 `spacetimedb`；本地服务器的 snapshot 是 `local`。不要在尚未建立真实订阅时仅改变 UI 模式标签。

Agent HTTP 模型配置只放在服务端环境变量中。数据库 token 同样放在相应进程环境或安全凭证存储中，不放进浏览器构建变量，也不提交到 Git。前端使用独立操作员连接；浏览器中的该操作员 token 仅用于自己的会话。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm test:db
```

纯规则测试覆盖 24 种完成顺序、C 最后提交、版本边界、幂等、缺失所有权、跨角色写入、传递/循环依赖、修复版本和非生产部署。`test:db` 使用官方 `spacetimedb/server/test-utils` 内存数据存储，运行真实模块 Reducer，验证身份隔离、原子回滚、持久状态和投影写入行为。

真实接入后再验证端到端订阅与数据库重启：完成调查后终止全部 Agent 进程，刷新页面，并运行 SQL 查询 `incident_task` / `department_notification`；预期仍是 3 条记录，Reporting 不在其中。官方内存测试不会替代真实网络订阅与磁盘重启测试。

## 官方依据

- [TypeScript tables and schema](https://spacetimedb.com/docs/tables/)
- [Reducers and transactional execution](https://spacetimedb.com/docs/functions/reducers/)
- [Lifecycle initialization and publishing identity](https://spacetimedb.com/docs/functions/reducers/lifecycle/)
- [Caller-scoped views](https://spacetimedb.com/docs/functions/views/)
- [Official module testing harness](https://spacetimedb.com/docs/how-to/unit-testing/)
- [SpacetimeDB 2.x CLI reference](https://spacetimedb.com/docs/cli-reference/)
