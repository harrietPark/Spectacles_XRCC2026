import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"
import {InteractableManipulation} from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"

/**
 * SnapCloudARSpawnManager
 * -----------------------
 * AR spawn bridge that loads the product GLB by URL.
 *
 * Web portal inserts a row in `ar_spawn_requests` with `status='pending'` and
 * an `original_model_3d_url` pointing at the product's GLB. This script claims
 * that row, downloads the GLB at runtime, instantiates it, and places it once
 * in front of the user's camera at camera height.
 *
 * The previous behavior (enabling a single pre-placed `targetModel`) is kept
 * below as commented-out code for reference / fallback.
 */
@component
export class SnapCloudARSpawnManager extends BaseScriptComponent {
  // Lens Studio modules used to download + instantiate the remote GLB.
  private internetModule: InternetModule = require("LensStudio:InternetModule")
  private remoteMediaModule: RemoteMediaModule = require("LensStudio:RemoteMediaModule")

  @input
  @hint("LEGACY: pre-placed 3D model root (no longer used for spawning; URL load replaces it).")
  @allowUndefined
  private targetModel: SceneObject | undefined

  @input
  @hint("Camera SceneObject used to place the spawned model in front of the user.")
  @allowUndefined
  private cameraObject: SceneObject | undefined

  @input
  @hint("Base PBR material applied to the instantiated GLB (required by tryInstantiate).")
  @allowUndefined
  private baseMaterial: Material | undefined

  @input
  @hint("DEPRECATED/ignored: spawned models always parent to an auto-created static scene root so they stay world-locked.")
  @allowUndefined
  private spawnParent: SceneObject | undefined

  @input
  @hint("Request column holding the GLB URL to download.")
  private modelUrlColumn: string = "original_model_3d_url"

  @input
  @hint("Uniform scale applied to the spawned model (1 = no change).")
  private modelScale: number = 1.0

  @input
  @hint("Convert GLTF meters to Lens centimetres on instantiate (usually true).")
  private convertMetersToCentimeters: boolean = true

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

  @input
  @hint("TEST MODE: ignore spawn requests and load the hard-coded testModelUrl once on start.")
  private testMode: boolean = false

  @input
  @hint("Hard-coded GLB URL loaded when testMode is on.")
  private testModelUrl: string =
    "https://web-api.ikea.com/dimma/assets/1.2/20359154/PS01_S01_NV01/rqp3/glb_draco/20359154_PS01_S01_NV01_RQP3_3.0_298fca27ac4a41379a171d7e7aba1e9a.glb"

  @input
  @hint("Prefab with Collider + Interactable + InteractableManipulation. The GLB is parented under it for grabbing.")
  @allowUndefined
  private grabbableWrapper: ObjectPrefab | undefined

  @input
  @hint("Allow grabbing/manipulating spawned models (requires grabbableWrapper).")
  private enableGrab: boolean = true

  @input
  @hint("Extra padding (cm) added around the auto-fit grab collider.")
  private grabColliderPadding: number = 2.0

  private pollTimer: DelayedCallbackEvent | null = null
  private isPolling: boolean = false
  private pollingEnabled: boolean = true
  private spawnedObject: SceneObject | null = null
  private spawnRoot: SceneObject | null = null

  onAwake(): void {
    if (this.hideOnStart && this.targetModel) {
      this.targetModel.enabled = false
    }

    if (this.testMode) {
      this.pollingEnabled = false
      this.createEvent("OnStartEvent").bind(this.runTestSpawn.bind(this))
      return
    }

    if (this.ignoreEditorPreview && global.deviceInfoSystem && global.deviceInfoSystem.isEditor()) {
      this.pollingEnabled = false
      this.log("Disabled in Lens Studio Preview so Spectacles can claim web spawn requests.")
      return
    }

    this.createEvent("OnStartEvent").bind(this.startPolling.bind(this))
  }

  private runTestSpawn(): void {
    if (!this.testModelUrl) {
      this.log("TEST MODE: testModelUrl is empty; nothing to spawn.")
      return
    }
    if (!this.cameraObject) {
      this.log("TEST MODE: cameraObject is not wired; model will spawn but cannot be positioned.")
    }
    this.log(`TEST MODE: loading hard-coded model from ${this.testModelUrl}`)
    this.loadAndSpawn(this.testModelUrl).then((ok) => {
      this.log(`TEST MODE: spawn ${ok ? "succeeded" : "failed"}.`)
    })
  }

  private startPolling(): void {
    if (!this.pollingEnabled) return

    this.log(
      `Ready. camera=${this.cameraObject ? this.cameraObject.name : "NOT SET"}, ` +
        `baseMaterial=${this.baseMaterial ? "SET" : "NOT SET"}, ` +
        `urlColumn=${this.modelUrlColumn}, table=${this.tableName}`
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
        .select(`id,pin_id,product_id,${this.modelUrlColumn},status,created_at`)
        .eq("status", "pending")
        .order("created_at", {ascending: true})
        .limit(1)

      if (error) {
        this.log(`Poll failed: ${JSON.stringify(error)}`)
        return
      }

      this.debugLog(`Poll ok: ${data ? data.length : 0} pending request(s).`)
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
    this.debugLog(`Claim won for ${request.id}; status=processing.`)

    if (!this.cameraObject) {
      this.log("cameraObject is not wired; marking request failed.")
      await this.setRequestStatus(client, request.id, "failed")
      return
    }

    const modelUrl = request[this.modelUrlColumn]
    this.debugLog(`Resolved url from '${this.modelUrlColumn}': ${modelUrl ? modelUrl : "<none>"}`)
    if (!modelUrl || typeof modelUrl !== "string") {
      this.log(`No '${this.modelUrlColumn}' on request ${request.id}; marking failed.`)
      await this.setRequestStatus(client, request.id, "failed")
      return
    }

    const ok = await this.loadAndSpawn(modelUrl)
    if (ok) {
      await this.setRequestStatus(client, request.id, "spawned")
      this.log(`Spawn request ${request.id} completed by loading GLB from url.`)
    } else {
      await this.setRequestStatus(client, request.id, "failed")
      this.log(`Spawn request ${request.id} failed to load GLB.`)
    }

    // ===== OLD pre-placed model path (kept for reference / fallback) =====
    // if (!this.targetModel) {
    //   this.log("targetModel is not wired; marking request failed.")
    //   await this.setRequestStatus(client, request.id, "failed")
    //   return
    // }
    // this.showTargetModel()
    // await this.setRequestStatus(client, request.id, "spawned")
    // this.log(`Spawn request ${request.id} completed by showing pre-placed model.`)
  }

  /** Download the GLB at `url`, instantiate it, and position it. Resolves true on success. */
  private loadAndSpawn(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        this.debugLog(`Resolving resource from url=${url}`)
        const resource = this.internetModule.makeResourceFromUrl(url)
        if (!resource) {
          this.log("makeResourceFromUrl returned null/undefined.")
          resolve(false)
          return
        }

        this.debugLog("Download started (loadResourceAsGltfAsset).")
        this.remoteMediaModule.loadResourceAsGltfAsset(
          resource,
          (gltfAsset: GltfAsset) => {
            this.debugLog("GLB downloaded ok; instantiating.")
            resolve(this.instantiateGltf(gltfAsset))
          },
          (errorMessage: string) => {
            this.log(`GLB load failed: ${errorMessage}`)
            resolve(false)
          }
        )
      } catch (e) {
        this.log(`loadAndSpawn threw: ${this.describeError(e)}`)
        resolve(false)
      }
    })
  }

  /**
   * Returns a stable, world-anchored parent for spawned models. The model
   * must NOT be parented under the camera (it would follow the user's head),
   * so we ALWAYS use a persistent SceneObject created at the scene root and
   * ignore `spawnParent` for parenting. The model is placed in world space,
   * and because this root never moves the model stays put.
   */
  private getSpawnRoot(): SceneObject {
    if (!this.spawnRoot) {
      this.spawnRoot = global.scene.createSceneObject("SnapCloudARSpawnRoot")
      const rootParent = this.spawnRoot.getParent()
      this.debugLog(
        `Created static spawn root 'SnapCloudARSpawnRoot' (parent=${rootParent ? rootParent.name : "<scene root>"}).`
      )
    }
    if (this.spawnParent) {
      this.debugLog("Ignoring 'spawnParent' input on purpose; using static scene root so the model stays world-locked.")
    }
    return this.spawnRoot
  }

  private instantiateGltf(gltfAsset: GltfAsset): boolean {
    const root = this.getSpawnRoot()
    if (!this.baseMaterial) {
      this.log("baseMaterial is not wired; instantiate may fail or render without material.")
    }

    this.cleanupPrevious()

    // Optionally wrap the GLB in a grabbable prefab so it can be manipulated.
    let wrapper: SceneObject | null = null
    let glbParent: SceneObject = root
    if (this.enableGrab) {
      if (this.grabbableWrapper) {
        wrapper = this.grabbableWrapper.instantiate(root)
        wrapper.name = "GrabbableWrapper"
        glbParent = wrapper
        this.debugLog("Instantiated grabbable wrapper under spawn root.")
      } else {
        this.log("enableGrab is on but grabbableWrapper is not wired; spawning without grab.")
      }
    }

    let glb: SceneObject | null = null
    try {
      const settings = GltfSettings.create()
      settings.convertMetersToCentimeters = this.convertMetersToCentimeters
      glb = gltfAsset.tryInstantiateWithSetting(glbParent, this.baseMaterial, settings)
    } catch (e) {
      this.log(`tryInstantiateWithSetting threw: ${this.describeError(e)}`)
      if (wrapper) wrapper.destroy()
      return false
    }

    if (!glb) {
      this.log("tryInstantiateWithSetting returned null.")
      if (wrapper) wrapper.destroy()
      return false
    }

    this.applyModelScale(glb)

    if (wrapper) {
      this.fitGrabCollider(wrapper, glb)
      this.configureManipulation(wrapper)
      this.placeInFront(wrapper)
      this.spawnedObject = wrapper
      this.debugLog(`Instantiated GLB '${glb.name}' inside grabbable wrapper.`)
    } else {
      this.placeInFront(glb)
      this.spawnedObject = glb
      this.debugLog(`Instantiated GLB under '${root.name}' as '${glb.name}'.`)
    }
    return true
  }

  /** Auto-fit the wrapper's box collider to the GLB's combined mesh bounds and center the GLB inside it. */
  private fitGrabCollider(wrapper: SceneObject, glb: SceneObject): void {
    const collider = wrapper.getComponent("Physics.ColliderComponent") as ColliderComponent
    if (!collider) {
      this.log("Grabbable wrapper has no Physics.ColliderComponent; cannot size grab collider.")
      return
    }

    const visuals: RenderMeshVisual[] = []
    this.collectRenderMeshVisuals(glb, visuals)

    let size = new vec3(20, 20, 20)
    if (visuals.length === 0) {
      this.log("No RenderMeshVisual found under GLB; using default collider size.")
    } else {
      let min = visuals[0].worldAabbMin()
      let max = visuals[0].worldAabbMax()
      for (let i = 1; i < visuals.length; i++) {
        const vmin = visuals[i].worldAabbMin()
        const vmax = visuals[i].worldAabbMax()
        min = new vec3(Math.min(min.x, vmin.x), Math.min(min.y, vmin.y), Math.min(min.z, vmin.z))
        max = new vec3(Math.max(max.x, vmax.x), Math.max(max.y, vmax.y), Math.max(max.z, vmax.z))
      }
      const center = min.add(max).uniformScale(0.5)
      size = max.sub(min)

      // Wrapper is still at the spawn root origin here, so world space == wrapper-local
      // space. Shift the GLB so its bounds center sits at the wrapper origin, keeping the
      // origin-centered box collider aligned to the model.
      const glbTransform = glb.getTransform()
      glbTransform.setLocalPosition(glbTransform.getLocalPosition().sub(center))
      this.debugLog(
        `Grab bounds center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}) ` +
          `size=(${size.x.toFixed(1)}, ${size.y.toFixed(1)}, ${size.z.toFixed(1)}).`
      )
    }

    const pad = Math.max(0, this.grabColliderPadding)
    const box = Shape.createBoxShape()
    box.size = new vec3(Math.abs(size.x) + pad, Math.abs(size.y) + pad, Math.abs(size.z) + pad)
    collider.shape = box
    this.debugLog(`Grab collider box size=(${box.size.x.toFixed(1)}, ${box.size.y.toFixed(1)}, ${box.size.z.toFixed(1)}).`)
  }

  private collectRenderMeshVisuals(obj: SceneObject, out: RenderMeshVisual[]): void {
    const comps = obj.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]
    for (let i = 0; i < comps.length; i++) {
      out.push(comps[i])
    }
    const childCount = obj.getChildrenCount()
    for (let c = 0; c < childCount; c++) {
      this.collectRenderMeshVisuals(obj.getChild(c), out)
    }
  }

  /** Enable move + rotate, disable scale, and wire grab start/end debug hooks. */
  private configureManipulation(wrapper: SceneObject): void {
    const manip = wrapper.getComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
    if (!manip) {
      this.log("Grabbable wrapper has no InteractableManipulation; model will not be grabbable.")
      return
    }
    manip.setCanTranslate(true)
    manip.setCanRotate(true)
    manip.setCanScale(false)
    manip.onManipulationStart.add(() => this.debugLog("Grab start."))
    manip.onManipulationEnd.add(() => this.debugLog("Grab end."))
    this.debugLog("Configured manipulation: translate+rotate on, scale off.")
  }

  private applyModelScale(obj: SceneObject): void {
    if (this.modelScale !== 1.0) {
      obj.getTransform().setLocalScale(new vec3(this.modelScale, this.modelScale, this.modelScale))
      this.debugLog(`Applied uniform scale ${this.modelScale}.`)
    }
  }

  private cleanupPrevious(): void {
    if (this.spawnedObject) {
      this.debugLog(`Destroying previous spawned model '${this.spawnedObject.name}'.`)
      this.spawnedObject.destroy()
      this.spawnedObject = null
    }
  }

  private placeInFront(obj: SceneObject): void {
    if (!this.cameraObject) {
      this.log("cameraObject not wired; cannot position spawned model.")
      return
    }

    const cameraTransform = this.cameraObject.getTransform()
    const cameraPos = cameraTransform.getWorldPosition()
    const forward = this.horizontalForward(cameraTransform)

    const objTransform = obj.getTransform()
    const targetPos = new vec3(
      cameraPos.x + forward.x * this.spawnDistance,
      cameraPos.y + this.heightOffset,
      cameraPos.z + forward.z * this.spawnDistance
    )

    objTransform.setWorldPosition(targetPos)

    if (this.faceCamera) {
      const toCameraX = cameraPos.x - targetPos.x
      const toCameraZ = cameraPos.z - targetPos.z
      if (toCameraX * toCameraX + toCameraZ * toCameraZ > 0.000001) {
        const yaw = Math.atan2(toCameraX, toCameraZ)
        objTransform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
      }
    }

    this.debugLog(
      `Positioned model at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)}) ` +
        `faceCamera=${this.faceCamera}.`
    )
  }

  // ===== OLD pre-placed model methods (kept for reference / fallback) =====
  // private showTargetModel(): void {
  //   if (!this.targetModel || !this.cameraObject) return
  //   this.positionTargetModel()
  //   this.targetModel.enabled = true
  // }
  //
  // private positionTargetModel(): void {
  //   if (!this.targetModel || !this.cameraObject) return
  //
  //   const cameraTransform = this.cameraObject.getTransform()
  //   const cameraPos = cameraTransform.getWorldPosition()
  //   const forward = this.horizontalForward(cameraTransform)
  //
  //   const modelTransform = this.targetModel.getTransform()
  //   const targetPos = new vec3(
  //     cameraPos.x + forward.x * this.spawnDistance,
  //     cameraPos.y + this.heightOffset,
  //     cameraPos.z + forward.z * this.spawnDistance
  //   )
  //
  //   modelTransform.setWorldPosition(targetPos)
  //
  //   if (this.faceCamera) {
  //     const toCameraX = cameraPos.x - targetPos.x
  //     const toCameraZ = cameraPos.z - targetPos.z
  //     if (toCameraX * toCameraX + toCameraZ * toCameraZ > 0.000001) {
  //       const yaw = Math.atan2(toCameraX, toCameraZ)
  //       modelTransform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
  //     }
  //   }
  // }

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
    } else {
      this.debugLog(`Request ${requestId} -> status=${status}.`)
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
