# Lattice Living Repository World

独立的 SpacetimeDB 2.x TypeScript 模块。Agent 将源码发现和证据提交给 Reducer。数据库保存统一的仓库图和探索队列，执行模拟规则，并通过订阅向客户端同步。

## 连接

Maincloud 数据库为 `lattice-living-world-6b9d31f7`，服务器为 `https://maincloud.spacetimedb.com`。完整连接参数和本地测试配置位于 `connection.json`。

`client/index.ts` 是 SDK 入口，`bindings/` 为 SpacetimeDB CLI 生成的原生绑定。Agent 和 Frontend 可分别使用自己的客户端身份连接。首次连接的 `onConnect` 会提供身份和 token，同一客户端可安全保存自己的 token 供重连使用。

```ts
import { worldConnection, worldQueries } from '@lattice/repository-world';

const worldId = 'train-ticket-snapshot';
const simulationId = 'sim-3aa1edb7-a808-4afe-9c44-52c541eb8bc2';
const conn = worldConnection({
  uri: 'https://maincloud.spacetimedb.com',
  database: 'lattice-living-world-6b9d31f7',
  token: clientToken,
})
  .onConnect(connection => {
    connection.db.worldSignal.onInsert((_ctx, signal) => {
      console.log(signal.simulationId, signal.sequence);
    });
    connection.subscriptionBuilder()
      .onApplied(() => console.log([...connection.db.worldEntities.iter()]))
      .onError(ctx => console.error(ctx.event))
      .subscribe(worldQueries(worldId, simulationId));
  })
  .build();
```

发布者使用 `createWorld` 建立仓库和完整 Git commit SHA，再通过 `setMember` 为客户端身份授权。每个 world 对应一个 commit。对于新的 commit，创建新的 world。原始知识和模拟数据都通过按身份过滤的 Views 读取。浏览器使用自身的 reader 或 operator 身份。

| 角色 | 权限 |
| --- | --- |
| owner | 管理成员、修正事实、探索和模拟 |
| agent | 读取世界、领取任务、提交及复核发现、运行模拟 |
| operator | 读取世界、运行模拟和注入故障 |
| reader | 读取世界 |

## Agent 接口

| Reducer | 用途 |
| --- | --- |
| `claimTask({ worldId, taskId, leaseMs })` | 从 `worldFrontier` 选择 queued 任务后原子认领。并发冲突时改选任务。 |
| `submitDiscovery({ worldId, entities, relations, behaviors, tasks, completes })` | 在一个事务中合并发现、记录证据、添加后续任务并可完成租约。完成时传 `{ taskId, attempt }`。 |
| `reviewDiscovery({ worldId, subject, id, verdict, source })` | 为事实提交 supports 或 contradicts 及源码依据。矛盾会生成待复核任务。 |
| `setDiscoveryActive({ worldId, subject, id, active })` | 由 owner 采纳或撤回一个实体、关系或规则，保留先前证据。规则修订可先提交一个新命名版本，再撤回旧规则。 |
| `requestEvent({ simulationId, entity, event, delayMs })` | 让数据库按事件名执行该实体上匹配的行为。 |

Entity 以 kind、仓库相对 path 和完整 symbol 作为稳定键，文件的 symbol 为空。Reducer 通过这组字段合并重复实体。Relation 的稳定键由源实体、类型和目标实体组成。写入接口中的 `from`、`to`、`entity` 使用 SDK 的 `entityKey(kind, path, symbol)`。订阅返回的关系行 `from`、`to` 对应实体行的 `id`，可直接绘制图。Evidence 记录提交身份、commit、路径、行号和摘录。数据库验证字段格式和引用一致性，摘录与实际源码的比对由仓库读取方完成。

每批可提交最多 100 条。实体先于同批关系和行为写入。发现通过确定性键去重，各 Agent 的不同证据独立保留。租约到期后由数据库自动重排，累计三次超时会进入 dead。任务完成时校验领取者和 attempt，避免旧 worker 覆盖新结果。

## 模拟与 Set Bug

每个模拟独立保存 State，运行时读取同一 commit 下当前有效的图和规则。先调用 `createSimulation({ worldId, id, label })`，再调用 `setBug({ simulationId: id, entity: entityKey(...) })`。

数据库沿调用、依赖、通信和包含关系向上游搜索，沿数据流方向向下游搜索。结果保存在 `worldStates`，每个故障源对应一个 `lattice.impact:` 前缀的状态键。状态包含源实体、距离、前驱关系以及 `fault_origin` 或 `potential_impact`。同一模拟重复标记同一故障源会保留已有结果。

Behavior 由事件、状态等值条件、赋值和后续事件组成。例如实体可在收到 `lattice.fault` 后把自身状态置为 degraded，并延迟触发另一个实体的 recheck。值用 JSON 标量表示，字符串值示例为 `JSON.stringify('degraded')`。

```ts
const rule = {
  event: 'lattice.fault',
  when: [],
  set: [{ key: 'status', value: JSON.stringify('degraded') }],
  emit: [{ target: dependentEntityKey, event: 'recheck', delayMs: 250 }],
  retry: undefined,
};
```

`when` 条件全部成立才执行。同一事件内先判断条件，再按规则名顺序执行匹配规则。未匹配时，可配置 `retry: { delayMs, maxAttempts }` 等待状态变化。没有指定 emit target 时，事件仍发给当前实体。

原生 Schedule Tables 驱动延迟事件、重试和租约超时。模拟最多调度 2048 次事件，每条触发链最多 24 层，超限的派生事件计入 dropped。`stopSimulation` 取消待处理事件并保留结果。原生 Event Table `worldSignal` 广播已提交的事件序号。它是公开的瞬时信号，只包含模拟 ID、序号和时间。请用不包含业务数据的随机 ID。授权客户端通过 `worldSimulations` 和 `worldStates` 读取事件结果，重连可恢复持久状态。

## 本地编译与验证

在 `spacetime_db` 目录下运行。使用 Node.js 22 或以上及 SpacetimeDB CLI 2.14.1。

```powershell
npm.cmd ci
spacetime build --module-path .
spacetime generate --lang typescript --module-path . --out-dir bindings --yes
npm.cmd run typecheck
```

在一个 PowerShell 窗口启动测试实例。

```powershell
spacetime start --listen-addr 127.0.0.1:3380
```

在另一个窗口发布测试数据库并运行真实 WebSocket 测试。测试使用当前发布者身份创建唯一的测试 world，以及四个独立 Agent 客户端。

```powershell
spacetime publish lattice-world-local --module-path . --server http://127.0.0.1:3380
$env:LATTICE_STDB_TEST_TOKEN = [regex]::Match((spacetime login show --token | Out-String), 'eyJ[A-Za-z0-9_.-]+').Value
npm.cmd run test:live
Remove-Item Env:LATTICE_STDB_TEST_TOKEN
```

正式发布使用 `spacetime publish lattice-living-world-6b9d31f7 --module-path . --server maincloud`。部署包含数据库模块和权限初始化，仓库数据通过上述 SDK 写入。
