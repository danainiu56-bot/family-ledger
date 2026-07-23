# voice-plan 部署

```bash
supabase link --project-ref kjasiqqtihagwsnthbvc
supabase db push
supabase secrets set OPENAI_API_KEY=你的密钥
supabase functions deploy voice-plan --no-verify-jwt
```

可选限制允许调用的网页来源：

```bash
supabase secrets set VOICE_PLAN_ALLOWED_ORIGINS=https://danainiu56-bot.github.io,https://cdn.jsdelivr.net
```

函数不会保存录音；每次最多处理 30 秒、拆分 10 条计划，并通过数据库迁移中的限流函数约束调用次数。
