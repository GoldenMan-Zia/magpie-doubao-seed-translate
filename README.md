# Magpie 豆包 Seed Translation

通过 [Magpie](https://usemagpie.ai/) 在官方 [Read Frog（陪读蛙）](https://github.com/mengxi-ream/read-frog) 中使用火山方舟的豆包 Seed Translation 专用翻译模型。

**无需修改 Frog，也无需添加专用提示词。** 配置好提供商后，网页和字幕使用内置「默认」模板即可。

```text
Frog → 本机 Magpie 网关 → 本插件 → 火山方舟 Seed Translation API
```

这是独立的社区集成，不是 Magpie、Frog 或火山方舟官方插件。不使用豆包网页 Cookie，不修改浏览器代理。

## 准备

- 安装 Magpie 和官方 Frog。已测试兼容 Magpie `0.1.1137`、Frog `1.50.2`；其他版本需自行验证。
- 在[火山方舟控制台](https://console.volcengine.com/ark)创建 API key，并确认账户具有 Seed Translation 模型或接入点权限。真实 API 调用可能收费。
- 默认上游模型是 `doubao-seed-translation-250915`；若账户使用其他可用模型或接入点，可在插件选项中修改。
- 网关验证脚本需要 Node.js 22.12+。插件无额外 npm 运行时依赖。

## 1. 在 Magpie 安装插件

### 图形界面

1. 下载本仓库并解压到长期保留的目录。
2. 打开 Magpie 的「插件」页面，添加该文件夹并启用插件。
3. 找到插件提供的 `doubao-seed` 供应商，选择 API key 登录方式，填入自己的火山方舟 API key。
4. 确认供应商已登录，并能看到模型 `doubao-seed/translate`。

### 命令行

```sh
git clone https://github.com/GoldenMan-Zia/magpie-doubao-seed-translate.git
cd magpie-doubao-seed-translate
magpie plugin add "$PWD"
magpie plugin login doubao-seed
magpie plugin list
```

`login` 交互式录入 API key，不是网页账号登录或 OAuth。凭据由 Magpie 管理，不要写入源码、插件选项或命令行参数。

文件夹就地加载，安装后不要移动或删除。更新源码后，在 Magpie 中关闭再打开本插件以重载。

## 2. 配置 Magpie 插件和网关

### 插件选项

在 Magpie 的已安装插件中打开本插件的选项。通常可以保持默认；需要修改模型或接入点时，填写 JSON，例如：

```json
{
  "upstreamModel": "doubao-seed-translation-250915",
  "timeoutMs": 60000,
  "batchConcurrency": 4
}
```

`upstreamModel` 是**火山方舟实际调用的模型或接入点**。Frog 使用的模型名称始终是 `doubao-seed/translate`，两者不要混淆。

命令行也可设置选项。在项目目录执行：

```sh
magpie plugin options "$PWD" '{"upstreamModel":"doubao-seed-translation-250915","timeoutMs":60000,"batchConcurrency":4}'
```

此命令设置整份选项；未填写的项恢复为插件默认值。已有其他自定义选项时，应一并保留。完整示例见 [plugin-options.json](templates/plugin-options.json)。

| 选项 | 默认值 | 含义 |
|---|---|---|
| `upstreamURL` | `https://ark.cn-beijing.volces.com/api/v3/responses` | 完整 HTTPS 上游接口 |
| `upstreamModel` | `doubao-seed-translation-250915` | 模型 ID 或 `ep-…` 接入点 ID |
| `timeoutMs` | `60000` | 整个请求含排队与所有段落的超时，单位毫秒 |
| `batchConcurrency` | `4` | 每个账号实例同时发送的段落请求上限 |
| `maxBatchItems` | `32` | 一个请求的最大段落数 |
| `maxInputChars` | `24000` | 原文总字符上限，不等于 token 上限 |

`batchConcurrency` 可设置为 1–8，默认 4；频繁出现 429 时可以降到 2。它限制同一适配器实例的上游段落请求，与 Magpie 宿主的网关请求并发不是同一项。

options 不接受 `apiKey`。自定义上游必须可信，该地址会收到原文和火山 API key。仅供开发测试的 `allowLocalTestServer` 不应在正常使用中开启。

### 网关地址与客户端凭据

保持 Magpie 应用运行，它会提供本机网关。默认地址为 `http://127.0.0.1:3425`，OpenAI 兼容 Base URL 为 `http://127.0.0.1:3425/v1`。如修改过监听地址或端口，以 Magpie 当前网关配置为准。

没有运行图形应用时，也可以单独启动网关：

```sh
magpie serve
```

应用已提供网关时，不要重复启动同端口的服务。

| 凭据 | 填在哪里 | 用途 |
|---|---|---|
| 火山方舟 API key | Magpie 的 `doubao-seed` 供应商登录 | Magpie 调用豆包接口 |
| Magpie 网关客户端 key | Frog 的 API key 字段 | Frog 调用本机 Magpie |

默认仅监听 localhost 的模式下，Magpie 允许任意客户端 key，可填 `magpie`。若启用了网关访问控制，需要创建专用客户端 key，并允许访问 `doubao-seed/translate`。命令行管理方式：

```sh
magpie gateway-key add frog-translate
# 保存上一条命令生成的凭据，并用显示的 key ID 设置模型范围：
magpie gateway-key models <key-id> doubao-seed/translate
```

`<key-id>` 是占位符，需替换为实际 ID。生成的凭据不要分享或提交到仓库。仅本机使用不需要为了安装此插件额外开放局域网或公网监听。

## 3. 先测试 Magpie 链路

在接入 Frog 前，先区分「网关可达」和「实际翻译成功」。

### 网关可达检查

```sh
magpie healthcheck
```

退出码为 0 表示网关可达；**不代表插件已登录、模型权限正确或翻译成功**。该检查不调用豆包翻译接口。

### 实际翻译检查

保持 Magpie 运行，在项目目录执行：

```sh
node scripts/verify.mjs --real-upstream
```

脚本通过 Magpie 的 `doubao-seed/translate` 模型发送 Frog 默认格式的请求，检查单段中文翻译、批量 HTML/占位符，以及字幕模板的 SSE 返回。成功时依次输出：

```text
PASS 1/3: plain text produced Chinese output.
PASS 2/3: two batch items, HTML and placeholder boundaries survived.
PASS 3/3: Chat Completions SSE completed with Chinese output.
```

**这会发送三个网关请求、四次小豆包调用，可能收费。** 未传 `--real-upstream` 时只显示说明，不发送请求。

默认使用 `http://127.0.0.1:3425/v1` 和客户端 key `magpie`。其他本机端口可通过环境变量设置：

```sh
MAGPIE_GATEWAY_URL=http://127.0.0.1:3426/v1 node scripts/verify.mjs --real-upstream
```

访问控制模式还需设置 `MAGPIE_GATEWAY_KEY`。在 zsh/bash 中可隐藏输入，避免把真实 key 写入命令历史：

```sh
printf 'Magpie gateway key: '
read -r -s MAGPIE_GATEWAY_KEY
printf '\n'
export MAGPIE_GATEWAY_KEY
node scripts/verify.mjs --real-upstream
unset MAGPIE_GATEWAY_KEY
```

验证脚本仅允许回环网关地址，不打印凭据和原始错误正文。**不要用 Magpie 的通用聊天测试或 `magpie provider test doubao-seed` 代替它**：本插件接受翻译请求，不接受任意聊天内容，通用测试可能被正确拒绝。

## 4. 配置 Frog

在 Frog「API 提供商」中添加 **OpenAI-compatible / OpenAI 兼容**提供商，不选 Open Responses：

| 字段 | 值 |
|---|---|
| 名称 | Magpie 豆包翻译（可自行命名） |
| Base URL | `http://127.0.0.1:3425/v1`，或你的实际网关地址 |
| 自定义模型 | `doubao-seed/translate` |
| API key | Magpie 网关客户端凭据，默认本机模式可填 `magpie` |

将网页翻译、划词翻译、输入翻译、视频字幕所用的提供商选择为它。**网页和字幕的提示词都选择内置「默认」**，目标语言照常在 Frog 语言设置中选择。

关闭 Frog 术语表；本插件尚不支持术语要求，遇到匹配的术语规则会报错。词典、笔记建议、自定义 AI 指令、语言检测和字幕重分段等功能使用其他通用模型。

先用未翻译过的新文本检查网页和划词，再测试输入翻译与已有原始字幕的视频。检查目标语言、段落顺序、链接、加粗和公式是否正常。缓存命中不能证明当前链路生效。

## 功能边界

- **专用翻译，不是通用聊天。** 插件从默认请求中提取原文和目标语言，不向豆包透传系统提示词、网页摘要或视频背景。任意自定义提示词和「精确重写」不在支持范围内。
- **批量按段调用。** 识别 Frog 批量规则，按独占 `%%` 行拆段，翻译后按原序拼回。合批不减少上游调用次数；单段失败则整批失败。
- **保护结构。** 检查 HTML 标签、属性、嵌套和 `{{…}}` 占位符，结构损坏时拒绝结果。检查较保守，不等于语义或翻译质量保证。
- **兼容 SSE，不是原生流式生成。** 上游使用非流式请求，翻译和校验完成后包装为 SSE 返回。
- **语言支持以模型为准。** 语言名称映射不等于豆包支持语言表；未知语言报错，粤语不会偷换成普通话。
- **聊天协议有歧义边界。** Frog 自身会替换内置占位串；原文独占 `%%` 行、摘要中出现完整批量规则可能与协议混淆。
- **取消与错误。** 超时和取消传播给上游，保留 HTTP 状态及合法 `Retry-After`，不转发原始错误正文。插件不自动重试。

插件请求服从 Magpie 的供应商/账号代理设置。Frog、Magpie 各自的缓存和日志策略仍由各自管理。不要向通用聊天模型配置自动故障切换，也不要用敏感内容测试或提交 issue。

## 开发与测试

开发需要 Node.js 22.12+，无须安装项目运行时依赖：

```sh
npm test
npm run test:coverage
```

真实 Magpie 宿主与模拟上游的隔离测试另需 Magpie、Bun 1.2+ 和回环监听权限：

```sh
npm run test:gateway
```

隔离测试使用临时 HOME、假 key 和随机端口，不修改现用配置、不调用收费接口。GitHub Actions 运行 Node.js 22/24 测试，不安装 Magpie、不调用真实接口。

`test/fixtures/frog-1.50.2.json` 固定已核对的默认模板。Frog 更新后应核对实际请求并更新识别和测试。测试范围见 [TEST-REPORT.md](TEST-REPORT.md)。项目保留 `private: true` 防止误发 npm，不影响 GitHub 源码分发。

## 许可与参考

GPL-3.0-only；见 [LICENSE](LICENSE) 和 [第三方说明](NOTICE.md)。

- [Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins)
- [Frog 模板和批量规则](https://github.com/mengxi-ream/read-frog/blob/main/src/utils/constants/prompt.ts)
- [Frog 请求组装](https://github.com/mengxi-ream/read-frog/blob/main/src/utils/prompts/translate.ts)
