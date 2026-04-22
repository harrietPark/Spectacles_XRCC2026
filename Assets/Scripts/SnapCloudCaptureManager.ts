import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"

/**
 * SnapCloudCaptureManager
 * -----------------------
 * Quiet, single-frame camera capture uploader.
 *
 * Triggered by `SceneManager.sendProductViewToBackend()` at note-spawn time
 * (finger dwell). Takes the current frame of a wired camera Texture, encodes
 * it as JPEG, and uploads it to the `specs-captures` bucket under the
 * `captures/<session_id>/` folder. Intentionally does NOT write to any
 * database table -- the `pins` table integration is a future additive step
 * owned by `SnapCloudPinManager`. Intentionally does NOT touch ChatGPT; the
 * crop-path caption flow lives in `snap_cloud_crop_manager.ts` and stays
 * there.
 *
 * Scene wiring:
 *   - Attach ONE component to a scene-root SceneObject (the same object
 *     that hosts `SnapCloudSessionManager` is fine).
 *   - NO inspector wiring required for a camera source. This script owns
 *     its own `CameraModule.requestCamera(...)` subscription and takes a
 *     one-frame snapshot via `ProceduralTextureProvider.createFromTexture`
 *     whenever `captureAndUpload` is called. The optional
 *     `cameraTextureOverride` input is a debug/override hook -- leave it
 *     unassigned in normal use.
 *   - `SnapCloudSessionManager` must exist in the scene with its
 *     supabaseProject wired; this manager pulls the client + sessionId
 *     from there.
 *
 * Public API:
 *   SnapCloudCaptureManager.getInstance()?.captureAndUpload((url) => { ... })
 *
 * The callback receives the public image URL on success, or an empty
 * string on any failure. Failures are logged but never thrown -- this is a
 * fire-and-forget background write and the user flow must never block.
 */
@component
export class SnapCloudCaptureManager extends BaseScriptComponent {
  // --- Capture source input -----------------------------------------------
  // ======================================================================
  // [SnapCloudCapture] Changed: the capture source is now self-owned via
  // `CameraModule.requestCamera(...)` below. This input is an OPTIONAL
  // override for debugging -- leave it unassigned in normal use and the
  // script will use its own camera subscription.
  // ======================================================================
  @input
  @allowUndefined
  @hint("Optional override Texture. Leave empty; script owns its own camera subscription.")
  cameraTextureOverride: Texture | undefined

  // --- Upload behavior inputs ---------------------------------------------
  @input
  @hint("Master switch for uploading quiet captures to Snap Cloud storage.")
  saveToCloud: boolean = true

  @input
  @hint("Supabase storage bucket name. Must match the bucket configured in Snap Cloud.")
  storageBucket: string = "specs-captures"

  @input
  @hint("Folder prefix within the bucket. Final path: prefix/sessionId/slug_timestamp.jpg")
  cloudFolderPrefix: string = "captures"

  @input
  @hint("Filename slug used for quiet captures. Final file: slug_<timestamp>.jpg")
  filenameSlug: string = "view"

  // ======================================================================
  // [SnapCloudCapture] Added: delay between captureAndUpload() trigger and
  // the actual frame grab. Gives the user's hand time to move out of the
  // shot after a note spawn. 0 = no delay (original behavior).
  // ======================================================================
  @input
  @hint("Seconds to wait after captureAndUpload() before grabbing the frame. Lets the user's hand clear the shot.")
  captureDelaySeconds: number = 0.75

  // --- Singleton state ----------------------------------------------------
  private static instanceRef: SnapCloudCaptureManager | null = null

  // --- In-flight guard ----------------------------------------------------
  // Prevents overlapping captures (e.g. if the user dwells again while the
  // previous upload is still encoding/uploading). Second call logs and no-ops.
  private uploadInFlight: boolean = false

  // ======================================================================
  // [SnapCloudCapture] Added: self-owned camera subscription.
  // Mirrors the pattern in `Assets/Samples/Crop/Scripts/CameraService.ts`:
  //   - Editor -> Default_Color, 352px smaller dim.
  //   - Device -> Right_Color, 756px smaller dim.
  // We keep the live `camTexture` reference so the CameraModule frame pipe
  // stays warm; on capture we snapshot it with `ProceduralTextureProvider`
  // before encoding so `Base64.encodeTextureAsync` gets a stable, readable
  // Texture instead of a streaming resource (previous crash cause).
  // ======================================================================
  private camModule: CameraModule = require("LensStudio:CameraModule") as CameraModule
  private liveCamTexture: Texture | null = null

  static getInstance(): SnapCloudCaptureManager | null {
    return SnapCloudCaptureManager.instanceRef
  }

  onAwake() {
    if (SnapCloudCaptureManager.instanceRef) {
      print("[SnapCloudCapture] Another instance already registered; this one stays idle.")
      return
    }
    SnapCloudCaptureManager.instanceRef = this
    print("[SnapCloudCapture] Singleton registered.")

    // ====================================================================
    // [SnapCloudCapture] Changed: defer camera request to OnStartEvent to
    // match the pattern in `Assets/Samples/Crop/Scripts/CameraService.ts`.
    // Calling `requestCamera` during onAwake is too early -- the
    // CameraModule isn't fully initialized yet and the call returns a
    // null/invalid Texture silently, which is what produced the
    // "Skipped: no camera source" log previously.
    // ====================================================================
    this.createEvent("OnStartEvent").bind(this.startCameraSubscription.bind(this))
  }

  onDestroy() {
    if (SnapCloudCaptureManager.instanceRef === this) {
      SnapCloudCaptureManager.instanceRef = null
    }
    this.liveCamTexture = null
  }

  // ======================================================================
  // [SnapCloudCapture] Added: request a camera on OnStart so a frame is
  // always available when `captureAndUpload` is called. Subscribes an
  // empty `onNewFrame` handler (same as CameraService) to keep the frame
  // pipe warm on device. Failures are logged and swallowed -- callers
  // still get a graceful onDone("").
  // ======================================================================
  private startCameraSubscription(): void {
    if (this.liveCamTexture) {
      return
    }
    try {
      const isEditor = global.deviceInfoSystem.isEditor()
      const camId = isEditor ? CameraModule.CameraId.Default_Color : CameraModule.CameraId.Right_Color
      const request = CameraModule.createCameraRequest()
      request.cameraId = camId
      request.imageSmallerDimension = isEditor ? 352 : 756
      const texture = this.camModule.requestCamera(request)
      if (!texture) {
        print("[SnapCloudCapture] requestCamera returned null/undefined.")
        this.liveCamTexture = null
        return
      }
      try {
        const camTexControl = texture.control as CameraTextureProvider
        camTexControl.onNewFrame.add(() => {})
      } catch (inner) {
        print("[SnapCloudCapture] onNewFrame hookup failed (non-fatal): " + inner)
      }
      this.liveCamTexture = texture
      print(`[SnapCloudCapture] Camera subscription started (isEditor=${isEditor}).`)
    } catch (e) {
      print("[SnapCloudCapture] Failed to start camera subscription: " + e)
      this.liveCamTexture = null
    }
  }

  // ---------------------------------------------------------------- public API

  /**
   * Grab the current frame from `cameraTexture`, upload it as JPEG to
   * `specs-captures/<cloudFolderPrefix>/<sessionId>/<slug>_<ts>.jpg`, and
   * return the public URL via `onDone`. On any failure, `onDone` is still
   * invoked, with an empty string.
   */
  captureAndUpload(onDone?: (url: string) => void): void {
    if (!this.saveToCloud) {
      print("[SnapCloudCapture] Disabled (saveToCloud=false).")
      if (onDone) onDone("")
      return
    }
    if (!this.storageBucket) {
      print("[SnapCloudCapture] Skipped: storageBucket is empty.")
      if (onDone) onDone("")
      return
    }
    if (this.uploadInFlight) {
      print("[SnapCloudCapture] Skipped: an upload is already in flight.")
      if (onDone) onDone("")
      return
    }

    const sm = SnapCloudSessionManager.getInstance()
    const client = sm ? sm.getClient() : null
    const sessionId = sm ? sm.getSessionId() : ""
    if (!client) {
      print("[SnapCloudCapture] Skipped: Supabase client unavailable (SnapCloudSessionManager not ready?).")
      if (onDone) onDone("")
      return
    }
    if (!sessionId) {
      print("[SnapCloudCapture] Skipped: no sessionId (SnapCloudSessionManager not ready?).")
      if (onDone) onDone("")
      return
    }

    // ====================================================================
    // [SnapCloudCapture] Added: delayed capture.
    // Claim the in-flight guard IMMEDIATELY so rapid re-triggers (e.g. the
    // user dwells again within the delay window) don't queue up multiple
    // captures. The actual frame grab + encode + upload runs after
    // `captureDelaySeconds` via `DelayedCallbackEvent`, giving the user's
    // hand time to leave the shot. `captureDelaySeconds = 0` behaves like
    // the original immediate-capture path (still one tick delayed by the
    // event system, which is fine).
    // ====================================================================
    this.uploadInFlight = true
    const delaySeconds = Math.max(0, this.captureDelaySeconds)
    if (delaySeconds > 0) {
      print(`[SnapCloudCapture] Capture scheduled in ${delaySeconds}s (waiting for hand to clear shot).`)
    }

    const delayedEvent = this.createEvent("DelayedCallbackEvent")
    delayedEvent.bind(() => {
      this.performDelayedCapture(client, sessionId, onDone)
    })
    delayedEvent.reset(delaySeconds)
  }

  // ======================================================================
  // [SnapCloudCapture] Added: post-delay body of captureAndUpload.
  // Resolves the camera source, snapshots a stable Texture via
  // `ProceduralTextureProvider.createFromTexture`, encodes JPEG, and
  // uploads to Storage. Always clears `uploadInFlight`, never throws.
  // ======================================================================
  private performDelayedCapture(
    client: SupabaseClient,
    sessionId: string,
    onDone?: (url: string) => void
  ): void {
    const finish = (url: string) => {
      this.uploadInFlight = false
      if (onDone) onDone(url)
    }

    if (!this.cameraTextureOverride && !this.liveCamTexture) {
      print("[SnapCloudCapture] liveCamTexture not ready; attempting lazy camera subscribe.")
      this.startCameraSubscription()
    }
    const sourceTexture: Texture | null = this.cameraTextureOverride || this.liveCamTexture
    if (!sourceTexture) {
      print("[SnapCloudCapture] Skipped: no camera source (requestCamera failed and no override wired).")
      finish("")
      return
    }

    let frozenFrame: Texture
    try {
      frozenFrame = ProceduralTextureProvider.createFromTexture(sourceTexture)
    } catch (e) {
      print("[SnapCloudCapture] Skipped: snapshot failed (camera frame not ready yet?). " + e)
      finish("")
      return
    }

    print("[SnapCloudCapture] Starting quiet capture upload...")

    Base64.encodeTextureAsync(
      frozenFrame,
      async (base64String: string) => {
        try {
          const timestamp = Date.now()
          const imagePath = this.buildCloudPath(sessionId, timestamp, "jpg")
          const imageBytes = this.base64ToBytes(base64String)

          await this.uploadBytes(client, imagePath, imageBytes, "image/jpeg")

          const imageUrl = this.resolveImageUrl(client, imagePath)
          print(`[SnapCloudCapture] Success. imagePath=${imagePath} imageUrl=${imageUrl}`)
          finish(imageUrl)
        } catch (e) {
          print("[SnapCloudCapture] Failed: " + e)
          finish("")
        }
      },
      () => {
        print("[SnapCloudCapture] Failed: texture encode failed.")
        finish("")
      },
      CompressionQuality.HighQuality,
      EncodingType.Jpg
    )
  }

  // ------------------------------------------------------------------ upload

  private async uploadBytes(
    client: SupabaseClient,
    path: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<void> {
    print(`[SnapCloudCapture] Uploading ${contentType} -> ${path}`)
    const {error} = await client.storage.from(this.storageBucket).upload(path, bytes, {
      contentType: contentType,
      upsert: true
    })
    if (error) {
      throw new Error(`Storage upload failed: ${JSON.stringify(error)}`)
    }
  }

  // Resolve the public URL for the just-uploaded object. `specs-captures`
  // is public, so this is a pure string build (no network call). We guard
  // defensively and fall back to "" so a URL hiccup never surfaces as an
  // error to the caller; the object itself is already safely in Storage.
  private resolveImageUrl(client: SupabaseClient, imagePath: string): string {
    try {
      const result = client.storage.from(this.storageBucket).getPublicUrl(imagePath) as
        | {data?: {publicUrl?: string}}
        | undefined
      const url = result && result.data ? result.data.publicUrl : undefined
      if (!url) {
        print("[SnapCloudCapture] getPublicUrl returned empty.")
        return ""
      }
      return url
    } catch (e) {
      print("[SnapCloudCapture] getPublicUrl threw: " + e)
      return ""
    }
  }

  // ----------------------------------------------------------------- helpers

  private buildCloudPath(sessionId: string, timestamp: number, extension: string): string {
    const prefix = this.cloudFolderPrefix ? this.cloudFolderPrefix.replace(/^\/+|\/+$/g, "") : ""
    const slug = this.safeSlug(this.filenameSlug)
    const fileName = `${slug}_${timestamp}.${extension}`
    const sessionFilePath = `${sessionId}/${fileName}`
    return prefix.length > 0 ? `${prefix}/${sessionFilePath}` : sessionFilePath
  }

  private safeSlug(text: string): string {
    const fallback = "view"
    if (!text) {
      return fallback
    }
    let slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    slug = slug.replace(/^-+|-+$/g, "")
    if (slug.length === 0) {
      return fallback
    }
    if (slug.length > 40) {
      slug = slug.slice(0, 40).replace(/-+$/g, "")
    }
    return slug.length > 0 ? slug : fallback
  }

  private base64ToBytes(base64: string): Uint8Array {
    const decoded = Base64.decode(base64) as unknown as Uint8Array | string
    if (decoded instanceof Uint8Array) {
      return decoded
    }

    const binary = decoded as string
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i) & 0xff
    }
    return bytes
  }
}
