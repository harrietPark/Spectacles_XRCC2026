# Snap Cloud backend

This folder is a standard Supabase project, set up against the
`kcjjdcpcivyeohapnmeu` Snap Cloud project.

It contains:

- `migrations/` — schema changes for the `ar_spawn_requests` pipeline.
- `functions/convert-glb/` — Edge Function that converts Draco-compressed
  GLBs (such as IKEA dimma assets) into Lens Studio-compatible plain GLBs.
- `config.toml` — Supabase CLI config.

## One-time setup

```bash
brew install supabase/tap/supabase
supabase --profile snap login
supabase --profile snap link --project-ref kcjjdcpcivyeohapnmeu
```

## Apply schema migration

```bash
supabase --profile snap db push
```

This adds `original_model_3d_url` and `conversion_error` to
`ar_spawn_requests`, makes `model_3d_url` nullable, constrains the `status`
column to a known set of values, and provisions the public `glb-cache`
storage bucket together with read/write RLS policies.

## Deploy the Edge Function

```bash
supabase --profile snap functions deploy convert-glb
```

You can also deploy via the Snap Cloud dashboard
(<https://cloud.snap.com/> -> Edge Functions -> Deploy a new function ->
Via Editor) by pasting the contents of `functions/convert-glb/index.ts`.

The function reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`GLB_CACHE_BUCKET` from the environment. The first two are auto-injected by
the Supabase Edge Runtime; `GLB_CACHE_BUCKET` defaults to `glb-cache` and
only needs to be set if you want to use a different bucket name.

## Updated row lifecycle

| status                | who sets it          | meaning                                            |
| --------------------- | -------------------- | -------------------------------------------------- |
| `pending_conversion`  | web portal (insert)  | source URL provided; conversion not started        |
| `converting`          | `convert-glb`        | conversion in progress                             |
| `pending`             | `convert-glb`        | converted GLB ready for the Spectacles to spawn    |
| `processing`          | Spectacles script    | claimed by a Spectacles client; loading the GLB    |
| `spawned` / `failed`  | Spectacles script    | terminal states                                    |

The Spectacles `SnapCloudARSpawnManager.js` script keeps polling rows where
`status = 'pending'` and does not need any changes.

## Web portal: how to insert + invoke

```ts
const { data: row, error: insertErr } = await supabase
    .from("ar_spawn_requests")
    .insert({
        pin_id,
        product_id,
        original_model_3d_url: ikeaDracoUrl, // .../glb_draco/...glb
        status: "pending_conversion",
    })
    .select("id")
    .single();
if (insertErr) throw insertErr;

await supabase.functions.invoke("convert-glb", {
    body: { request_id: row.id },
});
```

The first call for a given source URL takes ~1–3s (download + Draco decode
+ upload). Repeat calls for the same URL are deduped via SHA-256 of the URL,
so they short-circuit and reuse the cached `glb-cache/<sha>.glb` object.

## Local development

```bash
supabase --profile snap functions serve convert-glb
```

You can poke the function locally with:

```bash
curl -X POST 'http://127.0.0.1:54321/functions/v1/convert-glb' \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    -H "Content-Type: application/json" \
    -d '{"request_id":"<uuid>"}'
```
