import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"

/**
 * SnapCloudARSpawnManager
 * -----------------------
 * Polls the Snap Cloud `ar_spawn_requests` table for rows with
 * `status = 'pending'` and instantiates the GLB at `model_3d_url` so it
 * floats in front of the user, locked to camera height.
 *
 * Backend pipeline (handled by the `convert-glb` Edge Function -- see
 * supabase/functions/convert-glb in the project README):
 *
 *   web portal INSERT  -> status='pending_conversion', original_model_3d_url=<IKEA Draco URL>
 *   convert-glb starts -> status='converting'
 *   convert-glb done   -> status='pending', model_3d_url=<storage public URL>
 *   THIS SCRIPT claims -> status='processing'
 *   GLB instantiated   -> status='spawned'
 *   any error          -> status='failed' (+ optional `conversion_error`)
 *
 * Other scripts (and you) only need to wire up:
 *   - One `SnapCloudSessionManager` somewhere in the scene root with the
 *     `supabaseProject` input set.
 *   - `cameraObject` on this script set to the scene's main Camera SceneObject.
 *
 * Lens Studio uses centimetres for world transforms; GLBs use metres. We
 * apply a manual 100x scale on the spawned root after instantiate so the
 * model renders at real-world size without relying on `GltfSettings`
 * (which has historically crashed the Spectacles GLTF loader on remote
 * GLBs in our project).
 */
@component
export class SnapCloudARSpawnManager extends BaseScriptComponent {
  @input
  @hint("Camera SceneObject the spawned model should follow.")
  @allowUndefined
  private cameraObject: SceneObject | undefined

  @input
  @hint("Centimetres in front of the camera (50 = 0.5 m).")
  private followDistance: number = 50.0

  @input
  @hint("Match the camera's current Y so the model rises/falls with the user.")
  private lockToCameraHeight: boolean = true

  @input
  @hint("Centimetres added to the locked height (e.g. -10 to sit 10 cm below eye level).")
  private fixedHeightOffset: number = 0.0

  @input
  @hint("Yaw the model so its forward axis points at the camera each frame.")
  private faceCamera: boolean = true

  @input
  @hint("Destroy the previously spawned model before loading a new one.")
  private replacePreviousSpawn: boolean = true

  @input
  @hint("Use async GLB instantiation. Leave off if Lens Studio crashes during instantiate progress.")
  private useAsyncInstantiate: boolean = false

  @input
  @hint("Use GltfSettings during instantiate. Leave off and let the script apply a manual 100x scale instead.")
  private useGltfSettings: boolean = false

  @input
  @hint("Download the GLB header and reject incompatible required extensions before instantiating. Defense-in-depth in case a non-converted URL leaks into the table.")
  private preflightGlb: boolean = true

  @input
  @hint("How often (seconds) to poll the table for pending requests.")
  private pollIntervalSeconds: number = 1.5

  @input
  @hint("Supabase table name for AR spawn requests.")
  private tableName: string = "ar_spawn_requests"

  @input
  @hint("Enable verbose per-step logs. Errors and final outcomes always log.")
  private debugLogs: boolean = true

  private static readonly TAG = "[SnapCloudARSpawnManager]"
  private static readonly SUPPORTED_EXTENSIONS: {[name: string]: boolean} = {
    KHR_materials_unlit: true,
    KHR_texture_transform: true,
    KHR_materials_pbrSpecularGlossiness: true,
    KHR_materials_emissive_strength: true,
    KHR_materials_ior: true,
    KHR_materials_specular: true,
    KHR_materials_clearcoat: true,
    KHR_materials_sheen: true,
    KHR_materials_transmission: true,
    KHR_materials_volume: true,
    KHR_materials_variants: true,
    KHR_lights_punctual: true,
    KHR_mesh_quantization: true
  }

  private internetModule: InternetModule = require("LensStudio:InternetModule") as InternetModule
  private remoteMediaModule: RemoteMediaModule = require("LensStudio:RemoteMediaModule") as RemoteMediaModule

  private isPolling: boolean = false
  private spawnInFlight: boolean = false
  private pollTimer: DelayedCallbackEvent | null = null
  private pollIntervalActive: number = 1.5
  private followedObjects: SceneObject[] = []

  // -------------------------------------------------------------- lifecycle

  onAwake() {
    this.pollIntervalActive = this.pollIntervalSeconds > 0 ? this.pollIntervalSeconds : 1.5

    this.createEvent("OnStartEvent").bind(this.startPolling.bind(this))
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
  }

  onDestroy() {
    this.followedObjects = []
    this.pollTimer = null
  }

  // ------------------------------------------------------------------ logs

  private log(message: string): void {
    print(`${SnapCloudARSpawnManager.TAG} ${message}`)
  }

  private debugLog(message: string): void {
    if (this.debugLogs) {
      print(`${SnapCloudARSpawnManager.TAG} ${message}`)
    }
  }

  private describeError(err: unknown): string {
    if (err === null || err === undefined) return "<null/undefined>"
    if (typeof err === "string") return err
    try {
      const anyErr = err as {message?: string; stack?: string}
      let msg = anyErr.message ? anyErr.message : `${err}`
      if (anyErr.stack) msg += `\n  stack: ${anyErr.stack}`
      return msg
    } catch (_) {
      return "<unstringifiable error>"
    }
  }

  // ---------------------------------------------------------- poll lifecycle

  private startPolling(): void {
    this.log(`Starting up (debugLogs=${this.debugLogs ? "on" : "off"}).`)
    this.debugLog(
      `cameraObject=${this.cameraObject ? this.cameraObject.name : "NOT SET"} ` +
        `| table=${this.tableName} | poll=${this.pollIntervalActive}s ` +
        `| followDistance=${this.followDistance}cm | replace=${this.replacePreviousSpawn} ` +
        `| async=${this.useAsyncInstantiate} | gltfSettings=${this.useGltfSettings} ` +
        `| preflight=${this.preflightGlb}`
    )

    if (!this.cameraObject) {
      this.log("cameraObject input not set; spawned models will not follow the user.")
    }

    this.pollTimer = this.createEvent("DelayedCallbackEvent")
    this.pollTimer.bind(() => {
      this.pollOnce()
      // Don't schedule the next tick while a spawn is in flight; the spawn
      // completion path re-arms the timer.
      if (!this.spawnInFlight && this.pollTimer) {
        this.pollTimer.reset(this.pollIntervalActive)
      }
    })

    this.pollOnce()
    this.pollTimer.reset(this.pollIntervalActive)
  }

  private pausePolling(): void {
    // Reset to a far-future timestamp; we'll rearm explicitly once the
    // current spawn finishes.
    if (this.pollTimer) this.pollTimer.reset(999999.0)
  }

  private resumePolling(): void {
    if (this.pollTimer) this.pollTimer.reset(this.pollIntervalActive)
  }

  // -------------------------------------------------------------- polling

  private async pollOnce(): Promise<void> {
    if (this.isPolling || this.spawnInFlight) return
    const sm = SnapCloudSessionManager.getInstance()
    if (!sm) return
    const client = sm.getClient()
    if (!client) return

    this.isPolling = true
    try {
      const {data, error} = await client
        .from(this.tableName)
        .select("id,pin_id,product_id,model_3d_url,status,created_at")
        .eq("status", "pending")
        .order("created_at", {ascending: true})
        .limit(1)

      if (error) {
        this.log(`Polling failed: ${JSON.stringify(error)}`)
        return
      }
      if (data && data.length > 0) {
        await this.processRequest(client, data[0])
      }
    } catch (e) {
      this.log(`Polling threw: ${this.describeError(e)}`)
    } finally {
      this.isPolling = false
    }
  }

  // ------------------------------------------------------------- pipeline

  private async processRequest(client: SupabaseClient, request: any): Promise<void> {
    if (!request || !request.id) return
    if (!request.model_3d_url) {
      this.log(`Request ${request.id} has no model_3d_url; marking failed.`)
      await this.setRequestStatus(client, request.id, "failed")
      return
    }
    if (this.spawnInFlight) return

    this.debugLog(
      `Claiming request ${request.id} (product_id=${request.product_id}, url=${request.model_3d_url})`
    )

    // Atomic claim: only flip pending -> processing if we win the race.
    // PostgREST returns the updated row when Prefer=return=representation
    // is set; supabase-js exposes that via .select().
    const {data: claimed, error: claimErr} = await client
      .from(this.tableName)
      .update({status: "processing"})
      .eq("id", request.id)
      .eq("status", "pending")
      .select("id")

    if (claimErr) {
      this.log(`Could not claim ${request.id}: ${JSON.stringify(claimErr)}`)
      return
    }
    if (!claimed || claimed.length === 0) {
      this.debugLog(`Claim lost for ${request.id} (already taken).`)
      return
    }

    this.debugLog(`Claim ok. Beginning spawn for ${request.id}`)
    this.spawnInFlight = true
    this.pausePolling()
    if (this.replacePreviousSpawn) this.destroyAllFollowedObjects()

    try {
      await this.spawnGltf(request.model_3d_url)
      this.spawnInFlight = false
      this.log(`Spawn SUCCESS for ${request.id}, marking row spawned.`)
      await this.setRequestStatus(client, request.id, "spawned")
    } catch (e) {
      this.spawnInFlight = false
      const reason = this.describeError(e)
      this.log(`Spawn FAILED for ${request.id}: ${reason}`)
      await this.setRequestStatus(client, request.id, "failed", reason)
    } finally {
      this.resumePolling()
    }
  }

  private async setRequestStatus(
    client: SupabaseClient,
    requestId: string,
    status: string,
    conversionError?: string
  ): Promise<void> {
    const update: Record<string, unknown> = {status}
    if (conversionError !== undefined) update["conversion_error"] = conversionError
    const {error} = await client.from(this.tableName).update(update).eq("id", requestId)
    if (error) {
      this.log(`Failed to set status=${status} on ${requestId}: ${JSON.stringify(error)}`)
    }
  }

  // ----------------------------------------------------------- GLB preflight

  private async preflightGlbUrl(modelUrl: string): Promise<{ok: true} | {ok: false; reason: string}> {
    this.debugLog("preflight: fetching GLB header for inspection")
    let resp: Response
    try {
      resp = await this.internetModule.fetch(modelUrl, {method: "GET"})
    } catch (e) {
      return {ok: false, reason: `Preflight fetch threw: ${this.describeError(e)}`}
    }
    if (!resp.ok) {
      return {ok: false, reason: `Preflight HTTP ${resp.status} from ${modelUrl}`}
    }

    let bytes: Uint8Array
    try {
      bytes = await resp.bytes()
    } catch (e) {
      return {ok: false, reason: `Preflight bytes() threw: ${this.describeError(e)}`}
    }

    if (bytes.length < 20) {
      return {ok: false, reason: `GLB too short (${bytes.length} bytes).`}
    }
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
    if (magic !== "glTF") {
      return {ok: false, reason: `File is not a GLB (magic='${magic}').`}
    }

    const jsonChunkLen =
      (bytes[12]) | (bytes[13] << 8) | (bytes[14] << 16) | (bytes[15] << 24)
    if (20 + jsonChunkLen > bytes.length) {
      return {ok: false, reason: `JSON chunk length ${jsonChunkLen} exceeds file size.`}
    }
    let jsonText = ""
    for (let i = 0; i < jsonChunkLen; i++) jsonText += String.fromCharCode(bytes[20 + i])

    let meta: any
    try {
      meta = JSON.parse(jsonText)
    } catch (e) {
      return {ok: false, reason: `Could not parse GLB JSON chunk: ${this.describeError(e)}`}
    }

    const required: string[] = meta.extensionsRequired || []
    for (let i = 0; i < required.length; i++) {
      if (!SnapCloudARSpawnManager.SUPPORTED_EXTENSIONS[required[i]]) {
        return {
          ok: false,
          reason:
            `GLB requires unsupported extension "${required[i]}". ` +
            `Lens Studio cannot instantiate this file. ` +
            `(extensionsRequired=${JSON.stringify(required)})`
        }
      }
    }
    return {ok: true}
  }

  // -------------------------------------------------------------- spawning

  private spawnGltf(modelUrl: string): Promise<SceneObject> {
    return new Promise<SceneObject>((resolve, reject) => {
      if (!this.internetModule) return reject("InternetModule unavailable.")
      if (!this.remoteMediaModule) return reject("RemoteMediaModule unavailable.")
      if (!modelUrl) return reject("modelUrl is empty.")

      const startNativeLoad = () => {
        this.debugLog(`spawnGltf: requesting resource for ${modelUrl}`)
        let resource: DynamicResource
        try {
          resource = this.internetModule.makeResourceFromUrl(modelUrl)
        } catch (e) {
          return reject(`makeResourceFromUrl threw: ${this.describeError(e)}`)
        }
        if (!resource) return reject(`makeResourceFromUrl returned null for: ${modelUrl}`)

        this.debugLog("spawnGltf: resource created, calling loadResourceAsGltfAsset")
        this.remoteMediaModule.loadResourceAsGltfAsset(
          resource,
          (gltfAsset) => {
            this.debugLog(`spawnGltf: GLB downloaded, gltfAsset=${gltfAsset ? "ok" : "null"}`)
            if (!gltfAsset) return reject("loadResourceAsGltfAsset returned null gltfAsset.")
            try {
              this.instantiateGltf(gltfAsset, resolve, reject)
            } catch (e) {
              reject(`instantiateGltf threw: ${this.describeError(e)}`)
            }
          },
          (errorMsg) => reject(`loadResourceAsGltfAsset failed: ${this.describeError(errorMsg)}`)
        )
      }

      if (this.preflightGlb) {
        this.preflightGlbUrl(modelUrl).then((verdict) => {
          if (!verdict.ok) return reject(verdict.reason)
          this.debugLog("preflight: GLB looks compatible; proceeding to native load")
          startNativeLoad()
        })
      } else {
        startNativeLoad()
      }
    })
  }

  private instantiateGltf(
    gltfAsset: GltfAsset,
    onSuccess: (s: SceneObject) => void,
    onError: (e: string) => void
  ): void {
    let gltfSettings: GltfSettings | null = null
    try {
      if (this.useGltfSettings && typeof GltfSettings !== "undefined" && (GltfSettings as any).create) {
        gltfSettings = (GltfSettings as any).create() as GltfSettings
        ;(gltfSettings as any).convertMetersToCentimeters = true
        this.debugLog("instantiate: GltfSettings.create() ok, convertMetersToCentimeters=true")
      } else if (!this.useGltfSettings) {
        this.debugLog("instantiate: useGltfSettings=false; using plain instantiate + manual 100x scale.")
      }
    } catch (e) {
      this.log(`instantiate: GltfSettings.create() threw: ${this.describeError(e)}`)
      gltfSettings = null
    }

    const parent = this.getSceneObject()
    this.debugLog(
      `instantiate: parent=${parent.name} (mode=${this.useAsyncInstantiate ? "async" : "sync"})`
    )

    const onSpawned = (spawned: SceneObject) => {
      if (!spawned) {
        onError("instantiate produced null SceneObject.")
        return
      }
      this.debugLog(
        `instantiate: spawned SceneObject "${spawned.name}" with ${spawned.getChildrenCount()} children`
      )
      if (!this.useGltfSettings) {
        spawned.getTransform().setLocalScale(new vec3(100, 100, 100))
        this.debugLog("instantiate: applied manual meters-to-centimetres root scale (100x)")
      }
      this.followedObjects.push(spawned)
      if (this.cameraObject) {
        this.updateFollowedObject(spawned, this.cameraObject.getTransform())
        const pos = spawned.getTransform().getWorldPosition()
        this.debugLog(
          `instantiate: positioned at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`
        )
      }
      onSuccess(spawned)
    }
    const onProgress = (progress: number) => this.debugLog(`instantiate: progress=${progress}`)

    try {
      if (this.useAsyncInstantiate && gltfSettings) {
        ;(gltfAsset as any).tryInstantiateAsync(parent, null, onSpawned, onError, onProgress, gltfSettings)
      } else if (this.useAsyncInstantiate) {
        ;(gltfAsset as any).tryInstantiateAsync(parent, null, onSpawned, onError, onProgress)
      } else if (gltfSettings) {
        const spawned = (gltfAsset as any).tryInstantiateWithSetting(parent, null, gltfSettings) as SceneObject
        onSpawned(spawned)
      } else {
        const spawned = gltfAsset.tryInstantiate(parent, null) as SceneObject
        onSpawned(spawned)
      }
    } catch (e) {
      onError(`instantiate threw: ${this.describeError(e)}`)
    }
  }

  // -------------------------------------------------------- camera follow

  private onUpdate(): void {
    if (this.followedObjects.length === 0) return
    const cam = this.cameraObject
    if (!cam) return
    const camTransform = cam.getTransform()

    for (let i = this.followedObjects.length - 1; i >= 0; i--) {
      const obj = this.followedObjects[i]
      let dead = !obj
      if (!dead && typeof (obj as any).isDestroyed === "function") {
        dead = (obj as any).isDestroyed()
      }
      if (dead) {
        this.followedObjects.splice(i, 1)
        continue
      }
      this.updateFollowedObject(obj, camTransform)
    }
  }

  private updateFollowedObject(obj: SceneObject, camTransform: Transform): void {
    const camPos = camTransform.getWorldPosition()
    const fwd = this.horizontalForward(camTransform)

    const targetX = camPos.x + fwd.x * this.followDistance
    const targetZ = camPos.z + fwd.z * this.followDistance
    const targetY = this.lockToCameraHeight
      ? camPos.y + this.fixedHeightOffset
      : obj.getTransform().getWorldPosition().y

    const transform = obj.getTransform()
    transform.setWorldPosition(new vec3(targetX, targetY, targetZ))

    if (this.faceCamera) {
      const toCamX = camPos.x - targetX
      const toCamZ = camPos.z - targetZ
      if (toCamX * toCamX + toCamZ * toCamZ > 1e-6) {
        const yaw = Math.atan2(toCamX, toCamZ)
        transform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
      }
    }
  }

  private horizontalForward(camTransform: Transform): vec3 {
    const fwd = camTransform.forward
    let horiz = new vec3(fwd.x, 0, fwd.z)
    const lenSq = horiz.x * horiz.x + horiz.z * horiz.z
    if (lenSq < 1e-6) {
      // Looking straight up or down; fall back to camera right rotated 90deg.
      const right = camTransform.right
      horiz = new vec3(-right.z, 0, right.x)
    }
    return horiz.normalize()
  }

  private destroyAllFollowedObjects(): void {
    for (let i = 0; i < this.followedObjects.length; i++) {
      const obj = this.followedObjects[i]
      if (!obj) continue
      let alive = true
      if (typeof (obj as any).isDestroyed === "function") alive = !(obj as any).isDestroyed()
      if (alive) {
        try {
          obj.destroy()
        } catch (e) {
          this.log(`Failed to destroy previous spawn: ${this.describeError(e)}`)
        }
      }
    }
    this.followedObjects = []
  }
}
