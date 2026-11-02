-- Read-only operational check. This reads Postgres metadata, not stored logs,
-- and does not consume Supabase's Log Query scan allowance. Run on demand.
begin read only;
select jsonb_build_object(
  'checked_at', now(),
  'settings', (
    select jsonb_agg(jsonb_build_object('name', name, 'value', setting, 'unit', unit,
      'pending_restart', pending_restart) order by name)
    from pg_settings where name in (
      'log_statement', 'log_connections', 'log_disconnections', 'log_duration',
      'log_min_duration_statement', 'log_min_duration_sample', 'log_temp_files',
      'log_min_messages', 'log_min_error_statement', 'log_lock_waits', 'deadlock_timeout',
      'log_autovacuum_min_duration', 'auto_explain.log_min_duration', 'pgaudit.log', 'pgaudit.role'
    )
  ),
  'logging_overrides', (
    select coalesce(jsonb_agg(jsonb_build_object('role', coalesce(r.rolname, 'ALL'),
      'database', coalesce(d.datname, 'ALL'), 'setting', item)), '[]'::jsonb)
    from pg_db_role_setting s
    left join pg_roles r on r.oid = s.setrole
    left join pg_database d on d.oid = s.setdatabase
    cross join lateral unnest(s.setconfig) as entries(item)
    where split_part(item, '=', 1) in ('log_statement', 'log_duration', 'log_min_duration_statement',
      'log_min_messages', 'pgaudit.log', 'pgaudit.role', 'auto_explain.log_min_duration')
  ),
  'public_functions_with_routine_logging', (
    select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc ~* '\mraise\s+(debug|notice|info|log|warning)\M'
  )
) as logging_configuration;
rollback;
