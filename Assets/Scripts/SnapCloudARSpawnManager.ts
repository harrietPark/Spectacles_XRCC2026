import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"

/**
 * SnapCloudARSpawnManager
 * -----------------------
 * Simplified AR spawn bridge.
 *
 * Web portal inserts a row in `ar_spawn_requests` with `status='pending'`.
 * This script claims that row, enables a pre-placed SceneObject in the Lens,
 * and places it once in front of the user's camera at camera height.
 */
@component
export class SnapCloudARSpawnManager extends BaseScriptComponent {
  @input
  @hint("Pre-placed 3D model root to show when a spawn request arrives.")
  @allowUndefined
  private targetModel: SceneObject | undefined

  @input
  @hint("Camera SceneObject used to place the target model in front of the user.")
  @allowUndefined
  private cameraObject: SceneObject | undefined

  @input
  @hint("Centimetres in front of the camera (50 = 0.5 m).")
  private spawnDistance: number = 50.0

  @input
  @hint("Centimetres added to camera height when placing the model.")
  private heightOffset: number = 0.0

  @input
  @hint("Rotate the model so it faces the camera.")
  private faceCamera: boolean = true

  @input
  @hint("Hide targetModel on start.")
  private hideOnStart: boolean = true

  @input
  @hint("If true, Lens Studio Preview will not claim web spawn requests. Leave on when testing on Spectacles.")
  private ignoreEditorPreview: boolean = true

  @input
  @hint("How often (seconds) to poll ar_spawn_requests.")
  private pollIntervalSeconds: number = 1.0

  @input
  @hint("Supabase table name for AR spawn requests.")
  private tableName: string = "ar_spawn_requests"

  @input
  @hint("Enable verbose logs.")
  private debugLogs: boolean = true

  private pollTimer: DelayedCallbackEvent | null = null
  private isPolling: boolean = false
  private pollingEnabled: boolean = true

  onAwake(): void {
    if (this.hideOnStart && this.targetModel) {
      this.targetModel.enabled = false
    }

    if (this.ignoreEditorPreview && global.deviceInfoSystem && global.deviceInfoSystem.isEditor()) {
      this.pollingEnabled = false
      this.log("Disabled in Lens Studio Preview so Spectacles can claim web spawn requests.")
      return
    }

    this.createEvent("OnStartEvent").bind(this.startPolling.bind(this))
  }

  private startPolling(): void {
    if (!this.pollingEnabled) return

    this.log(
      `Ready. targetModel=${this.targetModel ? this.targetModel.name : "NOT SET"}, ` +
        `camera=${this.cameraObject ? this.cameraObject.name : "NOT SET"}`
    )

    this.pollTimer = this.createEvent("DelayedCallbackEvent")
    this.pollTimer.bind(() => {
      this.pollOnce()
      if (this.pollTimer) {
        this.pollTimer.reset(Math.max(0.25, this.pollIntervalSeconds))
      }
    })

    this.pollOnce()
    this.pollTimer.reset(Math.max(0.25, this.pollIntervalSeconds))
  }

  private async pollOnce(): Promise<void> {
    if (!this.pollingEnabled) return
    if (this.isPolling) return

    const sm = SnapCloudSessionManager.getInstance()
    const client = sm ? sm.getClient() : null
    if (!client) {
      this.debugLog("No SnapCloudSessionManager client yet; waiting.")
      return
    }

    this.isPolling = true
    try {
      const {data, error} = await client
        .from(this.tableName)
        .select("id,pin_id,product_id,status,created_at")
        .eq("status", "pending")
        .order("created_at", {ascending: true})
        .limit(1)

      if (error) {
        this.log(`Poll failed: ${JSON.stringify(error)}`)
        return
      }

      if (data && data.length > 0) {
        await this.processRequest(client, data[0])
      }
    } catch (e) {
      this.log(`Poll threw: ${this.describeError(e)}`)
    } finally {
      this.isPolling = false
    }
  }

  private async processRequest(client: SupabaseClient, request: any): Promise<void> {
    if (!request || !request.id) return

    this.debugLog(`Claiming spawn request ${request.id}`)
    const {data: claimed, error: claimError} = await client
      .from(this.tableName)
      .update({status: "processing"})
      .eq("id", request.id)
      .eq("status", "pending")
      .select("id")

    if (claimError) {
      this.log(`Claim failed for ${request.id}: ${JSON.stringify(claimError)}`)
      return
    }
    if (!claimed || claimed.length === 0) {
      this.debugLog(`Claim lost for ${request.id}.`)
      return
    }

    if (!this.targetModel) {
      this.log("targetModel is not wired; marking request failed.")
      await this.setRequestStatus(client, request.id, "failed")
      return
    }
    if (!this.cameraObject) {
      this.log("cameraObject is not wired; marking request failed.")
      await this.setRequestStatus(client, request.id, "failed")
      return
    }

    this.showTargetModel()
    await this.setRequestStatus(client, request.id, "spawned")
    this.log(`Spawn request ${request.id} completed by showing pre-placed model.`)
  }

  private showTargetModel(): void {
    if (!this.targetModel || !this.cameraObject) return
    this.positionTargetModel()
    this.targetModel.enabled = true
  }

  private positionTargetModel(): void {
    if (!this.targetModel || !this.cameraObject) return

    const cameraTransform = this.cameraObject.getTransform()
    const cameraPos = cameraTransform.getWorldPosition()
    const forward = this.horizontalForward(cameraTransform)

    const modelTransform = this.targetModel.getTransform()
    const targetPos = new vec3(
      cameraPos.x + forward.x * this.spawnDistance,
      cameraPos.y + this.heightOffset,
      cameraPos.z + forward.z * this.spawnDistance
    )

    modelTransform.setWorldPosition(targetPos)

    if (this.faceCamera) {
      const toCameraX = cameraPos.x - targetPos.x
      const toCameraZ = cameraPos.z - targetPos.z
      if (toCameraX * toCameraX + toCameraZ * toCameraZ > 0.000001) {
        const yaw = Math.atan2(toCameraX, toCameraZ)
        modelTransform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
      }
    }
  }

  private horizontalForward(cameraTransform: Transform): vec3 {
    const forward = cameraTransform.forward
    let horizontal = new vec3(forward.x, 0, forward.z)
    const lenSq = horizontal.x * horizontal.x + horizontal.z * horizontal.z
    if (lenSq < 0.000001) {
      const right = cameraTransform.right
      horizontal = new vec3(-right.z, 0, right.x)
    }
    return horizontal.normalize()
  }

  private async setRequestStatus(client: SupabaseClient, requestId: string, status: string): Promise<void> {
    const {error} = await client.from(this.tableName).update({status}).eq("id", requestId)
    if (error) {
      this.log(`Failed to set ${requestId} status=${status}: ${JSON.stringify(error)}`)
    }
  }

  private log(message: string): void {
    print(`[SnapCloudARSpawnManager] ${message}`)
  }

  private debugLog(message: string): void {
    if (this.debugLogs) this.log(message)
  }

  private describeError(error: unknown): string {
    if (error === null || error === undefined) return "<null/undefined>"
    if (typeof error === "string") return error
    try {
      const maybeError = error as {message?: string; stack?: string}
      return maybeError.message || `${error}`
    } catch (_) {
      return "<unstringifiable error>"
    }
  }
}
