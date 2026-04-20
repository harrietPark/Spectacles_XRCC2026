import {createClient, SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"

/**
 * Handles syncing cropped captures from the Lens front end to Snap Cloud (Supabase).
 *
 * Supports two roles on the same component, controlled by which inputs are wired:
 *
 *   Manager role (put one on a scene-root SceneObject):
 *     - Wire `supabaseProject`.
 *     - Creates the Supabase client, registers the singleton, owns the sessionId.
 *
 *   Bridge role (put one on the Scanner prefab alongside PictureBehavior):
 *     - Wire `captureRendMesh` and `loadingIndicator` to the SAME objects PictureBehavior uses.
 *     - Watches `loadingIndicator.enabled` for a false->true rising edge
 *       (the moment PictureBehavior.processImage enables the loading spinner),
 *       grabs `captureRendMesh.mainPass.captureImage`, uploads via the singleton,
 *       and turns the loading spinner back off when done.
 *
 * Both roles can coexist on the same component if all inputs are wired.
 */
@component
export class SnapCloudCropManager extends BaseScriptComponent {
  // --- Manager role inputs -------------------------------------------------
  @input @hint("PinPoint Snap Cloud project asset (url + publicToken). Required on the manager instance.")
  @allowUndefined
  supabaseProject: SupabaseProject | undefined

  @input @hint("Master switch for uploading cropped captures to Snap Cloud storage")
  saveToCloud: boolean = true

  @input @hint("Supabase storage bucket name. Must match the bucket configured in the Snap Cloud dashboard.")
  storageBucket: string = "specs-captures"

  @input @hint("Folder prefix within the bucket. Final path: prefix/sessionId/slug_timestamp.jpg")
  cloudFolderPrefix: string = "captures"

  @input @hint("Also insert a row into the captures table for each upload")
  syncCapturesTable: boolean = false

  @input @hint("Table name used when syncCapturesTable is true")
  capturesTableName: string = "captures"

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

  // --- Manager state -------------------------------------------------------
  private static instanceRef: SnapCloudCropManager | null = null
  private client: SupabaseClient | null = null
  private sessionId: string = ""

  // --- Bridge state --------------------------------------------------------
  private prevLoadingEnabled: boolean = false
  private uploadInFlight: boolean = false

  static getInstance(): SnapCloudCropManager | null {
    return SnapCloudCropManager.instanceRef
  }

  onAwake() {
    if (this.supabaseProject) {
      this.initClient()
      this.sessionId = `session_${Date.now()}`
      if (!SnapCloudCropManager.instanceRef) {
        SnapCloudCropManager.instanceRef = this
        print(`[SnapCloudCrop] Manager registered. sessionId=${this.sessionId}`)
      } else {
        print("[SnapCloudCrop] Another manager already registered; this instance will act only as a bridge if wired.")
      }
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
    if (this.client) {
      this.client.removeAllChannels()
      this.client = null
    }
  }

  private initClient(): void {
    if (!this.supabaseProject) {
      return
    }

    this.client = createClient(this.supabaseProject.url, this.supabaseProject.publicToken, {
      realtime: {
        heartbeatIntervalMs: 2500
      }
    })

    if (this.client) {
      print(`[SnapCloudCrop] Client ready. bucket=${this.storageBucket} prefix=${this.cloudFolderPrefix}`)
    } else {
      print("[SnapCloudCrop] Failed to create Supabase client.")
    }
  }

  getClient(): SupabaseClient | null {
    return this.client
  }

  getSessionId(): string {
    return this.sessionId
  }

  // ---------------------------------------------------------------- public API

  /**
   * Upload a cropped capture to the configured Snap Cloud bucket. If this
   * component is only a bridge, the call is forwarded to the singleton manager.
   * `onDone` fires once the upload finishes (success or failure) so callers can
   * e.g. hide a loading spinner.
   */
  uploadCroppedCapture(texture: Texture, sessionId?: string, caption?: string, onDone?: () => void): void {
    const manager = this.client ? this : SnapCloudCropManager.instanceRef
    if (!manager) {
      print("[SnapCloudCrop] Skipped: no manager with an initialized client.")
      if (onDone) onDone()
      return
    }
    manager.performUpload(texture, sessionId || manager.sessionId, caption || "capture", onDone)
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

    const manager = this.client ? this : SnapCloudCropManager.instanceRef
    if (!manager) {
      print("[SnapCloudCrop] Bridge: no manager available; nothing to upload.")
      if (this.autoHideLoading) {
        this.loadingIndicator.enabled = false
      }
      return
    }

    this.uploadInFlight = true
    manager.performUpload(texture, manager.sessionId, this.bridgeCaption, () => {
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
      print("[SnapCloudCrop] Skipped: missing sessionId.")
      if (onDone) onDone()
      return
    }
    if (!this.client) {
      print("[SnapCloudCrop] Skipped: Supabase client unavailable (is the manager instance wired?).")
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

          await this.uploadBytes(imagePath, imageBytes, "image/jpeg")

          if (this.syncCapturesTable) {
            await this.insertCaptureRecord(sessionId, imagePath, caption)
          }

          print(`[SnapCloudCrop] Success. imagePath=${imagePath}`)
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

  private async uploadBytes(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!this.client) {
      throw new Error("Supabase client unavailable.")
    }
    print(`[SnapCloudCrop] Uploading ${contentType} -> ${path}`)
    const {error} = await this.client.storage.from(this.storageBucket).upload(path, bytes, {
      contentType: contentType,
      upsert: true
    })
    if (error) {
      throw new Error(`Storage upload failed: ${JSON.stringify(error)}`)
    }
  }

  private async insertCaptureRecord(sessionId: string, imagePath: string, caption: string): Promise<void> {
    if (!this.client) {
      return
    }
    if (!this.capturesTableName) {
      print("[SnapCloudCrop] Missing captures table name.")
      return
    }

    const {error} = await this.client.from(this.capturesTableName).insert([
      {
        session_id: sessionId,
        file_path: imagePath,
        title: caption,
        created_at: new Date().toISOString()
      }
    ])

    if (error) {
      throw new Error(`Capture insert failed: ${JSON.stringify(error)}`)
    }
    print("[SnapCloudCrop] Capture row inserted.")
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
