<div align="center">

# dsh-lazy-tools

**为 DeepSeek Harness 提供的 CodeBuddy 风格延迟工具加载插件。**

一个 `tool_search` + `defer_execute_tool` 覆盖层，让工具 schema 在真正需要之前
不会进入模型上下文。

*减少 token 消耗 · 缩小上下文窗口 · 保持工具可发现*

[![CI](https://github.com/studyzy/dsh-lazy-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/studyzy/dsh-lazy-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](package.json)

[English](README.en.md)

</div>

---

## 它是做什么的

大多数编码 Agent 会把**每一个**可用工具的 JSON Schema 都塞进提示词——
包括模型最终根本不会用到的工具。`dsh-lazy-tools` 颠覆了这个模型：工具
默认被**延迟（deferred）**，只有当模型主动请求时才进入上下文。

**装上即用、零配置**：默认延迟长尾工具，同时保留一组常驻编码核心
（`read`/`write`/`edit`/`bash`/`glob`/`grep`/`web_search`/`web_fetch`/
`ask_user_question`/`skill`，详见[默认行为](#默认行为)）。

被延迟的工具会从**模型可见的工具列表**里剔除，因此它们的 schema（乃至名字）
永远不会进入模型上下文。模型通过 `tool_search` 按需发现它们，激活后
即可直接调用。

剔除发生在 `system-prompt/assemble` 这条 waterfall 上——也就是 agent loop
真正发给模型的那份 per-scope 工具表（它同时决定请求头与提供商的工具声明）。
本插件**不修改工具注册表**，所以它不关心工具来自哪个平面。

这是一个**纯粹的暴露控制层**：

- 它**不拥有、也不实现**任何工具。
- 被延迟的工具是注册表里的普通工具（宿主 composition、agent preset、MCP 等
  第三方工具皆可）；本插件只从模型可见列表里观察它们的
  `name` / `description` / `parameters` 用于发现。
- 它**不代理执行**——`tool_search` / `defer_execute_tool` 只负责*激活*，激活后
  模型直接调用该工具本身。

因为完全实现在 agent 层，它**适用于任何模型与任何提供商**（DeepSeek、
OpenAI、Anthropic、Gemini……），不依赖提供商原生的延迟工具协议（如
Anthropic `tool_reference` 或 OpenAI 的 deferred-tool input items）。

## 特性

- 🔍 **按需发现** — `tool_search` 通过精确工具名（`tool_names`）或关键词
  （`queries`，中英文均可）查找工具，命中即激活。
- ⚡ **懒激活** — 命中的工具记入该 agent 的激活集合，下一轮模型请求即可
  直接调用。
- ⚡ **按名激活** — `defer_execute_tool` 按精确工具名直接激活一个已知工具。
- 🧭 **无侵入** — 不碰注册表：只在 `system-prompt/assemble` 上对模型可见的
  工具列表做减法，因此与任何其他 `restrict`、任何工具来源、任何平面天然共存，
  绝不放宽其他策略。
- 🎛️ **灵活配置** — CodeBuddy 风格 `Defer(...)` / `NoDefer(...)` 模式，支持 `*`
  通配符与全局 `deferToolLoading` 开关。
- 🛡️ **自保守卫** — `tool_search` 与 `defer_execute_tool` 注册在 agent 自身作用域，
  永不被延迟；保留传输 `run_code` 同样被钉住，`Defer(*)` 无法把系统锁死。
- 📊 **按项目自动调优** — 启动后第一个汇报工作目录的会话会扫描该项目最近
  30 天的会话历史，统计 `tool/call` 频率，把最常用的 20 个工具设为常驻、其余
  全部延迟。
- 🗂️ **全局 + 项目级两层配置** — 你手写的全局 `defer`/`noDefer` 对所有项目
  生效；自动调优的结果只写进独立的项目级存储，按项目覆盖全局。优先级
  **项目级 > 全局**。全局配置永远不会被扫描结果改写。

## 安装

从 GitHub 仓库安装为外部 bundle：

```bash
dsh plugin --profile <profile> add git:github.com/studyzy/dsh-lazy-tools
```

> 也可以先 `git clone` 到本地，再从本地目录安装。该 bundle 通过
> `cordis.patch.yml` 注入一个名为 `lazy-tools` 的插件。

### 兼容性

本插件面向 **DeepSeek Harness 0.2.0-rc.2**（`@deepseek-ai/dsh-*` 0.2.0-rc.2、
`@deepseek-ai/cordis` 4.0.4、`@deepseek-ai/schemastery` 3.18.4）。
`package.json` 的 `peerDependencies` 声明了这些精确版本，因此 DSH 的
插件兼容性预检会直接放行：

```bash
# 本地目录安装（开发时更新依赖后刷新 profile 依赖树）
dsh plugin --profile <profile> add link:/path/to/dsh-lazy-tools
```

> 升级 DSH 后若预检提示 peer 版本不匹配，把 `package.json` 的
> `peerDependencies` / `devDependencies` 对齐到新的 `@deepseek-ai/dsh-*`
> 版本，重新 `pnpm install && pnpm run check`，再执行一次上面的 `add` 即可。

## 配置

**零配置即可用**：不写任何 `config` 时插件使用内置预设，装完就是这样。

### 默认行为

| | 内容 |
|---|---|
| 延迟 | `Defer(*)` —— 除守卫外全部延迟，模型按需 `tool_search` |
| 常驻可用 | `read`、`write`、`edit`、`bash`、`glob`、`grep`、`web_search`、`web_fetch`、`ask_user_question`、`skill` |
| 守卫（永不被延迟） | `tool_search`、`defer_execute_tool`、`run_code` |

**一旦显式写了 `defer` 或 `noDefer` 中的任意一个键，预设就被完全替换**，一切按你写的来：
`defer: []` 仍然是"不延迟任何工具"，`defer: ['glob']` 就是只延迟 `glob`
（不会因为 `glob` 在默认核心里而被重新保护）。

需要改默认时才写配置，位置是 profile 的 `cordis.patch.yml`（用户 patch 层）
中该插件的 `config` 字段，使用 CodeBuddy 风格语法：

```yaml
- id: lazy-tools
  name: '@deepseek-ai/dsh-lazy-tools'
  config:
    defer: ['glob', 'web_search', 'Defer(fetch_*)']
    noDefer: ['bash']
    deferToolLoading: true
```

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defer` | `string[]` | 见"默认行为" | 要延迟的工具名或 `Defer(pattern)` 条目。裸名等价于 `Defer(name)`。`*` 是唯一通配符——`Defer(*)` 延迟除守卫工具外的所有工具。 |
| `noDefer` | `string[]` | 见"默认行为" | 必须保持可直接调用的工具名或 `NoDefer(pattern)` 条目。裸名等价于 `NoDefer(name)`。**始终优先于 `defer`。** |
| `deferToolLoading` | `boolean` | `true` | 全局开关。为 `false` 时不延迟任何工具。 |
| `autoTune` | `boolean` | `true` | 是否按本项目会话历史自动生成 `defer`/`noDefer`，见"按项目自动调优"。 |
| `autoTuneWindowDays` | `number` | `30` | 统计窗口天数。 |
| `autoTuneTopN` | `number` | `20` | 自动调优保留多少个最常用工具常驻。 |
| `autoTuneMinSamples` | `number` | `200` | 窗口内调用总数达到该值才允许改写配置。 |

修饰符大小写不敏感（`defer(bash)` ≡ `Defer(bash)`）。优先级（从高到低）：
`noDefer` > `defer` > `deferToolLoading`。

## 配置分层：全局 Defer + 项目级 Defer

配置分两层，优先级 **项目级 > 全局**：

| 层 | 写在哪 | 谁写 | 作用范围 |
|---|---|---|---|
| **全局** | profile 的 `cordis.patch.yml` 里 `config.defer` / `config.noDefer` | 你手写 | 所有项目 |
| **项目级** | `~/.dsh/lazy-tools/projects.json` | 自动扫描生成 | 仅该项目 |

自动生成的条目里还记录了 `tunedAt`（上次刷新时间）、`sampleCalls`（参与统计的
调用数）和 `sessions`（会话数），方便你判断这条配置的新鲜度和可信度。

解析规则：某项目在项目级存储里有条目就用它；没有就回退到全局配置。
**自动调优只写项目级存储，绝不改动你的全局配置**——所以你在多仓库间切换时，
手写的全局规则不会被某个项目的扫描结果覆盖。

`projects.json` 的样子（键是项目的绝对路径）：

```json
{
  "version": 1,
  "projects": {
    "/Users/me/Code/api": {
      "defer": ["Defer(*)"],
      "noDefer": ["bash", "edit", "read"],
      "tunedAt": 1790000000000,
      "sampleCalls": 412,
      "sessions": 6
    }
  }
}
```

项目级条目是**整体替换**而非合并 `defer`/`noDefer`：否则全局的 `Defer(git_*)`
会继续在该项目生效，导致工具被两条规则同时延迟、无法按项目重新启用。全局中
与模式无关的开关（`deferToolLoading`、`autoTune*`）仍然沿用。

> 想清掉某个项目的自动调优？删掉 `projects.json` 里对应条目（或整个文件）即可，
> 该项目立即回退到全局配置。

## 按项目自动调优

启用后（默认开启），插件会**按项目**统计真实使用情况并生成项目级配置：启动后
第一个汇报工作目录的会话，触发一次对该项目最近 30 天会话历史的扫描。

**统计口径**

- 数据来自 DSH 落盘的会话日志（`~/.dsh/sessions/<项目目录>/`）。每个
  `tool/call` 事件记录一次工具调用。
- **`defer_execute_tool` 的一次调用，计入它激活的那个工具**——模型反复主动
  激活某个被延迟的工具，正是"它不该被延迟"的信号，因此会自动升为常驻。
- 按窗口内调用次数降序排序（次数相同按名称升序），取前 `autoTuneTopN` 个
  写入 `noDefer`，并设置 `defer: ['Defer(*)']` 延迟其余全部。

**三条安全边界**

- **一天只刷新一次**：条目里记录 `tunedAt`（上次刷新时间）。同一**本地自然日**
  内再次启动，直接沿用已有条目并**完全跳过扫描**，不读历史、不写盘。跨过本地
  零点（而非「满 24 小时」）后才会重新扫描。
- **样本不足不改写**：窗口内调用总数低于 `autoTuneMinSamples`（默认 200）时
  只记日志、保持现状（该项目继续用全局配置），避免用噪音覆盖你的配置。
- **只写自己的文件**：只动 `~/.dsh/lazy-tools/projects.json`，不碰 profile 配置。

按自然日而不是「满 24 小时」判定，是因为统计窗口本身以天为单位：昨天 23:00 调
过一次、今天 08:00 又启动，虽然只隔 9 小时，但数据窗口已经前移了一天，重新扫
描是有意义的。判定用本地日期分量比较（而非时间戳相减），因此在夏令时切换当天
（本地一天可能是 23 或 25 小时）依然正确。

若某天扫描后发现排序没变，条目只更新 `tunedAt` 时间戳，`defer`/`noDefer` 保持
不变——这样当天剩余时间同样被节流。

存储在插件安装时**同步读入内存**，因此会话的第一个请求就已经生效；同进程内某
项目扫描完成并写入后，会立即重新计算该项目 agent 的工具可见性，无需重启。单个
项目只调优一次（按进程内存记忆，含并发去重）；写入是原子替换，且多个项目并发
调优不会互相丢失条目。任何失败都被限制在后台任务内，不影响会话启动。

```yaml
# 调整调优参数
config:
  autoTuneTopN: 12          # 只常驻最常用的 12 个
  autoTuneWindowDays: 60    # 用 60 天历史
  autoTuneMinSamples: 50    # 小项目也允许调优
```

```yaml
# 完全关闭自动调优，只用你写的全局配置
config:
  autoTune: false
```

```yaml
# 典型用法：全局给一套保守规则，让自动调优在各项目里细化
config:
  defer: ['Defer(*)']
  noDefer: ['bash', 'read', 'edit', 'write']
```

### 示例

```yaml
# 把默认核心换成只有 bash 常驻（其余仍然全部延迟）
config:
  noDefer: ['bash']
```

```yaml
# 只延迟这两个，其余保持可见
config:
  defer: ['glob', 'web_search']
```

```yaml
# 延迟所有 fetch_* / web_* 工具，始终保持 bash 可用
config:
  defer: ['Defer(fetch_*)', 'Defer(web_*)']
  noDefer: ['bash']
```

```yaml
# 延迟除守卫工具对（tool_search / defer_execute_tool）之外的一切
config:
  defer: ['Defer(*)']
```

```yaml
# 延迟一切，但保留一小组常驻核心工具（noDefer 优先于 Defer(*)）
config:
  defer: ['Defer(*)']
  noDefer: ['read', 'write', 'edit', 'bash']
```

```yaml
# 按前缀延迟 MCP 网关工具
config:
  defer: ['mcp*']
```

## 工作原理

| 组件 | 作用 |
|---|---|
| `tool_search` | 搜索当前不可见的工具。`tool_names` 精确查找，`queries` 关键词查找（中英文）。命中即激活并返回匹配结果。 |
| `defer_execute_tool` | 按精确工具名激活一个延迟工具，使模型可直接调用。适合激活已知名字的工具。 |
| 隐藏 | 在 `system-prompt/assemble` 上，把被延迟的工具从该 scope 的模型可见工具列表中剔除（注册表本身不动）。 |
| 拦截 | `tools/pre-execute` 监听器会在模型直接调用未加载的延迟工具时返回 `deny`，提示先调用 `tool_search` 或 `defer_execute_tool`。 |
| 激活 | 命中的工具记入该 agent 的激活集合，从下一轮模型请求开始出现在工具列表中，可直接调用。 |

### 流程

```
Prompt: 只有守卫 + 常驻核心的 schema 可见（零配置默认即如此）
   │
   ▼
model: tool_search({ tool_names: ["todo_write"] })
   │  └─ 返回匹配状态，并把它记入该 agent 的激活集合
   ▼
下一轮: model 直接调用 todo_write（完整 schema 已进入工具列表）
```

## 设计约束与已知限制

- **激活后下一轮生效。** `tool_search` 激活工具后，*当前*模型请求的工具列表
  已经固定（工具表在下一轮请求头才更新），因此同一轮内直接调用仍会被
  `tools/pre-execute` 拦截。请在结果返回后、下一轮再调用。
- **延迟工具在搜索前不可见。** 模型看不到延迟工具的名字，只能依赖
  `tool_search` 的检索来发现它们。
- **与其他限制天然兼容。** 插件只对模型可见列表做减法，绝不放宽其他
  `restrict`（如父/子代理策略）。被其他策略拒绝的工具既不会进入模型可见列表，
  也不会进入搜索目录，因此搜索时只会得到 `unavailable`。
- **不区分工具的来源平面。** 宿主 composition、agent preset（Web/Desktop 的
  模型可见工具全部由 preset 挂载）、MCP 服务器，以及 agent 创建之后才注册的
  工具，走的是同一套延迟/搜索逻辑。
- **PTC 呈现模式下退化为不生效。** 以 `ptc` 呈现的 agent 只会看到保留传输
  `run_code`（它被钉为守卫，永不被延迟），其余能力通过生成的 SDK 暴露；此时
  延迟不隐藏它们（不会报错，只是不生效）。
- **状态不跨会话持久化。** 已加载的工具集仅在当前进程内生效；resume / fork
  后新 agent 会重新按配置延迟。这是为了避免外部插件写入未在
  `KNOWN_SESSION_EVENT_TYPES` 注册的自定义会话事件。
- **不接管 agent 自身作用域的工具。** 注册在该 agent 自己的 scope 里的工具
  （`tool_search` / `defer_execute_tool` 自身就是）始终可见；`Defer(*)` 对它们
  无效。

## 开发

```bash
pnpm install
pnpm run typecheck        # TypeScript 类型检查（src）
pnpm run typecheck:tests  # TypeScript 类型检查（tests）
pnpm test                 # vitest 单元 + 集成测试
pnpm run lint             # oxlint
pnpm run build            # tsc + tsdown 打包到 lib/
pnpm run check            # lint + 两次类型检查 + 测试 + 构建
```

贡献流程、目录结构、以及在真实 Harness 里试插件的步骤见
[CONTRIBUTING.md](CONTRIBUTING.md)；版本变更记录见 [CHANGELOG.md](CHANGELOG.md)；
安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。CI 在 Node 22 / 24 上跑
lint、两次类型检查、测试与构建（见 [.github/workflows/ci.yml](.github/workflows/ci.yml)）。

## License

本项目以 MIT 许可证发布（见 [LICENSE](LICENSE)）。
