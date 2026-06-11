#!/usr/bin/env node
/**
 * 一键在 Supabase 创建 ledgers 表（需数据库密码）。
 * 密码位置：Supabase Dashboard → Project Settings → Database → Database password
 *
 * 用法：
 *   SUPABASE_DB_PASSWORD='你的密码' node scripts/setup-supabase-ledgers.cjs
 *
 * 可选环境变量：
 *   SUPABASE_PROJECT_REF  默认 kjasiqqtihagwsnthbvc
 *   SUPABASE_DB_HOST      默认 db.kjasiqqtihagwsnthbvc.supabase.co
 */
const https = require('https');

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'kjasiqqtihagwsnthbvc';
const DB_HOST = process.env.SUPABASE_DB_HOST || ('db.' + PROJECT_REF + '.supabase.co');
const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_PASSWORD;

const SQL = `
create table if not exists public.ledgers (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ledgers enable row level security;

drop policy if exists "allow anon access" on public.ledgers;
create policy "allow anon access"
  on public.ledgers for all
  using (true)
  with check (true);

grant select, insert, update, delete on table public.ledgers to anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ledgers'
  ) then
    alter publication supabase_realtime add table public.ledgers;
  end if;
end $$;
`.trim();

function verifyTable() {
  return new Promise(function (resolve, reject) {
    var fs = require('fs');
    var path = require('path');
    var cfgText = fs.readFileSync(path.join(__dirname, 'pages/bookkeeping-config.js'), 'utf8');
    var urlMatch = /supabaseUrl:\s*'([^']+)'/.exec(cfgText);
    var keyMatch = /supabaseAnonKey:\s*'([^']+)'/.exec(cfgText);
    if (!urlMatch || !keyMatch) return reject(new Error('无法读取 bookkeeping-config.js'));

    var url = new URL(urlMatch[1] + '/rest/v1/ledgers?select=id&limit=1');
    var req = https.request(url, {
      method: 'GET',
      headers: {
        apikey: keyMatch[1],
        Authorization: 'Bearer ' + keyMatch[1]
      }
    }, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error('验证失败 HTTP ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  if (!DB_PASSWORD) {
    console.error('缺少 SUPABASE_DB_PASSWORD 环境变量。');
    console.error('请到 Supabase → Project Settings → Database 复制 Database password 后执行：');
    console.error("  SUPABASE_DB_PASSWORD='你的密码' node scripts/setup-supabase-ledgers.cjs");
    process.exit(1);
  }

  var pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('正在安装 pg 驱动…');
    require('child_process').execSync('npm install pg --no-save', { stdio: 'inherit', cwd: require('path').join(__dirname, '..') });
    pg = require('pg');
  }

  var client = new pg.Client({
    host: DB_HOST,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });

  console.log('连接 Supabase 数据库…');
  await client.connect();
  console.log('执行建表 SQL…');
  await client.query(SQL);
  await client.end();
  console.log('建表完成，正在验证 REST API…');
  var body = await verifyTable();
  console.log('验证成功：', body);
  console.log('ledgers 表已就绪，可以回到记账本点「分享」测试。');
}

main().catch(function (err) {
  console.error('失败：', err.message || err);
  process.exit(1);
});
