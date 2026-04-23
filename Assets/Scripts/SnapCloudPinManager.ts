import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {Note} from "../Samples/Spatial_Persistence/SpatialPersistance/Notes/Note"
import {INoteData} from "./INoteData"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"

/**
 * SnapCloudPinManager
 * -------------------
 * Writes completed voice notes to Supabase `pins` and triggers the
 * `process-pin` edge function (AI summary + product recommendation).
 *
 * Primary entry point:
 *   Scene-scanning — subscribes directly to each Note's `onNoteCompleted`
 *   event, bypassing NotesController. This is the most reliable path.
 *
 * Fallback entry point:
 *   SceneManager.sendCompleteNoteDataToBackend(noteData)
 *     → SnapCloudPinManager.getInstance()?.saveNoteToBackend(noteData)
 *   `inflightByNoteId` prevents double-writes if both paths fire.
 *
 * This script DOES NOT own shared backend state — it reads client,
 * session_id, and customer_id from `SnapCloudSessionManager.getInstance()`.
 * Add ONE `SnapCloudSessionManager` to the scene root with `supabaseProject`
 * wired before this script needs to write.
 *
 * Pin lifecycle:
 *   - Capture at note-spawn (SceneManager.sendProductViewToBackend) →
 *     pre-INSERT row with image_url only; pinId stashed for the next Note.
 *   - First onNoteCompleted for that Note → UPDATE (finalize) the row
 *     with transcribe_text + spatial_position, then invoke `process-pin`.
 *   - Subsequent onNoteCompleted for the same Note → UPDATE transcript
 *     only, then invoke `process-pin`.
 *   - Fallback path (no capture / pre-INSERT failed) → first call for a
 *     noteId still INSERTs a row (without image_url); afterwards behaves
 *     as above.
 *   - Roboflow detect-product is expected to hook an INSERT webhook on
 *     `pins` with `image_url IS NOT NULL`, so it fires exactly once per
 *     pin on the capture-time INSERT and is not re-triggered by later
 *     transcript UPDATEs.
 */
@component
export class SnapCloudPinManager extends BaseScriptComponent {
  @input
  @hint("Supabase table name for pins.")
  private pinsTableName: string = "pins"

  @input
  @hint("Name of the Supabase edge function to invoke after each pin write.")
  private processPinFunctionName: string = "process-pin"

  @input
  @hint("If true, invoke process-pin automatically after every INSERT/UPDATE.")
  private autoInvokeProcessPin: boolean = true

  @input
  @hint("How often (seconds) to re-scan the scene for new Note components.")
  private noteScanIntervalSeconds: number = 1.0

  // ======================================================================
  // [SnapCloudCapture] Added: quiet-capture inputs.
  // These mirror the ones on the old SnapCloudCaptureManager component so
  // the capture behaves identically. Leave them at defaults in normal use.
  // ======================================================================
  @input
  @hint("Master switch for uploading quiet captures to Snap Cloud storage.")
  private saveCaptureToCloud: boolean = true

  @input
  @hint("Supabase storage bucket name. Must match the bucket in Snap Cloud.")
  private captureStorageBucket: string = "specs-captures"

  @input
  @hint("Folder prefix within the bucket. Final path: prefix/sessionId/slug_timestamp.jpg")
  private captureCloudFolderPrefix: string = "captures"

  @input
  @hint("Filename slug for quiet captures. Final file: slug_<timestamp>.jpg")
  private captureFilenameSlug: string = "view"

  @input
  @hint("Seconds to wait after captureForNextNote() before grabbing the frame.")
  private captureDelaySeconds: number = 0.75

  @input
  @allowUndefined
  @hint("Optional camera Texture override. Leave empty; script owns its own camera subscription.")
  private cameraTextureOverride: Texture | undefined

  @input
  @hint("How long (seconds) a pending captured image_url stays claimable by the next discovered Note.")
  private pendingImageFreshnessSeconds: number = 10.0

  private static instanceRef: SnapCloudPinManager | null = null

  // noteId (note.createdAt.getUTCSeconds()) → Supabase pin UUID
  private pinIdByNoteId: Map<number, string> = new Map()
  // noteIds currently being written (prevents double-write on rapid re-record)
  private inflightByNoteId: Set<number> = new Set()

  private knownNotes: Set<Note> = new Set()
  private scanTimer: number = 0

  // ======================================================================
  // [SnapCloudCapture] Added: capture state.
  //   - camModule / liveCamTexture: self-owned camera subscription, same
  //     pattern as the old SnapCloudCaptureManager.
  //   - uploadInFlight: in-flight guard (one capture at a time).
  //   - pendingPinId: pinId of the most recent capture-time row that has
  //     not yet been claimed by a completed Note. Claimed lazily inside
  //     the onNoteCompleted closure (see attachToNote), NOT at scene-scan
  //     discovery time -- doing the claim on completion guarantees the
  //     pre-INSERT has already landed by then, which avoids a timing race
  //     where the scan spots the Note before the upload + pre-INSERT
  //     finishes. If the capture is never claimed (user cancels), the
  //     pending entry expires after pendingImageFreshnessSeconds and the
  //     DB row becomes an orphan with image_url but no transcript --
  //     acceptable by design.
  // ======================================================================
  private camModule: CameraModule = require("LensStudio:CameraModule") as CameraModule
  private liveCamTexture: Texture | null = null
  private uploadInFlight: boolean = false
  private pendingPinId: {pinId: string; imageUrl: string; timestamp: number} | null = null

  onAwake() {
    if (SnapCloudPinManager.instanceRef) {
      print("[SnapCloudPinManager] Another instance detected; this one stays idle.")
      return
    }
    SnapCloudPinManager.instanceRef = this
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
    // ====================================================================
    // [SnapCloudCapture] Added: defer camera request to OnStartEvent.
    // Calling requestCamera during onAwake is too early -- CameraModule
    // isn't fully initialized yet and returns a null/invalid Texture.
    // ====================================================================
    this.createEvent("OnStartEvent").bind(this.startCameraSubscription.bind(this))
    print("[SnapCloudPinManager] Ready.")
  }

  onDestroy() {
    if (SnapCloudPinManager.instanceRef === this) {
      SnapCloudPinManager.instanceRef = null
    }
    // ====================================================================
    // [SnapCloudCapture] Added: drop the live camera texture reference so
    // the CameraModule subscription can be garbage-collected on teardown.
    // ====================================================================
    this.liveCamTexture = null
  }

  static getInstance(): SnapCloudPinManager | null {
    return SnapCloudPinManager.instanceRef
  }

  // ---------------------------------------------------------- scene scanning

  private onUpdate(): void {
    this.scanTimer -= getDeltaTime()
    if (this.scanTimer > 0) return
    this.scanTimer = this.noteScanIntervalSeconds
    this.scanForNotes()
  }

  private scanForNotes(): void {
    const rootCount = global.scene.getRootObjectsCount()
    for (let i = 0; i < rootCount; i++) {
      this.walk(global.scene.getRootObject(i))
    }
  }

  private walk(obj: SceneObject): void {
    const note = obj.getComponent(Note.getTypeName()) as Note | null
    if (note && !this.knownNotes.has(note)) {
      this.attachToNote(note)
    }
    const childCount = obj.getChildrenCount()
    for (let i = 0; i < childCount; i++) {
      this.walk(obj.getChild(i))
    }
  }

  private attachToNote(note: Note): void {
    this.knownNotes.add(note)
    // ====================================================================
    // [SnapCloudCapture] Changed: the pending capture-time pinId is no
    // longer claimed here. The scene scan often spots the Note before
    // the capture-time upload + pre-INSERT has finished, so a claim at
    // attach time would race and miss. Instead the claim happens lazily
    // inside the onNoteCompleted closure below -- by the time the user
    // finishes recording, the pre-INSERT has definitely landed.
    // ====================================================================
    note.onNoteCompleted.add((noteData: INoteData) => {
      const worldPos = note.getSceneObject().getTransform().getWorldPosition()
      const spatialPosition = {x: worldPos.x, y: worldPos.y, z: worldPos.z}
      // ================================================================
      // [SnapCloudCapture] Changed: claim the pending capture-time
      // pinId here (at completion), not at scene-scan time. On re-
      // recording, pendingPinId is already null (consumed the first
      // time) and `pinIdByNoteId` drives the UPDATE path in
      // saveNoteAsync. If the capture failed or nothing is pending,
      // claimPendingPinIdIfFresh returns undefined and saveNoteAsync
      // falls through to its original full-INSERT path.
      // ================================================================
      const preAllocatedPinId = this.claimPendingPinIdIfFresh(note)
      this.saveNoteAsync(noteData, spatialPosition, preAllocatedPinId)
    })
    print(`[SnapCloudPinManager] Subscribed to Note on "${note.getSceneObject().name}"`)
  }

  /**
   * Called by SceneManager (fallback path — no spatial position available).
   * Fire-and-forget wrapper — errors are logged but do not throw.
   */
  public saveNoteToBackend(noteData: INoteData): void {
    this.saveNoteAsync(noteData, undefined, undefined)
  }

  // -------------------------------------------------------------- pin writes

  private async saveNoteAsync(
    noteData: INoteData,
    spatialPosition: {x: number; y: number; z: number} | undefined,
    // ==================================================================
    // [SnapCloudCapture] Added: optional pre-allocated pinId handed in
    // by attachToNote's onNoteCompleted callback. When present, this
    // Note's row was already INSERTed at capture time with image_url,
    // and saveNoteAsync should UPDATE (finalize) it rather than
    // INSERTing. When absent (e.g. fallback saveNoteToBackend path, or
    // capture/pre-INSERT failed), saveNoteAsync INSERTs a fresh row as
    // it always did -- just without image_url.
    // ==================================================================
    preAllocatedPinId: string | undefined
  ): Promise<void> {
    const noteId = noteData.noteId
    const transcript = (noteData.voiceTranscription || "").trim()

    if (transcript === "") {
      print("[SnapCloudPinManager] Empty transcript; skipping pin write.")
      return
    }

    if (this.inflightByNoteId.has(noteId)) {
      print(`[SnapCloudPinManager] Write already in flight for noteId=${noteId}; skipping.`)
      return
    }
    this.inflightByNoteId.add(noteId)

    try {
      const sm = SnapCloudSessionManager.getInstance()
      if (!sm) {
        print("[SnapCloudPinManager] No SnapCloudSessionManager in scene; skipping.")
        return
      }
      const client = sm.getClient()
      if (!client) {
        print("[SnapCloudPinManager] SessionManager has no Supabase client; skipping.")
        return
      }
      const sessionId = sm.getSessionId()
      if (!sessionId) {
        print("[SnapCloudPinManager] SessionManager has no sessionId; skipping.")
        return
      }
      if (!sm.isReady()) {
        print("[SnapCloudPinManager] SessionManager not ready yet (bootstrap in flight); skipping.")
        return
      }
      const customerId = sm.getCustomerId()

      const existingPinId = this.pinIdByNoteId.get(noteId)

      if (existingPinId) {
        // Re-recording the same note → UPDATE transcript only
        const {error} = await client
          .from(this.pinsTableName)
          .update({transcribe_text: transcript, updated_at: new Date().toISOString()})
          .eq("id", existingPinId)
        if (error) {
          print(`[SnapCloudPinManager] pin UPDATE failed (${existingPinId}): ${JSON.stringify(error)}`)
          return
        }
        print(`[SnapCloudPinManager] pin UPDATE ok (id=${existingPinId}, noteId=${noteId})`)
        this.invokeProcessPin(client, existingPinId)
      }
      // ==================================================================
      // [SnapCloudCapture] Added: finalize-capture-row branch.
      // The capture-time row already exists (pre-INSERTed with image_url
      // in insertCapturePinRow). Finalize it here with the transcript
      // and spatial_position. This is the first time process-pin is
      // invoked for this pin -- the pre-INSERT deliberately skipped it
      // because the transcript wasn't available yet.
      // ==================================================================
      else if (preAllocatedPinId) {
        const updateRow: Record<string, unknown> = {
          transcribe_text: transcript,
          updated_at: new Date().toISOString()
        }
        if (spatialPosition) {
          updateRow["spatial_position"] = spatialPosition
        }
        const {error} = await client
          .from(this.pinsTableName)
          .update(updateRow)
          .eq("id", preAllocatedPinId)
        if (error) {
          print(
            `[SnapCloudPinManager] pin finalize-UPDATE failed (${preAllocatedPinId}): ${JSON.stringify(error)}`
          )
          return
        }
        this.pinIdByNoteId.set(noteId, preAllocatedPinId)
        print(
          `[SnapCloudPinManager] pin finalize-UPDATE ok (id=${preAllocatedPinId}, noteId=${noteId})`
        )
        this.invokeProcessPin(client, preAllocatedPinId)
      }
      // ==================================================================
      // [SnapCloudCapture] Changed: original INSERT-on-completion path
      // (unchanged in spirit; only reached now when no capture-time row
      // exists, e.g. capture was disabled or pre-INSERT failed). The
      // image_url column will be NULL for rows that take this path.
      // ==================================================================
      else {
        // First finalized recording for this note → INSERT (no capture)
        const pinId = SnapCloudPinManager.generateUuidV4()
        const now = new Date().toISOString()
        const row: Record<string, unknown> = {
          id: pinId,
          session_id: sessionId,
          customer_id: customerId,
          anchor_id: pinId,
          transcribe_text: transcript,
          created_at: now,
          updated_at: now
        }
        if (spatialPosition) {
          row["spatial_position"] = spatialPosition
        }
        const {error} = await client.from(this.pinsTableName).insert([row])
        if (error) {
          print(`[SnapCloudPinManager] pin INSERT failed: ${JSON.stringify(error)}`)
          return
        }
        this.pinIdByNoteId.set(noteId, pinId)
        print(`[SnapCloudPinManager] pin INSERT ok (id=${pinId}, noteId=${noteId})`)
        this.invokeProcessPin(client, pinId)
      }
    } finally {
      this.inflightByNoteId.delete(noteId)
    }
  }

  // ----------------------------------------------- process-pin edge function

  private invokeProcessPin(client: SupabaseClient, pinId: string): void {
    if (!this.autoInvokeProcessPin) return
    if (!this.processPinFunctionName) return

    const clientWithFns = client as unknown as {
      functions: {
        invoke: (
          name: string,
          opts: {body: Record<string, unknown>}
        ) => Promise<{data: unknown; error: unknown}>
      }
    }

    clientWithFns.functions
      .invoke(this.processPinFunctionName, {body: {pin_id: pinId}})
      .then((res) => {
        if (res.error) {
          print(`[SnapCloudPinManager] process-pin failed (${pinId}): ${JSON.stringify(res.error)}`)
          return
        }
        print(`[SnapCloudPinManager] process-pin ok (${pinId}): ${JSON.stringify(res.data)}`)
      })
  }

  // -------------------------------------------------------------- uuid util

  private static generateUuidV4(): string {
    const hex = (n: number) => Math.floor(Math.random() * n).toString(16)
    const s4 = () => {
      let out = ""
      for (let i = 0; i < 4; i++) out += hex(16)
      return out
    }
    const variant = (8 + Math.floor(Math.random() * 4)).toString(16)
    return `${s4()}${s4()}-${s4()}-4${s4().slice(1)}-${variant}${s4().slice(1)}-${s4()}${s4()}${s4()}`
  }

  // ========================================================================
  // [SnapCloudCapture] Added: quiet camera capture (merged from
  // SnapCloudCaptureManager).
  //
  // Public entry point: captureForNextNote()
  //   Called by SceneManager.sendProductViewToBackend() at note-spawn.
  //   Takes a delayed one-frame snapshot of the live camera Texture,
  //   encodes JPEG, uploads it to `specs-captures/captures/<sessionId>/`,
  //   and stashes the resulting public URL in `pendingImageUrl`. The
  //   eventual Note pickup in attachToNote() claims that URL and hands
  //   it off to the pins-row INSERT in saveNoteAsync().
  //
  // All methods below are strictly additive; they do not touch the
  // existing pin-write flow except via the two small banner-marked
  // additions above (attachToNote -> tryClaimPendingImageUrl; and
  // saveNoteAsync INSERT -> row["image_url"] = claimedImageUrl).
  // ========================================================================

  /**
   * Public API used by SceneManager at note-spawn time.
   * Fire-and-forget. Never throws.
   */
  public captureForNextNote(): void {
    if (!this.saveCaptureToCloud) {
      print("[SnapCloudPinManager][Capture] Disabled (saveCaptureToCloud=false).")
      return
    }
    if (!this.captureStorageBucket) {
      print("[SnapCloudPinManager][Capture] Skipped: captureStorageBucket is empty.")
      return
    }
    if (this.uploadInFlight) {
      print("[SnapCloudPinManager][Capture] Skipped: an upload is already in flight.")
      return
    }

    const sm = SnapCloudSessionManager.getInstance()
    const client = sm ? sm.getClient() : null
    const sessionId = sm ? sm.getSessionId() : ""
    if (!client) {
      print("[SnapCloudPinManager][Capture] Skipped: Supabase client unavailable.")
      return
    }
    if (!sessionId) {
      print("[SnapCloudPinManager][Capture] Skipped: no sessionId.")
      return
    }

    // Claim the in-flight guard IMMEDIATELY so rapid re-triggers don't
    // queue up multiple captures. The actual frame grab + upload runs
    // after `captureDelaySeconds` to let the user's hand clear the shot.
    this.uploadInFlight = true
    const delaySeconds = Math.max(0, this.captureDelaySeconds)
    if (delaySeconds > 0) {
      print(`[SnapCloudPinManager][Capture] Capture scheduled in ${delaySeconds}s.`)
    }

    const delayedEvent = this.createEvent("DelayedCallbackEvent")
    delayedEvent.bind(() => {
      this.performDelayedCapture(client, sessionId)
    })
    delayedEvent.reset(delaySeconds)
  }

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
        print("[SnapCloudPinManager][Capture] requestCamera returned null/undefined.")
        this.liveCamTexture = null
        return
      }
      try {
        const camTexControl = texture.control as CameraTextureProvider
        // Keep the frame pipe warm on device.
        camTexControl.onNewFrame.add(() => {})
      } catch (inner) {
        print("[SnapCloudPinManager][Capture] onNewFrame hookup failed (non-fatal): " + inner)
      }
      this.liveCamTexture = texture
      print(`[SnapCloudPinManager][Capture] Camera subscription started (isEditor=${isEditor}).`)
    } catch (e) {
      print("[SnapCloudPinManager][Capture] Failed to start camera subscription: " + e)
      this.liveCamTexture = null
    }
  }

  private performDelayedCapture(client: SupabaseClient, sessionId: string): void {
    // ====================================================================
    // [SnapCloudCapture] Changed: finish() now stashes a pinId (not a
    // URL). Upload success path INSERTs the capture-time `pins` row
    // (image_url only, no transcript yet) and stashes the resulting
    // pinId in `pendingPinId`, which the next discovered Note will
    // claim in attachToNote(). If the upload or the INSERT fails,
    // nothing is stashed and the Note will fall through to the normal
    // full-INSERT-on-completion path (see saveNoteAsync).
    // ====================================================================
    const finish = (pinId: string, imageUrl: string) => {
      this.uploadInFlight = false
      if (pinId) {
        this.pendingPinId = {pinId, imageUrl, timestamp: Date.now()}
        print(`[SnapCloudPinManager][Capture] Stashed pending pinId=${pinId} for next Note.`)
      }
    }

    if (!this.cameraTextureOverride && !this.liveCamTexture) {
      print("[SnapCloudPinManager][Capture] liveCamTexture not ready; lazy-subscribing.")
      this.startCameraSubscription()
    }
    const sourceTexture: Texture | null = this.cameraTextureOverride || this.liveCamTexture
    if (!sourceTexture) {
      print("[SnapCloudPinManager][Capture] Skipped: no camera source.")
      finish("", "")
      return
    }

    let frozenFrame: Texture
    try {
      frozenFrame = ProceduralTextureProvider.createFromTexture(sourceTexture)
    } catch (e) {
      print("[SnapCloudPinManager][Capture] Skipped: snapshot failed (camera not ready yet?). " + e)
      finish("", "")
      return
    }

    print("[SnapCloudPinManager][Capture] Starting quiet capture upload...")

    Base64.encodeTextureAsync(
      frozenFrame,
      async (base64String: string) => {
        try {
          const timestamp = Date.now()
          const imagePath = this.buildCapturePath(sessionId, timestamp, "jpg")
          const imageBytes = this.base64ToBytes(base64String)

          await this.uploadCaptureBytes(client, imagePath, imageBytes, "image/jpeg")

          const imageUrl = this.resolveCaptureImageUrl(client, imagePath)
          print(`[SnapCloudPinManager][Capture] Upload ok. imagePath=${imagePath} imageUrl=${imageUrl}`)

          // ============================================================
          // [SnapCloudCapture] Added: capture-time INSERT. Creates the
          // `pins` row right now with image_url (and session/customer/
          // anchor IDs). Transcript and spatial_position get filled in
          // later via UPDATE when the matching Note completes. This is
          // the write that triggers the Roboflow detect-product edge
          // function via the INSERT webhook.
          // ============================================================
          const pinId = await this.insertCapturePinRow(client, imageUrl)
          finish(pinId, imageUrl)
        } catch (e) {
          print("[SnapCloudPinManager][Capture] Failed: " + e)
          finish("", "")
        }
      },
      () => {
        print("[SnapCloudPinManager][Capture] Failed: texture encode failed.")
        finish("", "")
      },
      CompressionQuality.HighQuality,
      EncodingType.Jpg
    )
  }

  // ======================================================================
  // [SnapCloudCapture] Added: capture-time pin INSERT.
  // Inserts a `pins` row immediately after the JPEG upload succeeds, with
  // image_url populated but transcribe_text / spatial_position still
  // NULL. Returns the new pinId on success, or "" on any failure (in
  // which case the Note will fall through to the full-INSERT-on-
  // completion path and the image_url won't be attached -- acceptable,
  // since we'd rather have a pin with a transcript than no pin at all).
  // process-pin is intentionally NOT invoked here -- it's the transcript
  // summarizer, and the transcript doesn't exist yet. The Roboflow
  // detect-product edge function is expected to be wired to an INSERT
  // webhook on `pins` with image_url IS NOT NULL, so it fires naturally
  // off this row without any explicit invocation from the client.
  // ======================================================================
  private async insertCapturePinRow(client: SupabaseClient, imageUrl: string): Promise<string> {
    try {
      const sm = SnapCloudSessionManager.getInstance()
      if (!sm) {
        print("[SnapCloudPinManager][Capture] pre-INSERT skipped: no SessionManager.")
        return ""
      }
      const sessionId = sm.getSessionId()
      if (!sessionId) {
        print("[SnapCloudPinManager][Capture] pre-INSERT skipped: no sessionId.")
        return ""
      }
      if (!sm.isReady()) {
        print("[SnapCloudPinManager][Capture] pre-INSERT skipped: SessionManager not ready.")
        return ""
      }
      const customerId = sm.getCustomerId()

      const pinId = SnapCloudPinManager.generateUuidV4()
      const now = new Date().toISOString()
      const row: Record<string, unknown> = {
        id: pinId,
        session_id: sessionId,
        customer_id: customerId,
        anchor_id: pinId,
        image_url: imageUrl,
        created_at: now,
        updated_at: now
      }
      const {error} = await client.from(this.pinsTableName).insert([row])
      if (error) {
        print(`[SnapCloudPinManager][Capture] pre-INSERT failed: ${JSON.stringify(error)}`)
        return ""
      }
      print(`[SnapCloudPinManager][Capture] pre-INSERT ok (id=${pinId})`)
      return pinId
    } catch (e) {
      print(`[SnapCloudPinManager][Capture] pre-INSERT threw: ${e}`)
      return ""
    }
  }

  /**
   * If there's a fresh pending pinId from a recent capture-time INSERT,
   * return it (and consume the pending slot). Called from the
   * onNoteCompleted closure so the claim happens AFTER the pre-INSERT
   * has definitely landed. Stale entries (older than
   * `pendingImageFreshnessSeconds`) are dropped and the DB row is left
   * as an orphan with image_url only (acceptable by design).
   *
   * Since `uploadInFlight` prevents concurrent captures, there is at most
   * one pending pinId at any given time, so this "first completion
   * grabs whatever's pending" policy is unambiguous in practice.
   */
  private claimPendingPinIdIfFresh(note: Note): string | undefined {
    if (!this.pendingPinId) {
      return undefined
    }
    const ageSeconds = (Date.now() - this.pendingPinId.timestamp) / 1000
    if (ageSeconds > this.pendingImageFreshnessSeconds) {
      print(
        `[SnapCloudPinManager][Capture] Discarding stale pending pinId=${this.pendingPinId.pinId} (age=${ageSeconds.toFixed(1)}s).`
      )
      this.pendingPinId = null
      return undefined
    }
    const pinId = this.pendingPinId.pinId
    print(
      `[SnapCloudPinManager][Capture] Claimed pending pinId=${pinId} for "${note.getSceneObject().name}".`
    )
    this.pendingPinId = null
    return pinId
  }

  // ------------------------------------------------------------ upload helpers

  private async uploadCaptureBytes(
    client: SupabaseClient,
    path: string,
    bytes: Uint8Array,
    contentType: string
  ): Promise<void> {
    print(`[SnapCloudPinManager][Capture] Uploading ${contentType} -> ${path}`)
    const {error} = await client.storage.from(this.captureStorageBucket).upload(path, bytes, {
      contentType: contentType,
      upsert: true
    })
    if (error) {
      throw new Error(`Storage upload failed: ${JSON.stringify(error)}`)
    }
  }

  private resolveCaptureImageUrl(client: SupabaseClient, imagePath: string): string {
    try {
      const result = client.storage.from(this.captureStorageBucket).getPublicUrl(imagePath) as
        | {data?: {publicUrl?: string}}
        | undefined
      const url = result && result.data ? result.data.publicUrl : undefined
      if (!url) {
        print("[SnapCloudPinManager][Capture] getPublicUrl returned empty.")
        return ""
      }
      return url
    } catch (e) {
      print("[SnapCloudPinManager][Capture] getPublicUrl threw: " + e)
      return ""
    }
  }

  private buildCapturePath(sessionId: string, timestamp: number, extension: string): string {
    const prefix = this.captureCloudFolderPrefix
      ? this.captureCloudFolderPrefix.replace(/^\/+|\/+$/g, "")
      : ""
    const slug = this.safeCaptureSlug(this.captureFilenameSlug)
    const fileName = `${slug}_${timestamp}.${extension}`
    const sessionFilePath = `${sessionId}/${fileName}`
    return prefix.length > 0 ? `${prefix}/${sessionFilePath}` : sessionFilePath
  }

  private safeCaptureSlug(text: string): string {
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
  // ========================================================================
  // [SnapCloudCapture] End of merged quiet-capture block.
  // ========================================================================
}
