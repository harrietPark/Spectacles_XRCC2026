import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"

/**
 * Handles syncing cropped captures from the Lens front end to Snap Cloud.
 *
 * NOTE: This script no longer owns the Supabase client or sessionId. Those
 * are owned by `SnapCloudSessionManager` -- see that file. This script now
 * does ONE thing: take a cropped texture and write it to Supabase Storage
 * + optionally insert a row into the `crops` table. The inserted row
 * carries an `image_url` (public URL from the `specs-captures` bucket) so
 * a Snap Cloud DB webhook on crops INSERT can hand the URL to an edge
 * function. It still exposes the same `getInstance()` /
 * `uploadCroppedCapture()` API so existing callers (PictureBehavior etc.)
 * keep working unchanged.
 *
 * Two roles live on the same component, controlled by which inputs are wired:
 *
 *   Standalone role (put one on a scene-root SceneObject):
 *     - No inputs required beyond the defaults.
 *     - Registers the singleton so `SnapCloudCropManager.getInstance()` works.
 *     - Exposes `uploadCroppedCapture(texture, sessionId?, caption?, onDone?)`
 *       for external callers.
 *
 *   Bridge role (put one on the Scanner prefab alongside PictureBehavior):
 *     - Wire `captureRendMesh` and `loadingIndicator` to the SAME objects
 *       PictureBehavior uses.
 *     - Watches `loadingIndicator.enabled` for a false->true rising edge,
 *       grabs `captureRendMesh.mainPass.captureImage`, and uploads.
 */
@component
export class SnapCloudCropManager extends BaseScriptComponent {
  // --- Upload behavior inputs ---------------------------------------------
  @input @hint("Master switch for uploading cropped captures to Snap Cloud storage")
  saveToCloud: boolean = true

  @input @hint("Supabase storage bucket name. Must match the bucket configured in the Snap Cloud dashboard.")
  storageBucket: string = "specs-captures"

  @input @hint("Folder prefix within the bucket. Final path: prefix/sessionId/slug_timestamp.jpg")
  cloudFolderPrefix: string = "captures"

  @input @hint("Also insert a row into the captures table for each upload")
  syncCapturesTable: boolean = true

  @input @hint("Table name used when syncCapturesTable is true")
  capturesTableName: string = "crops"

  // --- Bridge role inputs --------------------------------------------------

  @input @hint("Bridge: RenderMeshVisual whose mainPass.captureImage holds the cropped texture.")
  @allowUndefined
  captureRendMesh: RenderMeshVisual | undefined

  @input @hint("Bridge: SceneObject whose enabled state goes true when a capture is ready.")
  @allowUndefined
  loadingIndicator: SceneObject | undefined

  @input @hint("Bridge: optional caption/title to attach to uploads from this bridge.")
  bridgeCaption: string = "capture"

  @input @hint("Bridge: disable the loadingIndicator automatically when upload finishes (success or fail).")
  autoHideLoading: boolean = true

  // --- Singleton state ------------------------------------------------------
  private static instanceRef: SnapCloudCropManager | null = null

  // --- Bridge state --------------------------------------------------------
  private prevLoadingEnabled: boolean = false
  private uploadInFlight: boolean = false

  static getInstance(): SnapCloudCropManager | null {
    return SnapCloudCropManager.instanceRef
  }

  onAwake() {
    if (!SnapCloudCropManager.instanceRef) {
      SnapCloudCropManager.instanceRef = this
      print("[SnapCloudCrop] Singleton registered.")
    }

    if (this.captureRendMesh && this.loadingIndicator) {
      this.prevLoadingEnabled = this.loadingIndicator.enabled
      const updateEvent = this.createEvent("UpdateEvent")
      updateEvent.bind(this.onBridgeUpdate.bind(this))
      print("[SnapCloudCrop] Bridge armed; watching loadingIndicator for capture-ready.")
    }
  }

  onDestroy() {
    if (SnapCloudCropManager.instanceRef === this) {
      SnapCloudCropManager.instanceRef = null
    }
  }

  // ---------------------------------------------------------------- client

  /**
   * Delegate to SnapCloudSessionManager. Kept as a public method so older
   * callers that used to read the client from this script still work.
   */
  getClient(): SupabaseClient | null {
    const sm = SnapCloudSessionManager.getInstance()
    return sm ? sm.getClient() : null
  }

  getSessionId(): string {
    const sm = SnapCloudSessionManager.getInstance()
    return sm ? sm.getSessionId() : ""
  }

  // ---------------------------------------------------------------- public API

  /**
   * Upload a cropped capture to the configured Snap Cloud bucket. `onDone`
   * fires once the upload finishes (success or failure) so callers can e.g.
   * hide a loading spinner.
   */
  uploadCroppedCapture(texture: Texture, sessionId?: string, caption?: string, onDone?: () => void): void {
    const activeSessionId = sessionId || this.getSessionId()
    this.performUpload(texture, activeSessionId, caption || "capture", onDone)
  }

  // ------------------------------------------------------------------ bridge

  private onBridgeUpdate(): void {
    if (!this.loadingIndicator) {
      return
    }
    const now = this.loadingIndicator.enabled
    if (now && !this.prevLoadingEnabled && !this.uploadInFlight) {
      this.triggerBridgeUpload()
    }
    this.prevLoadingEnabled = now
  }

  private triggerBridgeUpload(): void {
    if (!this.captureRendMesh || !this.loadingIndicator) {
      return
    }
    const texture = this.captureRendMesh.mainPass.captureImage as Texture | undefined
    if (!texture) {
      print("[SnapCloudCrop] Bridge: captureImage not ready yet; skipping this trigger.")
      if (this.autoHideLoading) {
        this.loadingIndicator.enabled = false
      }
      return
    }

    this.uploadInFlight = true
    this.performUpload(texture, this.getSessionId(), this.bridgeCaption, () => {
      this.uploadInFlight = false
      if (this.autoHideLoading && this.loadingIndicator) {
        this.loadingIndicator.enabled = false
      }
    })
  }

  // ------------------------------------------------------------------ upload

  private performUpload(texture: Texture, sessionId: string, caption: string, onDone?: () => void): void {
    if (!this.saveToCloud) {
      print("[SnapCloudCrop] Disabled (saveToCloud=false).")
      if (onDone) onDone()
      return
    }
    if (!texture) {
      print("[SnapCloudCrop] Skipped: texture is null.")
      if (onDone) onDone()
      return
    }
    if (!this.storageBucket) {
      print("[SnapCloudCrop] Skipped: storageBucket is empty.")
      if (onDone) onDone()
      return
    }
    if (!sessionId) {
      print("[SnapCloudCrop] Skipped: no sessionId (SnapCloudSessionManager not ready?).")
      if (onDone) onDone()
      return
    }
    const client = this.getClient()
    if (!client) {
      print("[SnapCloudCrop] Skipped: Supabase client unavailable (SnapCloudSessionManager not ready?).")
      if (onDone) onDone()
      return
    }

    print("[SnapCloudCrop] Starting upload...")

    Base64.encodeTextureAsync(
      texture,
      async (base64String: string) => {
        try {
          const timestamp = Date.now()
          const imagePath = this.buildCloudPath(sessionId, timestamp, "jpg", caption)
          const imageBytes = this.base64ToBytes(base64String)

          await this.uploadBytes(client, imagePath, imageBytes, "image/jpeg")

          // NEW: resolve the public URL for the freshly-uploaded object so the
          // captures row carries a ready-to-fetch link. The `specs-captures`
          // bucket is public, so this is a pure string build (no network call).
          // A DB webhook on captures INSERT consumes `image_url` downstream.
          const imageUrl = this.resolveImageUrl(client, imagePath)

          if (this.syncCapturesTable) {
            await this.insertCaptureRecord(client, sessionId, imagePath, imageUrl, caption)
          }

          print(`[SnapCloudCrop] Success. imagePath=${imagePath} imageUrl=${imageUrl}`)
        } catch (e) {
          print("[SnapCloudCrop] Failed: " + e)
        } finally {
          if (onDone) onDone()
        }
      },
      () => {
        print("[SnapCloudCrop] Failed: texture encode failed.")
        if (onDone) onDone()
      },
      CompressionQuality.HighQuality,
      EncodingType.Jpg
    )
  }

  private async uploadBytes(
    client: SupabaseClient,
    path: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<void> {
    print(`[SnapCloudCrop] Uploading ${contentType} -> ${path}`)
    const {error} = await client.storage.from(this.storageBucket).upload(path, bytes, {
      contentType: contentType,
      upsert: true
    })
    if (error) {
      throw new Error(`Storage upload failed: ${JSON.stringify(error)}`)
    }
  }

  private async insertCaptureRecord(
    client: SupabaseClient,
    sessionId: string,
    imagePath: string,
    imageUrl: string,
    caption: string
  ): Promise<void> {
    if (!this.capturesTableName) {
      print("[SnapCloudCrop] Missing captures table name.")
      return
    }

    // NEW: `image_url` column — public URL to the object in `specs-captures`.
    // An INSERT webhook on the `crops` table forwards the row (including
    // image_url) to a Snap Cloud edge function.
    const row = {
      id: this.generateUuidV4(),
      session_id: sessionId,
      file_path: imagePath,
      image_url: imageUrl,
      title: caption,
      created_at: new Date().toISOString()
    }

    const {error} = await client.from(this.capturesTableName).insert([row])

    if (error) {
      throw new Error(`Capture insert failed: ${JSON.stringify(error)}`)
    }
    print(`[SnapCloudCrop] Capture row inserted. id=${row.id}`)
  }

  // NEW: resolve the public URL for a just-uploaded object. `specs-captures`
  // is a public bucket, so `getPublicUrl` is synchronous and cannot fail
  // over the network. We still guard the shape defensively and fall back to
  // an empty string so a URL hiccup never blocks the captures INSERT (the
  // row + file_path stay authoritative).
  private resolveImageUrl(client: SupabaseClient, imagePath: string): string {
    try {
      const result = client.storage.from(this.storageBucket).getPublicUrl(imagePath) as
        | {data?: {publicUrl?: string}}
        | undefined
      const url = result && result.data ? result.data.publicUrl : undefined
      if (!url) {
        print("[SnapCloudCrop] getPublicUrl returned empty; image_url will be blank.")
        return ""
      }
      return url
    } catch (e) {
      print("[SnapCloudCrop] getPublicUrl threw: " + e)
      return ""
    }
  }

  private buildCloudPath(sessionId: string, timestamp: number, extension: string, title: string): string {
    const prefix = this.cloudFolderPrefix ? this.cloudFolderPrefix.replace(/^\/+|\/+$/g, "") : ""
    const slug = this.slugifyTitle(title)
    const fileName = `${slug}_${timestamp}.${extension}`
    const sessionFilePath = `${sessionId}/${fileName}`
    return prefix.length > 0 ? `${prefix}/${sessionFilePath}` : sessionFilePath
  }

  private slugifyTitle(text: string): string {
    const fallback = "capture"
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

  private generateUuidV4(): string {
    const hex = (n: number) => Math.floor(Math.random() * n).toString(16)
    const s4 = () => {
      let out = ""
      for (let i = 0; i < 4; i++) {
        out += hex(16)
      }
      return out
    }
    const variant = (8 + Math.floor(Math.random() * 4)).toString(16) // 8,9,a,b
    return `${s4()}${s4()}-${s4()}-4${s4().slice(1)}-${variant}${s4().slice(1)}-${s4()}${s4()}${s4()}`
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
