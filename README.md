# ZCode → DSH 凭据桥

把 ZCode 桌面客户端里已经登录的**智谱 BigModel 账号**搬进 DSH，让 `dsh-llm-zcode` 插件里的 `zcode-cn` 路由直接可用。

## 它解决的是什么

`dsh-llm-zcode` 的 `zcode-cn` 路由，模型端点是接对的（`open.bigmodel.cn/api/anthropic`），但**登录链路是从 z.ai 逆向来的**（`/api/v1/oauth/cli/init` → `/api/auth/z/login` → 开 API Key）。智谱那边没有这套接口，实测那几个路径全部返回同一个 HTML 首页。

智谱官方给国内用户的方式是「账号登录 / 填 API Key」，而 ZCode 客户端自己就把登录态存在本地了。本工具做的事就是把那份登录态搬过去。

## 安装

不需要安装，直接用：

```bash
node import-zcode.mjs --check     # 只体检，不写
node import-zcode.mjs --dry-run   # 看会写入什么
node import-zcode.mjs             # 体检通过才写入
```

要求 Node 22 或 24+。零依赖。

## 它怎么工作

1. 读 `~/.zcode/v2/credentials.json`（ZCode 客户端的登录态）
2. 用客户端自己的算法解密：`AES-256-GCM`，密钥是 `sha256(ZCODE_CREDENTIAL_SECRET)`；该环境变量不存在时退回机器信息派生（`zcode-credential-fallback:{platform}:{homedir}:{username}`）
3. 拿 token 对 `open.bigmodel.cn/api/anthropic/v1/messages` 发一个 16 token 的真实请求
4. **体检通过才写** `~/.dsh/.credentials.yaml` 里的 `llm-zcode/zcode-cn` 记录
5. 写入前自动备份原文件（`.bak-{时间戳}`）

第 4 步是有意为之：一个「认证通过但花不掉额度」的凭据写进去，只会把失败推迟到下一个请求，不如现在就说清楚。

## 参数

| 参数 | 作用 |
|---|---|
| `--check` | 只解密 + 体检，不写文件 |
| `--dry-run` | 额外打印将要写入的记录（token 截断显示） |
| `--route <provider>` | 指定 provider，默认从 `oauth:active_provider` 读 |
| `--store <path>` | 指定凭据库路径，默认 `~/.dsh/.credentials.yaml` |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（或 `--check` 通过） |
| 1 | 解密失败 / 找不到登录态 / 参数错误 |
| 2 | 认证有效但**无法消费额度**（套餐到期或余额不足），已拒绝写入 |

## 会遇到的错误码

这两个是实测过的真实响应，不是推测：

| 响应 | 含义 | 怎么办 |
|---|---|---|
| `429 code 1309` 您的GLM Coding Plan套餐已到期 | 凭据有效，套餐过期 | 续订 https://bigmodel.cn/claude-code 后重跑 |
| `429 code 1113` Insufficient balance or no resource package | 额度/资源包不足 | 充值，或确认套餐覆盖该端点 |
| `401` | 登录态过期 | 在 ZCode 客户端重新登录后重跑 |

## 已验证到什么程度

| 环节 | 状态 | 证据 |
|---|---|---|
| 定位客户端加密实现 | ✅ | 从 `ZCode.exe` 的 `app.asar` 里解出 `createCredentialCipherProvider` |
| 解密 ZCode 登录态 | ✅ | 成功解出账号 `flpfjuq3`、`active_provider=bigmodel` |
| 端点连通性 | ✅ | 真实 POST 到 `open.bigmodel.cn/api/anthropic/v1/messages` |
| 凭据被服务端认可 | ✅ | 服务端返回了针对该账号的套餐到期提示，而不是 401 |
| 写入 DSH 凭据库 | ✅ | 在隔离副本上验证：YAML 可解析、新旧记录均完好 |
| Coding Plan 端点调用 | ❌ | 被 `429 code 1309` 挡住 —— **套餐到期，不是代码问题** |

## 渠道实测：glm-5.3 到底哪个端点能用

2026-10-24 用同一把 bigmodel 凭据逐端点实测，结论是**只有一个能用**：

| 端点 | 结果 | 说明 |
|---|---|---|
| `open.bigmodel.cn/api/paas/v4` | ✅ 可用 | 普通 API，OpenAI 协议，正常返回并计费 token |
| `open.bigmodel.cn/api/anthropic` | ❌ 429 code 1309 | Coding Plan 专属，套餐到期即拒绝 |
| `open.bigmodel.cn/api/coding/paas/v4` | ❌ 429 | 同上，走套餐额度 |
| `api.z.ai/api/anthropic` | ❌ 429 code 1309 | 国际版套餐同样过期 |
| `zcode.z.ai/api/v1/zcode-plan/anthropic` | ❌ 404 | 客户端内部路径，并不对外 |

由此可以推出一个实用结论：**套餐过期时，普通 API 通道仍然可用**，用不着等续订。
把它接进 DSH 比改 zcode 插件的登录链路更省事，而且和套餐路由互不干扰。

`add-ref.mjs` 就是为这条通道准备的：往 DSH 凭据库的 `refs` 段加一个 `apiKeyEnv` 能读到的键。

```bash
node add-ref.mjs ~/.dsh/.credentials.yaml BIGMODEL_API_KEY <你的 key>
```

配套的 provider 配置（写进 profile 的 `cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      bigmodel-cn:
        displayName: 智谱 BigModel
        apiKeyEnv: BIGMODEL_API_KEY
        api: openai-completions
        baseURL: https://open.bigmodel.cn/api/paas/v4
        models:
          - id: glm-5.3
            name: GLM-5.3
            contextWindow: 200000
```

注意 `refs` 是 YAML flow mapping，新增条目必须在**前一条末尾补逗号**，否则整份凭据库解析失败。
`add-ref.mjs` 已经处理了这点，并且写入前会用解析器复核。

## 安全说明

- 不修改 ZCode 客户端任何文件，只读
- 不把 token 打到标准输出（只显示前 12 字符）
- 写入前备份；写入只碰 `records:` 段里的目标键，其他记录原样保留
- 文件不认识（不以 `version:` 开头、没有 `records:`）时直接拒绝，不猜格式
