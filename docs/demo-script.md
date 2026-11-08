# 90 秒演示脚本

所有案例数据均为虚构；TokenGate、DEMO-SEC-001 不对应真实安全公告。

| 时间 | 操作 | 讲解 |
| --- | --- | --- |
| 0–15s | 点击 **Inject Incident**，展示四个未知资产 | ASTER 收到 TokenGate 认证绕过公告，但尚不知道哪些生产系统受影响。 |
| 15–45s | 点击 **Run investigation**，保持正常速度 | 四个 Agent 独立读取数据库里的不同资料，只提交证据，没有互相聊天，也不能写风险和任务。 |
| 45–65s | 点击 Auth Service，再查看 Checkout / Reporting 的证据 | 部署证据到达后，数据库判定 1.8.1 直接受影响，沿依赖链推导两个潜在下游影响；1.8.3 不在影响范围。 |
| 65–90s | 查看 Department Inbox，再点击 **Stop agents** | 三个部门任务由规则生成。Agent 退出之后，资产状态、证据、任务和通知仍保留在数据库中。 |

可使用快速模式检查流程；正式讲解使用正常速度。也可以逐个运行 Agent，改变提交顺序来验证最终状态一致。

## 必须诚实展示的模式边界

- **Local simulator**：本地 Node 服务执行共享规则并持久化到 `.data/world.json`，通过 SSE 推送。适合离线演示和联调，并不意味着 SpacetimeDB 已部署。
- **SpacetimeDB**：部署 `spacetimedb/` 模块并接入生成绑定后，证据提交与规则推导在真实 Reducer 事务内执行，前端通过数据库订阅读取结果。
- API 未配置时 Agent 使用确定性的资料提取器，不能把该模式称为正在调用真实大模型。

## 预期最终结果

| 系统 | 结论 | 优先级 | 部门 |
| --- | --- | --- | --- |
| Auth Service | 直接受影响：TokenGate 1.8.1 | P0 | Security / Identity Team |
| Checkout | 潜在下游影响：依赖 Auth Service | P1 | Commerce Engineering |
| Merchant Portal | 潜在下游影响：依赖 Auth Service | P1 | Merchant Platform Team |
| Reporting | 不受此漏洞影响：TokenGate 1.8.3 | — | 无抢修任务 |

“不受影响”仅针对本次虚构漏洞，不表示系统不存在其他安全问题。
