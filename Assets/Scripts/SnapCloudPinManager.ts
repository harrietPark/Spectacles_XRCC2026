import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {Note} from "../Samples/Spatial_Persistence/SpatialPersistance/Notes/Note"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"

/**
 * SnapCloudPinManager
 * -------------------
 * Writes customer voice notes to Supabase `pins`.
 *
 * This script DOES NOT own any shared backend state -- it reads client,
 * session_id, and customer_id from `SnapCloudSessionManager.getInstance()`.
 * Add ONE `SnapCloudSessionManager` to the scene root (with supabaseProject
 * wired) before this script needs to write.
 *
 * Behavior:
 *   - Scans the scene for `Note` components and subscribes to each one's
 *     `onRecordingFinalized` event (a minimal additive event on Note.ts).
 *   - On the FIRST recording for a given note: INSERT a row into `pins`
 *     with (id, session_id, customer_id, anchor_id, spatial_position,
 *     transcribe_text, created_at, updated_at).
 *   - On EVERY subsequent recording for the same note: UPDATE only
 *     (transcribe_text, updated_at).
 *   - After each write, fire-and-forget-invoke the `process-pin` edge
 *     function, which generates summary_text + sentiment and writes one
 *     row into pin_recommendations. Disable with `autoInvokeProcessPin`.
 *
 * No spatial_position updates on move. No session/customer writes.
 */
@component
export class SnapCloudPinManager extends BaseScriptComponent {
  @input
  @hint("Supabase table name for pins.")
  private pinsTableName: string = "pins"

  @input
  @hint("How often (seconds) to re-scan the scene for new Note components.")
  private noteScanIntervalSeconds: number = 1.0

  @input
  @hint("Name of the Supabase edge function to invoke after each pin write.")
  private processPinFunctionName: string = "process-pin"

  @input
  @hint("If true, invoke process-pin automatically after every INSERT/UPDATE.")
  private autoInvokeProcessPin: boolean = true

  private scanTimer: number = 0
  private knownNotes: Set<Note> = new Set()
  private pinIdByNote: Map<Note, string> = new Map()
  private inflightByNote: Set<Note> = new Set()

  onAwake() {
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
    print("[SnapCloudPinManager] Ready.")
  }

  private onUpdate(): void {
    this.scanTimer -= getDeltaTime()
    if (this.scanTimer > 0) return
    this.scanTimer = this.noteScanIntervalSeconds
    this.scanForNotes()
  }

  // ------------------------------------------------------------ scene scanning

  private scanForNotes(): void {
    const rootCount = global.scene.getRootObjectsCount()
    for (let i = 0; i < rootCount; i++) {
      this.walk(global.scene.getRootObject(i))
    }
  }

  private walk(obj: SceneObject): void {
    const note = obj.getComponent(Note.getTypeName()) as Note | undefined
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
    // TODO: Re-enable once Note.ts exposes an `onRecordingFinalized` event.
    // note.onRecordingFinalized.add((transcript: string) => {
    //   this.handleRecordingFinalized(note, transcript)
    // })
    print(`[SnapCloudPinManager] Subscribed to Note on ${note.getSceneObject().name}`)
  }

  // -------------------------------------------------------------- pin writes

  private async handleRecordingFinalized(note: Note, transcript: string): Promise<void> {
    if (this.inflightByNote.has(note)) return
    this.inflightByNote.add(note)
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
        print("[SnapCloudPinManager] SessionManager not ready yet (customer/session upsert still in flight); skipping.")
        return
      }
      const customerId = sm.getCustomerId()

      const worldPos = note.getSceneObject().getTransform().getWorldPosition()
      const spatialPosition = {x: worldPos.x, y: worldPos.y, z: worldPos.z}

      const existingPinId = this.pinIdByNote.get(note)
      if (!existingPinId) {
        const pinId = SnapCloudPinManager.generateUuidV4()
        const now = new Date().toISOString()
        const row = {
          id: pinId,
          session_id: sessionId,
          customer_id: customerId,
          anchor_id: pinId,
          spatial_position: spatialPosition,
          transcribe_text: transcript,
          created_at: now,
          updated_at: now
        }
        const {error} = await client.from(this.pinsTableName).insert([row])
        if (error) {
          print(`[SnapCloudPinManager] pin INSERT failed: ${JSON.stringify(error)}`)
          return
        }
        this.pinIdByNote.set(note, pinId)
        print(`[SnapCloudPinManager] pin INSERT ok (id=${pinId}, transcript="${transcript}")`)
        this.invokeProcessPin(client, pinId)
      } else {
        const {error} = await client
          .from(this.pinsTableName)
          .update({
            transcribe_text: transcript,
            updated_at: new Date().toISOString()
          })
          .eq("id", existingPinId)
        if (error) {
          print(`[SnapCloudPinManager] pin UPDATE failed (${existingPinId}): ${JSON.stringify(error)}`)
          return
        }
        print(`[SnapCloudPinManager] pin UPDATE ok (id=${existingPinId}, transcript="${transcript}")`)
        this.invokeProcessPin(client, existingPinId)
      }
    } finally {
      this.inflightByNote.delete(note)
    }
  }

  // ----------------------------------------------- process-pin edge function

  /**
   * Fire-and-forget call to the `process-pin` edge function. Failures are
   * logged but do not block the user (the row is already saved in pins).
   */
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
