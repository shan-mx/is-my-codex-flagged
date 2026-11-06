# is-my-codex-flagged

Codex 一直报 `Selected model is at capacity`？一条命令确认是不是被风控了。

## 用法

```bash
npx github:shan-mx/is-my-codex-flagged
```

## 原理

走 OpenAI 官方登录，然后以你的账号向 `api.openai.com/v1/responses`（模型 `gpt-6-luna`）发一条真实消息。

| 看到什么 | 结论 | 退出码 |
| --- | --- | --- |
| 2xx | 正常 | 0 |
| 响应含 `subscription_sharing_user_not_eligible` | 被风控 | 1 |
| 其它 | 检测失败 | 2 |

## 安全

- 只和 `auth.openai.com`、`api.openai.com` 通信，不会把 token 发给任何第三方。
- 单个文件、200行代码、零依赖，可以直接读代码核对。

[MIT](./LICENSE)
