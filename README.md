# Magpie 豆包 Seed Translation

让官方 [Read Frog（陪读蛙）](https://github.com/mengxi-ream/read-frog) 通过 [Magpie](https://usemagpie.ai/) 使用火山方舟的豆包 Seed Translation 专用翻译模型。

**无需魔改 Frog，也无需添加专用提示词：网页和字幕都选择内置「默认」模板即可。** 仍需配置 API 提供商、选择功能提供商，并录入自己的火山方舟 API key。

```text
官方 Frog（默认翻译模板）
    → 本机 Magpie /v1/chat/completions
    → 本插件（提取原文和目标语言、转换协议）
    → 火山方舟 /api/v3/responses
    → Chat Completions JSON / SSE → Frog
```

这是专用翻译引擎的适配器，不是通用聊天模型，不使用豆包网页 Cookie，也不接管浏览器代理。Magpie 本身的供应商代理设置仍决定上游连接方式。

## 前提与兼容范围

- 已安装并运行 Magpie，支持供应商插件；实测宿主版本为 `0.1.1137`。
- 官方 Frog；默认提示词格式已核对 `1.50.2`。其他版本未承诺兼容。
- 自己的火山方舟 API key，且有对应模型或接入点权限。API 调用可能收费。
- 默认上游模型：`doubao-seed-translation-250915`。该具体版本曾由本地用户验证可用，不保证其他账户有权限或该版本永久可用。
- 无额外 npm 运行时依赖。开发测试需要 Node.js 22.12+；隔离宿主测试还需要 Magpie 和 Bun 1.2+。

首次使用火山方舟，可从[官方控制台](https://console.volcengine.com/ark)创建 API key 并确认模型权限。具体开通和计费以控制台为准，本插件不能替你开通权限。

版本 `1.1.0` 已通过单元测试和真实 Magpie＋模拟上游的隔离测试。2026-10-10，本地用户也报告默认模板切换后的实际使用测试通过；这不代表所有语言、页面和视频场景都已覆盖。见 [验证记录](TEST-REPORT.md)。

## 1. 安装插件并录入 API key

将本项目克隆到长期保留的目录，再安装：

```sh
git clone https://github.com/GoldenMan-Zia/magpie-doubao-seed-translate.git
cd magpie-doubao-seed-translate
magpie plugin add "$PWD"
magpie plugin login doubao-seed
magpie plugin list
```

也可以下载并解压本项目，在 Magpie「插件」界面添加项目文件夹，再在 `doubao-seed` 供应商下录入 API key。

`login` 是交互式填写 **火山方舟 API key**，不是网页账号登录或 OAuth。不要把 key 写进命令行、源码或插件 options。Magpie 将凭据保存在其配置目录的 `plugin-auth.json` 中；宿主按私有权限管理，项目不包含该文件。

本地文件夹是**就地加载**的，安装后不要移动或删除。源码更新后，在 Magpie 里关闭再打开本插件以重载。不要同时安装两个目录副本，它们会注册同一个供应商。

应看到供应商 `doubao-seed` 和模型：

```text
doubao-seed/translate
```

## 2. 配置 Frog 提供商

在 Frog「API 提供商」中添加 **OpenAI-compatible / OpenAI 兼容**提供商，不选 Open Responses：

| 字段 | 值 |
|---|---|
| 名称 | Magpie 豆包翻译（可自行命名） |
| Base URL | `http://127.0.0.1:3425/v1` |
| 自定义模型 | `doubao-seed/translate` |
| API key | Magpie 网关客户端凭据，**不是火山方舟 API key** |

地址按你的本机 Magpie 监听端口调整。默认仅监听 localhost 的模式下，Magpie 帮助说明客户端 key 可以填任意值，例如 `magpie`；启用访问控制时使用有权访问该模型的客户端凭据。不要将无访问控制的网关暴露到公网。

将网页翻译、划词翻译、输入翻译、视频字幕所用的提供商选择为它。**网页翻译和视频字幕的提示词都保持内置「默认」**；目标语言仍在 Frog 的语言设置中正常选择。

关闭 Frog 术语表：插件目前不能兑现术语表要求，遇到匹配术语规则会拒绝请求。词典、笔记建议、自定义 AI 指令、语言检测和字幕重分段等通用 AI 功能应使用其他通用模型。

### 从旧专用模板切换

已有专用模板的用户，把「网页翻译」和「视频字幕」的模板都切回内置「默认」，提供商、模型和凭据保持不变。旧模板不必立即删除，`1.1.0` 仍兼容它，可用于回退。

如需把已安装插件移动到新目录，先记下非默认插件选项，只移除旧插件注册，不执行供应商 logout；随后添加新目录并恢复选项。账号凭据由 Magpie 管理，新目录不需要复制任何认证文件。若宿主显示未登录，重新交互录入 key 即可。

## 3. 验证

先在 Frog 中用一段未翻译过的新文本测试。旧缓存命中不能证明这条链路生效。不建议直接运行 `magpie provider test doubao-seed`：它发送通用聊天内容，不满足翻译请求格式，可能被正确拒绝。

项目提供可选的真实接口检查：

```sh
node scripts/verify.mjs --real-upstream
```

未带 `--real-upstream` 时不会发送请求。带开关后发送三个小网关请求，批量项拆成两段，**共四次豆包调用，可能产生费用**。脚本使用默认网页和字幕模板，只允许回环网关地址，不打印密钥或原始错误正文。

可用环境变量 `MAGPIE_GATEWAY_URL` 指定其他本机地址，`MAGPIE_GATEWAY_KEY` 指定客户端凭据；不要把真实 key 写进公开终端记录或 issue。

浏览器人工检查：

| 场景 | 检查内容 |
|---|---|
| 网页 | 多段内容不串段，链接、加粗和公式保留 |
| 划词 | 弹窗只显示译文，不出现 Translate to 或协议头 |
| 输入 | 在非敏感输入框测试，切换目标语言后仍有效 |
| 字幕 | 使用已有字幕的视频，段落顺序和边界正确；不包含语音识别或字幕重分段 |
| 取消 | 停止翻译后请求取消；超时和限流可见 |

## 工作原理与边界

插件识别 Frog 内置默认翻译请求，从系统模板和用户消息头交叉核对目标语言，精确移除一次用户消息头，再把原文放入豆包 `input_text`，语言放入 `translation_options.target_language`。默认模式让上游自动检测源语言。

**不向豆包透传 Frog 的系统提示词、网页摘要或视频背景。** 接受默认模板不表示豆包会执行其中每条规则。任意自定义提示词和「精确重写」不在支持范围内；请求格式无法识别时直接报错，不猜测原文，也不将提示词当作原文翻译。

- 批量翻译：识别 Frog 的批量规则，按独占 `%%` 行拆段，逐段调用豆包并按原序拼回。合批不减少上游调用次数。单段失败则整个批次失败，不返回错位的部分结果。
- 结构保护：检查 HTML 标签、属性、嵌套和 `{{…}}` 占位符。损坏时返回错误，不插入页面。检查较保守，可能拒绝含不配对 HTML 的代码示例；它不是语义或翻译质量保证。
- 流式：上游使用非流式请求，全部段落翻译和校验完成后包装为 SSE。不是边生成边显示。
- 语言：静态语言名称映射用于请求转换，不等于豆包支持语言表。未知语言报错，粤语不偷换成普通话；实际支持以账户所用模型为准。
- 原文限制：Frog 自身会替换内置占位串；原文独占 `%%` 行可能与批量协议冲突。网页摘要中若恰好出现完整批量规则，也可能与请求附加规则混淆。这些边界无法仅靠聊天消息协议彻底消除。
- 失败处理：取消和超时传播给上游；保留 HTTP 状态与合法 `Retry-After`，不转发上游原始错误正文。插件不自动重试，避免与 Frog/Magpie 重试叠加。
- 故障切换：不要随意回退到通用聊天供应商；备用模型也必须遵守同样的输入输出翻译协议。

本插件只发送原文和语言参数到配置的上游。Frog/Magpie 各自的缓存和日志策略仍由各自管理，请勿用敏感内容测试或提交问题。

## 可选配置

通常保持默认即可。若账户需使用其他模型/接入点，在 Magpie 插件选项里填 [配置示例](templates/plugin-options.json)：

| 选项 | 默认值 | 含义 |
|---|---|---|
| `upstreamURL` | `https://ark.cn-beijing.volces.com/api/v3/responses` | 完整 HTTPS 接口，不是 `/v1` 基地址 |
| `upstreamModel` | `doubao-seed-translation-250915` | 实际可用模型，或 `ep-…` 接入点 |
| `timeoutMs` | `60000` | 整个请求含排队和所有段落的超时 |
| `batchConcurrency` | `2` | 每个账号实例同时发送的段落请求上限 |
| `maxBatchItems` | `32` | 一个请求的最大段落数 |
| `maxInputChars` | `24000` | 原文总字符上限，不等于 token 限额 |

接口禁止跟随重定向。自定义上游地址必须可信，否则会将 API key 和原文发送给该地址。options 不接受 `apiKey`；仅供测试的 `allowLocalTestServer` 不应在正常使用中开启。

## 排障

| 问题 | 先检查 |
|---|---|
| 提示格式不支持 / `missing_contract` | 网页和字幕是否都选了内置默认模板；是否换成精确重写；Frog 版本是否变化 |
| `invalid_contract` | 是否改了用户消息头，或系统与用户目标语言不一致 |
| `unsupported_glossary` | 关闭该功能所用的 Frog 术语表 |
| 401 / 403 | Magpie 是否录入火山 key、账户是否有模型权限；区分网关与上游认证 |
| 404 | 上游模型名、接入点或接口地址是否可用；不要使用未经验证的模型别名 |
| 429 | 额度或限流；降低 Frog 并发/批量规模并配置 Magpie RPM |
| HTML / 占位符错误 | 上游改变了受保护结构；换小段文本复现，不关闭安全检查来掩盖问题 |
| 网关连接失败 | Magpie 是否运行、本机端口是否正确；这不等于浏览器代理被修改 |

## 开发与测试

```sh
npm test
npm run test:coverage
npm run test:gateway
```

无需安装项目运行时依赖。前两项为离线测试；最后一项需本机 Magpie、Bun 和回环监听权限，以临时 HOME、假 key、随机端口运行真实宿主及模拟上游，不修改现用配置、不产生豆包费用。

`test/fixtures/frog-1.50.2.json` 固定了已核对的上游默认模板。Frog 更新时应核对原始请求格式后更新识别和测试，不扩大模糊匹配来掩盖不兼容。GitHub Actions 只运行 Node 测试，不安装 Magpie、不调用收费接口。

项目保留 `private: true`，防止误发 npm；不影响将源码上传 GitHub。本项目不包含用户配置、API key、浏览器插件包或迁移备份。

## 许可与协议来源

GPL-3.0-only；见 [LICENSE](LICENSE) 和 [第三方说明](NOTICE.md)。默认模板文本的来源和归属保留在第三方说明中。

- [Magpie 供应商插件文档](https://usemagpie.ai/docs/zh/plugins)
- [Frog 模板和批量规则](https://github.com/mengxi-ream/read-frog/blob/main/src/utils/constants/prompt.ts)
- [Frog 请求组装](https://github.com/mengxi-ream/read-frog/blob/main/src/utils/prompts/translate.ts)

这里是独立社区集成，不是 Magpie、Frog 或火山方舟官方插件。
