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
 *   - First call for a noteId  → INSERT row into `pins`.
 *   - Subsequent calls for the same noteId → UPDATE (transcribe_text, updated_at).
 *   - After every write → fire-and-forget `process-pin` edge function.
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

  private static instanceRef: SnapCloudPinManager | null = null

  // noteId (note.createdAt.getUTCSeconds()) → Supabase pin UUID
  private pinIdByNoteId: Map<number, string> = new Map()
  // noteIds currently being written (prevents double-write on rapid re-record)
  private inflightByNoteId: Set<number> = new Set()

  private knownNotes: Set<Note> = new Set()
  private scanTimer: number = 0

  onAwake() {
    if (SnapCloudPinManager.instanceRef) {
      print("[SnapCloudPinManager] Another instance detected; this one stays idle.")
      return
    }
    SnapCloudPinManager.instanceRef = this
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
    print("[SnapCloudPinManager] Ready.")
  }

  onDestroy() {
    if (SnapCloudPinManager.instanceRef === this) {
      SnapCloudPinManager.instanceRef = null
    }
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
    note.onNoteCompleted.add((noteData: INoteData) => {
      const worldPos = note.getSceneObject().getTransform().getWorldPosition()
      const spatialPosition = {x: worldPos.x, y: worldPos.y, z: worldPos.z}
      this.saveNoteAsync(noteData, spatialPosition)
    })
    print(`[SnapCloudPinManager] Subscribed to Note on "${note.getSceneObject().name}"`)
  }

  /**
   * Called by SceneManager (fallback path — no spatial position available).
   * Fire-and-forget wrapper — errors are logged but do not throw.
   */
  public saveNoteToBackend(noteData: INoteData): void {
    this.saveNoteAsync(noteData, undefined)
  }

  // -------------------------------------------------------------- pin writes

  private async saveNoteAsync(
    noteData: INoteData,
    spatialPosition: {x: number; y: number; z: number} | undefined
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

      if (!existingPinId) {
        // First finalized recording for this note → INSERT
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
      } else {
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
}
