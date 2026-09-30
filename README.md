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

修饰符大小写不敏感（`defer(bash)` ≡ `Defer(bash)`）。优先级（从高到低）：
`noDefer` > `defer` > `deferToolLoading`。

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
