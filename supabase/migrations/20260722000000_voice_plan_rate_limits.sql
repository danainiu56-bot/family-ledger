create table if not exists public.voice_plan_rate_limits (
  bucket_key text primary key,
  request_count integer not null default 0,
  expires_at timestamptz not null
);

revoke all on table public.voice_plan_rate_limits from anon, authenticated;

create or replace function public.check_voice_plan_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  insert into public.voice_plan_rate_limits (bucket_key, request_count, expires_at)
  values (p_bucket_key, 1, p_expires_at)
  on conflict (bucket_key) do update
  set
    request_count = case
      when voice_plan_rate_limits.expires_at <= now() then 1
      else voice_plan_rate_limits.request_count + 1
    end,
    expires_at = case
      when voice_plan_rate_limits.expires_at <= now() then excluded.expires_at
      else voice_plan_rate_limits.expires_at
    end
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.check_voice_plan_rate_limit(text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.check_voice_plan_rate_limit(text, integer, timestamptz)
  to service_role;
