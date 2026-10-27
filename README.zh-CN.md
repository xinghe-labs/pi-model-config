# pi-model-config

**一个 URL 加一个 Key。模型的参数是推断出来的，不是手填的。**

一个 Pi 扩展：把第三方 / 自建 / 中转模型端点加进 `models.json`，并让这条配置持续跟端点保持一致
—— 端点上新出现的加进来、消失的删掉、参数跑偏的修回来，依据是端点自身和
[models.dev](https://models.dev)。

```bash
pi install npm:pi-model-config
```

安装后请新开一个会话（或 `/reload`）：会话进行中安装的包，要等 Pi 重新读取包列表才会加载。

```text
/model-config                          菜单
/model-config add                      添加或替换一个供应商（五个问题）
/model-config add <url> <key>          只给 URL 和 Key，不问问题
/model-config edit                     修改一个供应商的 URL / Key / api / id
/model-config sync                     补齐新模型 / 删掉失效模型 / 修参数
/model-config check [--fix]            只对账参数（--fix 不询问直接修复）
/model-config list                     列出已配置的供应商
/model-config remove                   删除一个供应商
/model-config models <pid>              删除不要的模型
```

`/model-config` 仍注册为别名。

两个新命令的重点就是这行免交互形式：把 URL 和 Key 给它，`contextWindow`、`maxTokens`、
推理 / 视觉能力、思考强度全部从端点自己的元数据推断，不用手填；`cost` 不做推断，
统一写零（见下文「models.dev 的几个坑」）。

```bash
# 先看会加什么、参数是多少 —— 一个字节都不写
/model-config add https://gw.example.com/v1 sk-...

# 真的从这个端点加三个模型
/model-config add https://gw.example.com/v1 sk-... --only gpt-4o,deepseek-v4-pro

# 端点变了：补齐新模型、删掉已下线的
/model-config sync --all
```

`add` 和 `sync` 默认**只打印计划、不写盘**，必须给 `--all` 或 `--only` 才落地。
不存在「敲错一个 flag 就把文件重写一遍」的模式：`--onlyy` 直接报错，不会当成没写。
`--dry-run` 即使带了写入 flag 也只预览；`--key` / `$PI_MODEL_CONFIG_API_KEY`
可以避免把 Key 写进 shell 历史。

## 它解决什么

想让 Pi 用上一个 OpenAI 兼容网关，手写得写这么一坨：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gw.example.com/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "claude-opus-4-6",
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": { "supportsReasoningEffort": true },
          "thinkingLevelMap": { "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": null }
        }
      ]
    }
  }
}
```

这些字段填错时**全都不会报错**：

- **`contextWindow` 偏大** —— Pi 压缩得太晚，请求直接溢出。
- **`contextWindow` 偏小** —— Pi 压缩得太早，花钱买来的上下文被白白丢掉。
- **`cost` 缺失** —— pi-ai 的 `calculateCost` 要读 `model.cost.tiers`，缺了抛
  `TypeError`，整轮回复判失败，而且看不出原因。
- **`supportsReasoningEffort` 缺失** —— `openai-completions` 端点下，Pi 靠 URL 猜这个值；
  自定义网关猜不出来，于是**永远不发** `reasoning_effort`。推理模型就这么不推理地跑着。
- **`thinkingLevelMap` 缺失或写错** —— 端点不支持的档位留在选择器里，支持的档位反而看不到。

没有任何东西校验这些。`/model-config add` 只问 URL、协议类型、API Key、模型、供应商 ID，
剩下全部推断。

## 参数从哪来

每个字段按顺序查三个来源：

| 来源 | 怎么取 |
| --- | --- |
| **端点元数据** | `GET {baseUrl}/models`，读 `context_length`、`max_completion_tokens`、`supported_parameters`、`architecture.input_modalities`、`inputTokenLimit`、`supportedGenerationMethods`、`reasoning_options`、`reasoning_supported_efforts` 等 |
| **models.dev** | `https://models.dev/api.json`，只提取「短名 → 能力」映射并本地缓存 |
| **模型名** | id 里的 `128k` / `1m` 标记，加上少量家族默认值 |

add 流程会逐条打印每个字段来自哪个来源，推断结果可核对，而不是玄学。

**推测值绝不覆盖已有值。** 只有端点元数据和 models.dev 能改掉 `models.json` 里已有的值；
按名字猜出来的值只能填**缺失**的字段。端点连不上、models.dev 又没收录时，手调过的配置原样保留。

### models.dev 的几个坑

- 聚合商（poe、azure、openrouter……）也收录别家的模型，而 providers 按字母序遍历 ——
  所以「先到先得」拿到的是聚合商的错数据。原厂 provider 按模型名前缀匹配
  （`claude*` → anthropic、`gpt*`/`o*` → openai、`glm*` → zai……），优先于任何聚合商。
- 拉取成功缓存 6 小时；拉取**失败**缓存 15 分钟。没有这个负缓存，离线机器每次 add /
  check / 启动都要空等 15 秒超时。失败时保留上一次成功的数据 —— 掉线是降级到旧数据，不是降级到没有。
- 缓存位置：`~/.pi/agent/model-config-modelsdev-cache.json`。

## `/model-config edit`

改一个供应商的连接字段，不动其他任何东西。与 `add` 的区别：`add` 是整表替换（重新探测、重写模型列表），
`edit` 只改你给出的字段，模型列表原样保留。

```bash
# 交互式：选供应商，逐项问要改什么（回车跳过）
/model-config edit

# 脚本化：先看计划，确认再加 --all
/model-config edit gw --url https://new-gw.example.com/v1 --key sk-new
/model-config edit gw --url https://new-gw.example.com/v1 --all

# 重命名（同步处理 enabledModels 里的旧条目）
/model-config edit gw --id new-name --all
```

规则：

- **改 baseUrl / api 会先探测新端点**：探测失败就不写入 —— 换错地址不会把能用配置改成不能用的；
- **改 key 不探测**（端点对 key 的校验在下次 sync/check 时自然发生）；
- 脚本化形式遇到非本机 `http://` 端点拒绝执行（与 add 同一闸门）；
- baseUrl / apiKey 的修改无需重启：另一个扩展（如 sub-models）每次刷新都会重读 models.json。

## `/model-config sync`

让 `models` 列表与端点当前的实际情况一致：

- **新增** 端点列出了、配置里还没有的模型；
- **删除** 端点已不再列出的模型（有 UI 时先确认，且一定先备份）；
- **修复** 跑偏的参数，规则与 `check` 相同；
- **补全** 完全没有模型列表的供应商（`"models": []` 或压根没这个键）——
  手写一个 `{ baseUrl, api, apiKey }` 就是这个样子；
- 其余一律保留，包括它不认识的字段。

端点把同一个 id 列两次时，只会写一个条目，不会变两条。

两条规则让它可以放心对着一个不稳定的网关跑：

1. **删除必须以探测成功为前提。** 端点读不到就整个跳过这个供应商 —— 不删，也**不用猜测值去修**。
   网关挂一分钟，绝不可能把你的配置清空。
2. **由其他扩展管理的供应商一律跳过。** 它们的模型列表是那个扩展在刷新时生成的，
   `models.json` 里存的静态兜底**本来就该**与实时数据不同。

`--no-prune` 保留端点已下线的模型，但仍会新增和修复。`--only <ids>` 只限制**新增**哪些模型，
不限制删除 —— 否则一次局部同步就会留下过期条目。

## `/model-config models`

手动管理某个供应商的模型列表：挑出不要的模型、确认、完成。删除的模型会记入
`model-config.json` 的 `hiddenModels` 忽略名单，之后 `sync` 不会再把它们补回来
——手动删除是一个决定，不该被对账撤销。

```bash
# 交互式：选供应商，再逐个挑要删的模型
/model-config models

# 脚本化：直接删这些，不弹对话框
/model-config models my-gateway --only old-model,another-model
```

想恢复某个被删的模型：跑 `sync --only <id>`（会同时把它从忽略名单移除），
或从 `model-config.json` 的 `hiddenModels` 里删掉对应 id 再跑 `sync --all`。
菜单路径的 `sync` 发现忽略名单里的模型端点仍在提供时，也会先问要不要恢复。

## `/model-config check`

把 `models.json` 里的静态 `models` 与端点、models.dev 对账，并询问是否写回修正。

- 端点已不再提供的模型**只报告，绝不删除** —— 删配置不是对账该做的决定。
- 修复只动有可信来源的字段，所以手写的 `name`、自定义 `compat` 键、本扩展不认识的字段都会保留。
- `--fix` 是书面同意：修复全部端点发现的偏差，不再逐个询问（脚本 / `pi -p` 用）。
- 对账是幂等的：第二次跑什么都不报。
- 文件解析失败会直接中止，一个字节都不写。

同一套对账会在会话启动时静默跑一次：没发现就完全不出声，`/reload` 不重跑。
它无权修复的偏差（如下线模型）每次会话报一次——这不是重复报问题的 bug，而是它刻意不替你做删除决定。

它是**尽力而为、不阻塞启动**的：启动永远不会为了等一次网络探测而卡住；而立刻结束的会话
（比如 `pi -p "..."`）可能在审计跑完前就退出了。被中断的审计不会留下半截状态 ——
每次写入都是原子的、要么全成要么全不成 —— 它只是什么都不做，等下一个会话再说。
需要确定性请用 `/model-config check`。

## 非交互模式

`check`、`list`、`sync` 以及 `add <url> <key>` 形式在 RPC / JSON / print 模式下都能用，
没有 UI 时报告写到 stdout。

区别在「谁来同意这次写入」。`sync` 和 `add` 的同意来自 flag（`--all` / `--only`），
所以自动化运行拿到计划后只执行你明确要求的那部分；`sync` 只在有 UI 时才额外为删除弹一次确认。
`check` 的同意是 `--fix`：没有 UI 时不带 flag 它只报告、不写，并指出要落地请用 `sync --all`
或 `check --fix`。`remove`、菜单、以及不带参数的 `add` 需要对话框，会明确拒绝而不是做到一半失败。

一个额外的闸门：脚本化 `add` 遇到非本机的 `http://` 端点会直接拒绝（API Key 会明文发送，
脚本模式无人确认）。改用 https、用交互式 add 确认，或明确加 `--all` 表示接受该风险。

## 由其他扩展管理的供应商

扩展可以在运行时整体替换某个 provider 的 `models` 数组，这时 `models.json` 里只剩静态兜底
和凭据。往那儿写模型参数是无效的，强行「修复」等于跟那个扩展互相覆盖。所以这类 id
**只报告、不自动改写**，add 时也会先提醒。

声明一次即可：

```json
// ~/.pi/agent/model-config.json
{ "runtimeProviders": ["my-provider"] }
```

或 `PI_MODEL_CONFIG_RUNTIME_PROVIDERS="a,b"`。id 大小写不敏感。`model-config.json` 写坏了
只会降级成「没有配置项」并给出提示 —— 它永远不能把命令弄瘫。

## 它会写什么

- `models.json` —— 先备份成 `models.json.bak-<毫秒时间戳>`，再原子写入（临时文件 + rename），
  中断不会留下半截文件，重写也不会放宽已有的严格权限（如 0600）。同名的三个文件
  （models.json / settings.json / model-config.json）的时间戳备份都只保留最近 5 份；
  备份本身失败时会给出警告（写入照常进行，不会因此中断）。写入会重排整个文件，
  手写的 `//` 注释不会保留。
- `settings.json` —— 只碰 `enabledModels`，且只在其非空时：添加供应商会自动追加 `<id>/*`；
  删除时会先问。

### `/model` 的快照问题

`/model` 选择器用的是会话启动时的 `enabledModels` 快照，而 `agent-session.reload()`
不会重算它。所以刚加或刚删的供应商只在**新会话或重启 pi 之后**才出现 / 消失 —— `/reload`
不够。所有提示都如实这么说。

## API Key

Key 从对话框读入、写进 `models.json`，而 pi 以明文保存该文件。Key 永远不会被打印回来：
短到「前 6 + 后 4」就等于全泄露的，只报长度。base URL 是 `http://` 且非回环地址时，
不加确认不往下走 —— 那样 Key 是明文上路的。

## Google Gemini

Gemini 的 REST 用 `?key=` 鉴权而不是 bearer，所以探测走查询参数；base URL 没有版本段时
补 `/v1beta`；读 `name` / `inputTokenLimit` / `outputTokenLimit`；并按
`supportedGenerationMethods` 过滤掉 embedding 之类的非对话模型。

## 配置文件一览

| 文件 | 用途 |
| --- | --- |
| `~/.pi/agent/models.json` | 读写。JSONC：允许注释和尾逗号。 |
| `~/.pi/agent/settings.json` | 只碰 `enabledModels`。严格 JSON，与 Pi 的 settings-manager 一致。 |
| `~/.pi/agent/model-config.json` | 可选：`runtimeProviders`、`hiddenModels`。 |
| `~/.pi/agent/model-config-modelsdev-cache.json` | models.dev 缓存，删了没事。 |

设置 `PI_CODING_AGENT_DIR` 可以把以上全部指到别处。

## 开发

```bash
npm test        # node --test，不联网，零依赖
npm run lint    # 全量源文件语法检查
```

测试会在临时目录里自建 `PI_CODING_AGENT_DIR` 并注入假 `fetch`，不碰网络，也不碰你真实的
`models.json`。

## 老实说清限制

- 参数质量取决于来源。端点什么都不报、models.dev 又没收录的模型，拿到的是按名字猜的默认值，
  报告里会标成 `guessed`。请核对，然后手改 `models.json`。
- 只写 `models.json` 这一种格式，不修改 Pi 自带的 provider。
- 不推断价格：所有模型一律写零成本。要控预算请用 spend guard 类扩展。
- 已消失的模型永远不会被自动删除。

## 许可证

MIT
