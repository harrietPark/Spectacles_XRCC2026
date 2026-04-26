-- Add columns required by the GLB conversion pipeline.
--
-- Flow:
--   1. Web app inserts a row with the IKEA (or any other) source URL in
--      `original_model_3d_url` and `status = 'pending_conversion'`. It leaves
--      `model_3d_url` NULL.
--   2. Web app invokes the `convert-glb` Edge Function with `{ request_id }`.
--   3. Function downloads the source GLB, decompresses Draco if needed,
--      uploads the result to the `glb-cache` bucket, then sets
--      `model_3d_url` to the public URL and flips `status` to `pending`.
--   4. The Spectacles `SnapCloudARSpawnManager` script, which polls
--      `status = 'pending'`, picks the row up exactly as it does today and
--      transitions it through `processing` -> `spawned` / `failed`.

alter table public.ar_spawn_requests
    add column if not exists original_model_3d_url text,
    add column if not exists conversion_error      text;

-- model_3d_url is now filled in by the converter, so allow it to start NULL.
alter table public.ar_spawn_requests
    alter column model_3d_url drop not null;

-- Optional but recommended: lock down the set of valid `status` values so a
-- typo can't silently break the polling pipeline.
alter table public.ar_spawn_requests
    drop constraint if exists ar_spawn_requests_status_check;
alter table public.ar_spawn_requests
    add constraint ar_spawn_requests_status_check
    check (status in (
        'pending_conversion',
        'converting',
        'pending',
        'processing',
        'spawned',
        'failed'
    ));

-- Storage bucket the Edge Function writes converted GLBs into.
-- Public so the Spectacles script can fetch the file directly without auth.
insert into storage.buckets (id, name, public)
values ('glb-cache', 'glb-cache', true)
on conflict (id) do update set public = excluded.public;

-- Anyone (including the Lens) can read converted GLBs.
drop policy if exists "Public read of glb-cache" on storage.objects;
create policy "Public read of glb-cache"
    on storage.objects for select
    using (bucket_id = 'glb-cache');

-- Only the Edge Function (service_role) can upload/overwrite cached GLBs.
drop policy if exists "Service role writes glb-cache" on storage.objects;
create policy "Service role writes glb-cache"
    on storage.objects for all
    to service_role
    using (bucket_id = 'glb-cache')
    with check (bucket_id = 'glb-cache');
