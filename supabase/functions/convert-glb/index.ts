// convert-glb
//
// Edge Function that converts a remote GLB (typically Draco-compressed, e.g.
// IKEA's dimma `.../glb_draco/...glb` URLs) into a plain GLB that the Lens
// Studio / Spectacles GLTF runtime can load without crashing.
//
// Behaviour:
//   * Looks up the row in `ar_spawn_requests` by `request_id`.
//   * Reads `original_model_3d_url` (preferred) or falls back to the existing
//     `model_3d_url`.
//   * Computes a deterministic cache key from the source URL. If a converted
//     GLB already exists at `glb-cache/<sha256>.glb`, reuses it.
//   * Otherwise downloads the source, decodes Draco using gltf-transform +
//     draco3dgltf (WASM), strips `KHR_draco_mesh_compression` so the output
//     advertises no required extensions, and uploads the result.
//   * Updates the row with the converted public URL and flips `status` from
//     `pending_conversion` -> `pending`, which is what the Spectacles
//     `SnapCloudARSpawnManager.js` script polls for.
//
// Failure handling: any error sets `status = 'failed'` and writes the message
// into `conversion_error`.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { WebIO } from "@gltf-transform/core";
import { KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = Deno.env.get("GLB_CACHE_BUCKET") ?? "glb-cache";

// Hard caps to keep us inside the Edge Function memory/CPU envelope.
const MAX_INPUT_BYTES = 12 * 1024 * 1024; // 12 MB compressed input

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

let dracoDecoderPromise: Promise<unknown> | null = null;
function getDracoDecoder(): Promise<unknown> {
    // draco3dgltf creates a fresh WASM module per call; we cache it across
    // requests served by the same worker to avoid the ~150ms WASM compile.
    if (!dracoDecoderPromise) {
        dracoDecoderPromise = (
            draco3d as unknown as { createDecoderModule: () => Promise<unknown> }
        ).createDecoderModule();
    }
    return dracoDecoderPromise;
}

async function sha256Hex(input: string): Promise<string> {
    const buf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(input),
    );
    return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function decompressGlb(input: Uint8Array): Promise<Uint8Array> {
    const io = new WebIO()
        .registerExtensions([KHRDracoMeshCompression])
        .registerDependencies({
            "draco3d.decoder": await getDracoDecoder(),
        });

    const doc = await io.readBinary(input);

    // After read, all primitive attributes are decoded. Disposing the
    // extension removes it from `extensionsUsed` / `extensionsRequired` so
    // the output advertises no Draco dependency.
    doc.getRoot()
        .listExtensionsUsed()
        .filter((ext) => ext.extensionName === "KHR_draco_mesh_compression")
        .forEach((ext) => ext.dispose());

    return await io.writeBinary(doc);
}

function publicUrlFor(key: string): string {
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
    return data.publicUrl;
}

async function objectExists(key: string): Promise<boolean> {
    // `list()` with a `search` filter is the cheapest existence check the
    // storage REST API exposes.
    const { data, error } = await supabase.storage.from(BUCKET).list("", {
        limit: 1,
        search: key,
    });
    if (error) return false;
    return Boolean(data?.some((obj) => obj.name === key));
}

async function markFailed(requestId: string, message: string): Promise<void> {
    await supabase
        .from("ar_spawn_requests")
        .update({ status: "failed", conversion_error: message })
        .eq("id", requestId);
}

interface ConvertRequest {
    request_id?: string;
}

Deno.serve(async (req) => {
    let requestId: string | undefined;
    try {
        const body = (await req.json()) as ConvertRequest;
        requestId = body.request_id;
        if (!requestId) {
            return jsonResponse({ error: "request_id required" }, 400);
        }

        const { data: row, error: fetchErr } = await supabase
            .from("ar_spawn_requests")
            .select(
                "id, original_model_3d_url, model_3d_url, status, conversion_error",
            )
            .eq("id", requestId)
            .single();
        if (fetchErr || !row) {
            return jsonResponse(
                { error: fetchErr?.message ?? "row not found" },
                404,
            );
        }

        const sourceUrl = row.original_model_3d_url ?? row.model_3d_url;
        if (!sourceUrl) {
            await markFailed(requestId, "No source GLB URL on row.");
            return jsonResponse({ error: "no source URL" }, 400);
        }

        // Best-effort transition: only flip pending_conversion -> converting.
        await supabase
            .from("ar_spawn_requests")
            .update({ status: "converting", conversion_error: null })
            .eq("id", requestId)
            .in("status", ["pending_conversion", "failed"]);

        const cacheKey = `${await sha256Hex(sourceUrl)}.glb`;

        if (await objectExists(cacheKey)) {
            const url = publicUrlFor(cacheKey);
            await supabase
                .from("ar_spawn_requests")
                .update({
                    model_3d_url: url,
                    status: "pending",
                    conversion_error: null,
                })
                .eq("id", requestId);
            return jsonResponse({ ok: true, cached: true, url });
        }

        const sourceResp = await fetch(sourceUrl);
        if (!sourceResp.ok) {
            throw new Error(
                `source GLB returned HTTP ${sourceResp.status} ${sourceResp.statusText}`,
            );
        }

        const inBytes = new Uint8Array(await sourceResp.arrayBuffer());
        if (inBytes.byteLength > MAX_INPUT_BYTES) {
            throw new Error(
                `source GLB is ${inBytes.byteLength} bytes, exceeds limit of ${MAX_INPUT_BYTES}`,
            );
        }

        const outBytes = await decompressGlb(inBytes);

        const { error: uploadErr } = await supabase.storage
            .from(BUCKET)
            .upload(cacheKey, outBytes, {
                contentType: "model/gltf-binary",
                upsert: true,
                cacheControl: "31536000, immutable",
            });
        if (uploadErr) {
            throw new Error(`storage upload failed: ${uploadErr.message}`);
        }

        const url = publicUrlFor(cacheKey);
        await supabase
            .from("ar_spawn_requests")
            .update({
                model_3d_url: url,
                status: "pending",
                conversion_error: null,
            })
            .eq("id", requestId);

        return jsonResponse({
            ok: true,
            cached: false,
            url,
            input_bytes: inBytes.byteLength,
            output_bytes: outBytes.byteLength,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (requestId) await markFailed(requestId, message);
        return jsonResponse({ error: message }, 500);
    }
});

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
