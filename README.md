<div align="center">

# dsh-lazy-tools

**为 DeepSeek Harness 提供的 CodeBuddy 风格延迟工具加载插件。**

一个 `tool_search` + `defer_execute_tool` 覆盖层，让工具 schema 在真正需要之前
不会进入模型上下文。

*减少 token 消耗 · 缩小上下文窗口 · 保持工具可发现*

[English](README.en.md)

</div>

---

## 它是做什么的

大多数编码 Agent 会把**每一个**可用工具的 JSON Schema 都塞进提示词——
包括模型最终根本不会用到的工具。`dsh-lazy-tools` 颠覆了这个模型：工具
默认被**延迟（deferred）**，只有当模型主动请求时才进入上下文。

被延迟的工具会从模型可见的工具集中剔除，因此它们的 schema（乃至名字）
永远不会进入模型上下文。模型通过 `tool_search` 按需发现它们，激活后
即可直接调用。

这是一个**纯粹的暴露控制层**：

- 它**不拥有、也不实现**任何工具。
- 被延迟的工具是全局注册表里的工具（包括 MCP 等第三方工具）；本插件只持有
  它们的 `name` / `description` / `parameters` 用于发现。
- 它**不代理执行**——`tool_search` / `defer_execute_tool` 只负责*激活*，激活后
  模型直接调用该工具本身。

因为完全实现在 agent 层，它**适用于任何模型与任何提供商**（DeepSeek、
OpenAI、Anthropic、Gemini……），不依赖提供商原生的延迟工具协议（如
Anthropic `tool_reference` 或 OpenAI 的 deferred-tool input items）。

## 特性

- 🔍 **按需发现** — `tool_search` 通过精确工具名（`tool_names`）或关键词
  （`queries`，中英文均可）查找工具，命中即激活。
- ⚡ **懒激活** — 命中的工具加入该 agent 的可见集合，下一轮模型请求即可
  直接调用。
- ⚡ **按名激活** — `defer_execute_tool` 按精确工具名直接激活一个已知工具。
- 🧭 **无侵入** — 在 `agent.ctx` 上通过 `ctx.tools.restrict()` 过滤可见工具，
  与父/子代理的既有限制天然取交集，绝不放宽其他策略。
- 🎛️ **灵活配置** — CodeBuddy 风格 `Defer(...)` / `NoDefer(...)` 模式，支持 `*`
  通配符与全局 `deferToolLoading` 开关。
- 🛡️ **自保守卫** — `tool_search` 与 `defer_execute_tool` 注册在 agent 自身作用域，
  永不被延迟，`Defer(*)` 无法把系统锁死。

## 安装

从 GitHub 仓库安装为外部 bundle：

```bash
dsh plugin --profile <profile> add git:github.com/studyzy/dsh-lazy-tools
```

> 也可以先 `git clone` 到本地，再从本地目录安装。该 bundle 通过
> `cordis.patch.yml` 注入一个名为 `lazy-tools` 的插件。

## 配置

配置写在 profile 的 `cordis.yml` 中该插件的 `config` 字段下，使用 CodeBuddy
风格语法：

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
| `defer` | `string[]` | `[]` | 要延迟的工具名或 `Defer(pattern)` 条目。裸名等价于 `Defer(name)`。`*` 是唯一通配符——`Defer(*)` 延迟除守卫工具外的所有工具。 |
| `noDefer` | `string[]` | `[]` | 必须保持可直接调用的工具名或 `NoDefer(pattern)` 条目。裸名等价于 `NoDefer(name)`。**始终优先于 `defer`。** |
| `deferToolLoading` | `boolean` | `true` | 全局开关。为 `false` 时不延迟任何工具。 |

修饰符大小写不敏感（`defer(bash)` ≡ `Defer(bash)`）。优先级（从高到低）：
`noDefer` > `defer` > `deferToolLoading`。

### 示例

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
# 按前缀延迟 MCP 网关工具
config:
  defer: ['mcp*']
```

## 工作原理

| 组件 | 作用 |
|---|---|
| `tool_search` | 搜索当前不可见的工具。`tool_names` 精确查找，`queries` 关键词查找（中英文）。命中即把工具加入可见集合并返回匹配结果。 |
| `defer_execute_tool` | 按精确工具名激活一个延迟工具，使模型可直接调用。适合激活已知名字的工具。 |
| 拦截 | `tools/pre-execute` 监听器会在模型直接调用未加载的延迟工具时返回 `deny`，提示先调用 `tool_search` 或 `defer_execute_tool`。 |
| 激活 | 命中的工具写入该 agent 的 `restrict({ allow })` 集合，从下一轮模型请求开始对模型可见、可直接调用。 |

### 流程

```
Prompt: 只有 tool_search + defer_execute_tool 的 schema 可见
   │
   ▼
model: tool_search({ tool_names: ["glob"] })
   │  └─ 返回 glob 的匹配状态，并把它加入该 agent 的可见集合
   ▼
下一轮: model 直接调用 glob（完整 schema 已进入工具列表）
```

## 设计约束与已知限制

- **激活后下一轮生效。** `tool_search` 激活工具后，*当前*模型请求的工具列表
  已经固定（schema 在下一轮请求头才更新），因此同一轮内直接调用仍会被
  `tools/pre-execute` 拦截。请在结果返回后、下一轮再调用。
- **延迟工具在搜索前不可见。** 模型看不到延迟工具的名字，只能依赖
  `tool_search` 的检索来发现它们。
- **与其他限制取交集。** 插件只挂自己的 `allow` 子集，绝不放宽其他 `restrict`
  （如父/子代理策略）。被其他策略拒绝的工具即使被搜索命中也会标记为
  `unavailable`。
- **状态不跨会话持久化。** 已加载的工具集仅在当前进程内生效；resume / fork
  后新 agent 会重新按配置延迟。这是为了避免外部插件写入未在
  `KNOWN_SESSION_EVENT_TYPES` 注册的自定义会话事件。
- **仅全局工具。** 已注册在 agent 自身作用域的工具始终可见，不在延迟目录内。

## 开发

```bash
pnpm install
pnpm run typecheck   # TypeScript 类型检查
pnpm test            # vitest 单元 + 集成测试
pnpm run lint        # oxlint
pnpm run build       # tsc + tsdown 打包到 lib/
```

## License

本项目以 MIT 许可证发布。
