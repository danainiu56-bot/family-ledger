# Cloudflare Worker 部署 AI 开支建议

这个 Worker 只代理 `AI 开支建议` 请求：

- 不连接 Supabase 数据库
- 不读取或写入 `ledgers` 表
- 不影响现有 H5/小程序记账、同步、共享功能
- 只接收前端传来的本月汇总数据，调用智谱 GLM-4-Flash 返回建议

## 1. 创建 Worker

1. 打开 Cloudflare Dashboard
2. 进入 `Workers & Pages`
3. 点击 `Create application`
4. 选择 `Worker`
5. Worker 名称建议填：`family-ledger-ai-summary`
6. 创建后进入代码编辑器，把 `cloudflare/ai-summary-worker.js` 的内容完整粘贴进去
7. 点击 `Deploy`

部署后会得到一个 Worker URL，类似：

```text
https://family-ledger-ai-summary.<你的账号>.workers.dev
```

## 2. 配置智谱 Key

进入该 Worker 的 `Settings` → `Variables`，添加环境变量：

```text
ZHIPU_API_KEY=你的智谱 API Key
```

注意：

- 不要加 `Bearer`
- 不要加引号
- 不要带空格或换行

保存后重新部署一次 Worker。

## 3. 测试 Worker

把下面命令里的 `WORKER_URL` 替换成你的 Worker URL：

```bash
curl -X POST "WORKER_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "monthKey": "2026-06",
    "overview": {
      "income": 1212120,
      "saving": 0,
      "spent": 900,
      "planned": 900,
      "budget": 1212120,
      "balance": 1211220,
      "ranked": [
        {
          "name": "房租",
          "paid": 900,
          "segments": [
            { "label": "水电", "amount": 800 },
            { "label": "油费", "amount": 100 }
          ]
        }
      ]
    }
  }'
```

如果返回里有 `advice`，说明 Worker 可用。

## 4. 切换 H5 和小程序

确认 Worker 可用后，把 Worker URL 填到：

- `scripts/pages/bookkeeping-config.js` 的 `aiSummaryUrl`
- `miniprogram/config.js` 的 `aiSummaryUrl`

例如：

```js
aiSummaryUrl: 'https://family-ledger-ai-summary.<你的账号>.workers.dev'
```

然后重新打包 H5、提交推送。小程序还需要在微信公众平台添加 request 合法域名：

```text
https://family-ledger-ai-summary.<你的账号>.workers.dev
```

并重新上传体验版/发布。
