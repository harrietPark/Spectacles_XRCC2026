import {SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"
import {SnapCloudSessionManager} from "./SnapCloudSessionManager"
import {InteractableManipulation} from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {DragInteractorEvent} from "SpectaclesInteractionKit.lspkg/Core/Interactor/InteractorEvent"
import {Interactor} from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor"

/** A discovered grab-handle sphere under the wrapper. */
interface GrabHandle {
  object: SceneObject
  manip: InteractableManipulation
  interactable: Interactable | null
  isRotation: boolean
}

/** Product text pulled from the products table for the info card. */
interface CardData {
  description: string
  price: string
}

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
  @hint("Extra padding (cm) added around the auto-fit parent box collider (the hover/reveal trigger).")
  private grabColliderPadding: number = 2.0

  @input
  @hint("Distance (cm) the grab-handle spheres sit beyond the model's bounding box.")
  private grabHandleOffset: number = 3.0

  @input
  @hint("Hide grab handles until the hand hovers the model box or a handle.")
  private revealHandlesOnHover: boolean = true

  @input
  @hint("Grace period (seconds) before hiding handles after the hand leaves, to avoid flicker when reaching for a handle.")
  private handleHideDelaySeconds: number = 0.3

  @input
  @hint("Sound played once each time an AR model is spawned (optional).")
  @allowUndefined
  private spawnSound: AudioComponent | undefined

  @input
  @hint("Spawn a product info card (description + price) with each model.")
  private enableInfoCard: boolean = true

  @input
  @hint("Info card prefab (UI background + Text fields). Instantiated under the grabbable wrapper so it despawns with the model.")
  @allowUndefined
  private infoCardPrefab: ObjectPrefab | undefined

  @input
  @hint("Local offset (cm) of the info card relative to the model center.")
  private cardOffset: vec3 = new vec3(0, 20, 0)

  @input
  @hint("Products catalog table to look up card text from.")
  private productsTableName: string = "products"

  @input
  @hint("Products column that ar_spawn_requests.product_id matches.")
  private productKeyColumn: string = "id"

  @input
  @hint("Products column read into the card's description field.")
  private descriptionColumn: string = "description"

  @input
  @hint("Products column read into the card's price field.")
  private priceColumn: string = "price"

  @input
  @hint("Name of the SceneObject holding the description Text component inside the info card prefab.")
  private descriptionObjectName: string = "description"

  @input
  @hint("Name of the SceneObject holding the price Text component inside the info card prefab.")
  private priceObjectName: string = "price"

  @input
  @hint("Snap model position to a grid while dragging.")
  private enableGridSnap: boolean = true

  @input
  @hint("Grid cell size in centimetres for translation snapping.")
  private gridSnapUnit: number = 5.0

  @input
  @hint("Snap Y-axis rotation to fixed steps while rotating.")
  private enableRotationSnap: boolean = true

  @input
  @hint("Rotation step in degrees for Y-axis snapping.")
  private rotationSnapDegrees: number = 15.0

  @input
  @hint("Turntable smoothing (0 = instant/snappy, up to ~0.9 = very smooth but laggy). Dampens hand-tracking jitter.")
  private rotationSmoothing: number = 0.3

  private pollTimer: DelayedCallbackEvent | null = null
  private isPolling: boolean = false
  private pollingEnabled: boolean = true
  // Top-level spawned object (wrapper or GLB) keyed by `${pin_id}:${product_id}`
  // so a specific product can be removed when the portal toggles it off.
  private spawnedByKey: Map<string, SceneObject> = new Map()
  private spawnRoot: SceneObject | null = null
  private testSpawnCounter: number = 0

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

  onDestroy(): void {
    this.clearAllSpawned()
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
    this.loadAndSpawn(this.testModelUrl, `test:${this.testSpawnCounter++}`, null).then((ok) => {
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
        .in("status", ["pending", "remove_pending"])
        .order("created_at", {ascending: true})
        .limit(1)

      if (error) {
        this.log(`Poll failed: ${JSON.stringify(error)}`)
        return
      }

      this.debugLog(`Poll ok: ${data ? data.length : 0} actionable request(s).`)
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

    const key = this.spawnKey(request)

    // Removal toggle from the web portal: despawn the matching product.
    if (request.status === "remove_pending") {
      if (!(await this.claimRequest(client, request.id, "remove_pending", "removing"))) return
      const removed = this.removeSpawned(key)
      await this.setRequestStatus(client, request.id, "removed")
      this.log(`Remove request ${request.id} (key=${key}): ${removed ? "model removed" : "no matching model found"}.`)
      return
    }

    // Spawn flow.
    if (!(await this.claimRequest(client, request.id, "pending", "processing"))) return

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

    const cardData = await this.fetchCardData(client, request.product_id)

    const ok = await this.loadAndSpawn(modelUrl, key, cardData)
    if (ok) {
      await this.setRequestStatus(client, request.id, "spawned")
      this.log(`Spawn request ${request.id} completed (key=${key}).`)
    } else {
      await this.setRequestStatus(client, request.id, "failed")
      this.log(`Spawn request ${request.id} failed to load GLB.`)
    }
  }

  /** Look up the info-card text for a product. Returns null on error / no match / disabled. */
  private async fetchCardData(client: SupabaseClient, productId: unknown): Promise<CardData | null> {
    if (!this.enableInfoCard) return null
    if (productId === null || productId === undefined || productId === "") {
      this.debugLog("fetchCardData: no product_id on request; skipping card.")
      return null
    }

    try {
      const {data, error} = await client
        .from(this.productsTableName)
        .select(`${this.descriptionColumn},${this.priceColumn}`)
        .eq(this.productKeyColumn, productId)
        .limit(1)

      if (error) {
        this.log(`fetchCardData failed for product ${productId}: ${JSON.stringify(error)}`)
        return null
      }
      if (!data || data.length === 0) {
        this.debugLog(`fetchCardData: no '${this.productsTableName}' row for ${this.productKeyColumn}=${productId}.`)
        return null
      }

      const row = data[0]
      const card: CardData = {
        description: this.asText(row[this.descriptionColumn]),
        price: this.asText(row[this.priceColumn])
      }
      this.debugLog(`fetchCardData ok for product ${productId}: description/price resolved.`)
      return card
    } catch (e) {
      this.log(`fetchCardData threw: ${this.describeError(e)}`)
      return null
    }
  }

  /** Coerce a DB value into a display string (null/undefined -> empty). */
  private asText(value: unknown): string {
    if (value === null || value === undefined) return ""
    return `${value}`
  }

  /** Stable per-card key so a spawned model can later be located and removed. */
  private spawnKey(request: any): string {
    return `${request.pin_id}:${request.product_id}`
  }

  /** Atomically move a request from `fromStatus` to `toStatus`; true if this client won the claim. */
  private async claimRequest(
    client: SupabaseClient,
    requestId: string,
    fromStatus: string,
    toStatus: string
  ): Promise<boolean> {
    this.debugLog(`Claiming request ${requestId} (${fromStatus} -> ${toStatus}).`)
    const {data: claimed, error} = await client
      .from(this.tableName)
      .update({status: toStatus})
      .eq("id", requestId)
      .eq("status", fromStatus)
      .select("id")

    if (error) {
      this.log(`Claim failed for ${requestId}: ${JSON.stringify(error)}`)
      return false
    }
    if (!claimed || claimed.length === 0) {
      this.debugLog(`Claim lost for ${requestId}.`)
      return false
    }
    this.debugLog(`Claim won for ${requestId}; status=${toStatus}.`)
    return true
  }

  /** Download the GLB at `url`, instantiate it, and position it. Resolves true on success. */
  private loadAndSpawn(url: string, key: string, cardData: CardData | null): Promise<boolean> {
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
            resolve(this.instantiateGltf(gltfAsset, key, cardData))
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

  private instantiateGltf(gltfAsset: GltfAsset, key: string, cardData: CardData | null): boolean {
    const root = this.getSpawnRoot()
    if (!this.baseMaterial) {
      this.log("baseMaterial is not wired; instantiate may fail or render without material.")
    }

    // Different products coexist (distinct keys). Re-spawning the SAME product
    // replaces its previous instance via registerSpawned().

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
      // Measure + center the GLB while the wrapper is still at the origin
      // (world == wrapper-local), then position the handles and the wrapper.
      // All of this runs before grab/turntable wiring so any handle-setup
      // failure can never leave the model unpositioned (stuck at origin).
      let half = new vec3(10, 10, 10)
      try {
        half = this.fitWrapperColliderAndMeasure(wrapper, glb)
      } catch (e) {
        this.log(`fitWrapperColliderAndMeasure failed (continuing): ${this.describeError(e)}`)
      }
      this.positionGrabHandles(wrapper, half)
      this.placeInFront(wrapper)
      try {
        this.configureGrabHandles(wrapper)
      } catch (e) {
        this.log(`configureGrabHandles failed (model still placed): ${this.describeError(e)}`)
      }
      this.applyInfoCard(wrapper, cardData)
      this.registerSpawned(key, wrapper)
      this.debugLog(`Instantiated GLB '${glb.name}' inside grabbable wrapper (key=${key}). Total spawned=${this.spawnedByKey.size}.`)
    } else {
      this.placeInFront(glb)
      this.applyInfoCard(glb, cardData)
      this.registerSpawned(key, glb)
      this.debugLog(`Instantiated GLB under '${root.name}' as '${glb.name}' (key=${key}). Total spawned=${this.spawnedByKey.size}.`)
    }
    this.playSpawnSound()
    return true
  }

  private playSpawnSound(): void {
    if (!this.spawnSound) return
    try {
      this.spawnSound.play(1)
      this.debugLog("Played spawn sound.")
    } catch (e) {
      this.log(`playSpawnSound failed: ${this.describeError(e)}`)
    }
  }

  /**
   * Instantiate the info card prefab under `parent` (the grabbable wrapper, so it
   * moves/rotates and despawns with the model), place it at `cardOffset`, and fill
   * its description + price Text fields (found by object name). Never throws: a
   * card failure must not block the already-placed model.
   */
  private applyInfoCard(parent: SceneObject, cardData: CardData | null): void {
    if (!this.enableInfoCard) return
    if (!this.infoCardPrefab) {
      this.debugLog("enableInfoCard is on but infoCardPrefab is not wired; skipping card.")
      return
    }
    if (!cardData) {
      this.debugLog("No card data resolved; skipping info card.")
      return
    }

    try {
      const card = this.infoCardPrefab.instantiate(parent)
      card.name = "InfoCard"
      card.getTransform().setLocalPosition(this.cardOffset)

      const descText = this.findTextByObjectName(card, this.descriptionObjectName)
      const priceText = this.findTextByObjectName(card, this.priceObjectName)

      if (descText) {
        descText.text = cardData.description
      } else {
        this.log(`Info card: no Text object named '${this.descriptionObjectName}' in the card prefab.`)
      }
      if (priceText) {
        priceText.text = cardData.price
      } else {
        this.log(`Info card: no Text object named '${this.priceObjectName}' in the card prefab.`)
      }

      this.debugLog(
        `Info card spawned under '${parent.name}' at offset (${this.cardOffset.x}, ${this.cardOffset.y}, ${this.cardOffset.z}) ` +
          `(description=${!!descText}, price=${!!priceText}).`
      )
    } catch (e) {
      this.log(`applyInfoCard failed (model still placed): ${this.describeError(e)}`)
    }
  }

  /** Find the first Component.Text on a descendant SceneObject whose name matches `name`. */
  private findTextByObjectName(root: SceneObject, name: string): Text | null {
    if (!name) return null
    if (root.name === name) {
      const t = root.getComponent("Component.Text") as Text
      if (t) return t
    }
    const count = root.getChildrenCount()
    for (let i = 0; i < count; i++) {
      const found = this.findTextByObjectName(root.getChild(i), name)
      if (found) return found
    }
    return null
  }

  /**
   * Center the GLB inside the wrapper, size the wrapper's box collider (the
   * hover/reveal trigger) to the model's combined mesh bounds, and return the
   * model half-extents (cm) for placing the grab handles.
   */
  private fitWrapperColliderAndMeasure(wrapper: SceneObject, glb: SceneObject): vec3 {
    const visuals: RenderMeshVisual[] = []
    this.collectRenderMeshVisuals(glb, visuals)

    let size = new vec3(20, 20, 20)
    if (visuals.length === 0) {
      this.log("No RenderMeshVisual found under GLB; using default size.")
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
      // origin-centered box collider and the symmetric handle ring aligned to the model.
      const glbTransform = glb.getTransform()
      glbTransform.setLocalPosition(glbTransform.getLocalPosition().sub(center))
      this.debugLog(
        `Model bounds center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}) ` +
          `size=(${size.x.toFixed(1)}, ${size.y.toFixed(1)}, ${size.z.toFixed(1)}).`
      )
    }

    const collider = wrapper.getComponent("Physics.ColliderComponent") as ColliderComponent
    if (collider) {
      const pad = Math.max(0, this.grabColliderPadding)
      const box = Shape.createBoxShape()
      box.size = new vec3(Math.abs(size.x) + pad, Math.abs(size.y) + pad, Math.abs(size.z) + pad)
      collider.shape = box
      this.debugLog(`Parent box collider size=(${box.size.x.toFixed(1)}, ${box.size.y.toFixed(1)}, ${box.size.z.toFixed(1)}).`)
    } else {
      this.log("Wrapper has no Physics.ColliderComponent; reveal-on-hover trigger will not size.")
    }

    return new vec3(Math.abs(size.x) * 0.5, Math.abs(size.y) * 0.5, Math.abs(size.z) * 0.5)
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

  /** Find every grab-handle sphere (child with an InteractableManipulation). */
  private collectGrabHandles(wrapper: SceneObject): GrabHandle[] {
    const out: GrabHandle[] = []
    const count = wrapper.getChildrenCount()
    for (let i = 0; i < count; i++) {
      this.collectGrabHandlesRecursive(wrapper.getChild(i), out)
    }
    return out
  }

  private collectGrabHandlesRecursive(obj: SceneObject, out: GrabHandle[]): void {
    const manip = obj.getComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
    if (manip) {
      const interactable = obj.getComponent(Interactable.getTypeName()) as Interactable
      out.push({
        object: obj,
        manip: manip,
        interactable: interactable ? interactable : null,
        isRotation: obj.name.toLowerCase().indexOf("rot") >= 0
      })
    }
    const childCount = obj.getChildrenCount()
    for (let c = 0; c < childCount; c++) {
      this.collectGrabHandlesRecursive(obj.getChild(c), out)
    }
  }

  /** Place translation handles at the box side midpoints and rotation handles at the corners. */
  private positionGrabHandles(wrapper: SceneObject, half: vec3): void {
    const handles = this.collectGrabHandles(wrapper)
    const o = Math.max(0, this.grabHandleOffset)
    const sx = half.x + o
    const sz = half.z + o

    // y = 0: handles ring the model at its vertical center.
    const sidePositions = [new vec3(0, 0, sz), new vec3(0, 0, -sz), new vec3(sx, 0, 0), new vec3(-sx, 0, 0)]
    const cornerPositions = [new vec3(sx, 0, sz), new vec3(sx, 0, -sz), new vec3(-sx, 0, sz), new vec3(-sx, 0, -sz)]

    let nTranslate = 0
    let nRotate = 0
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i]
      if (h.isRotation) {
        h.object.getTransform().setLocalPosition(cornerPositions[nRotate % cornerPositions.length])
        nRotate++
      } else {
        h.object.getTransform().setLocalPosition(sidePositions[nTranslate % sidePositions.length])
        nTranslate++
      }
    }

    if (nTranslate !== 4 || nRotate !== 4) {
      this.log(`Grab handles: expected 4 translate + 4 rotate, found ${nTranslate} translate + ${nRotate} rotate.`)
    }
    this.debugLog(`Positioned ${nTranslate} translate + ${nRotate} rotate handles (offset=${o}cm, sx=${sx.toFixed(1)}, sz=${sz.toFixed(1)}).`)
  }

  /** Wire translation (side) + rotation (corner) handles and the hover-reveal behavior. */
  private configureGrabHandles(wrapper: SceneObject): void {
    const handles = this.collectGrabHandles(wrapper)
    if (handles.length === 0) {
      this.log("No grab handles (children with InteractableManipulation) found under wrapper.")
      return
    }

    const wrapperTransform = wrapper.getTransform()
    const reveal = this.revealHandlesOnHover
    let parentHovered = false
    const handleHovered: boolean[] = []
    const handleActive: boolean[] = []
    let hideTimer: DelayedCallbackEvent | null = null

    const computeShow = (): boolean => {
      if (parentHovered) return true
      for (let i = 0; i < handles.length; i++) {
        if (handleHovered[i] || handleActive[i]) return true
      }
      return false
    }
    const setHandlesEnabled = (on: boolean) => {
      for (let i = 0; i < handles.length; i++) handles[i].object.enabled = on
    }

    // Reveal immediately, but defer hiding by a grace period. Because a handle
    // sticks out beyond the parent box, the parent's hover-exit may fire just
    // before the handle's hover-enter; a deferred, re-checked hide prevents the
    // handle from being disabled in that gap (which would make it un-hoverable).
    const updateVisibility = () => {
      if (!reveal) return
      if (computeShow()) {
        setHandlesEnabled(true)
        return
      }
      if (!hideTimer) {
        hideTimer = this.createEvent("DelayedCallbackEvent")
        hideTimer.bind(() => {
          if (!computeShow()) setHandlesEnabled(false)
        })
      }
      hideTimer.reset(Math.max(0, this.handleHideDelaySeconds))
    }

    for (let i = 0; i < handles.length; i++) {
      handleHovered[i] = false
      handleActive[i] = false
      const h = handles[i]
      const idx = i
      if (reveal) h.object.enabled = false

      if (h.isRotation) {
        this.setupRotationHandle(h, wrapperTransform, idx, handleActive, updateVisibility)
      } else {
        this.setupTranslationHandle(h, wrapperTransform, idx, handleActive, updateVisibility)
      }

      if (h.interactable) {
        h.interactable.onHoverEnter.add(() => {
          handleHovered[idx] = true
          updateVisibility()
        })
        h.interactable.onHoverExit.add(() => {
          handleHovered[idx] = false
          updateVisibility()
        })
      }
    }

    if (reveal) {
      const parentInteractable = wrapper.getComponent(Interactable.getTypeName()) as Interactable
      if (parentInteractable) {
        parentInteractable.onHoverEnter.add(() => {
          parentHovered = true
          updateVisibility()
        })
        parentInteractable.onHoverExit.add(() => {
          parentHovered = false
          updateVisibility()
        })
      } else {
        this.log("Wrapper has no Interactable; cannot reveal on hover. Keeping handles visible.")
        for (let i = 0; i < handles.length; i++) handles[i].object.enabled = true
      }
    }

    const nRot = handles.filter((h) => h.isRotation).length
    this.debugLog(
      `Configured ${handles.length} handles (${handles.length - nRot} translate + ${nRot} rotate), reveal=${reveal}.`
    )
  }

  /** Side handle: drags the whole model via the shared wrapper root, with grid snapping. */
  private setupTranslationHandle(
    h: GrabHandle,
    wrapperTransform: Transform,
    idx: number,
    handleActive: boolean[],
    updateVisibility: () => void
  ): void {
    const manip = h.manip
    manip.enabled = true
    manip.setManipulateRoot(wrapperTransform)
    manip.setCanTranslate(true)
    manip.setCanRotate(false)
    manip.setCanScale(false)

    const snapPosition = () => {
      if (!this.enableGridSnap || this.gridSnapUnit <= 0) return
      const p = wrapperTransform.getWorldPosition()
      wrapperTransform.setWorldPosition(new vec3(this.snapToGrid(p.x), this.snapToGrid(p.y), this.snapToGrid(p.z)))
    }
    manip.onTranslationUpdate.add(snapPosition)
    manip.onTranslationEnd.add(snapPosition)

    manip.onManipulationStart.add(() => {
      handleActive[idx] = true
      updateVisibility()
    })
    manip.onManipulationEnd.add(() => {
      handleActive[idx] = false
      updateVisibility()
    })
  }

  /** Corner handle: turntable rotation about the model's vertical center (manip disabled, custom drag). */
  private setupRotationHandle(
    h: GrabHandle,
    wrapperTransform: Transform,
    idx: number,
    handleActive: boolean[],
    updateVisibility: () => void
  ): void {
    // Disable SIK manipulation on this handle: rotation is driven manually so a
    // single-hand drag orbits the model around its center.
    h.manip.enabled = false

    if (!h.interactable) {
      this.log(`Rotation handle '${h.object.name}' has no Interactable; cannot drive turntable.`)
      return
    }

    // Turntable state. `accumulatedDelta` grows continuously (unbounded) by
    // summing per-frame angle steps, so crossing the +/-180 deg seam never causes
    // a ~360 deg snap. `smoothedYaw` is the damped value actually applied.
    let startYaw = 0
    let prevPointerAngle = 0
    let havePrevAngle = false
    let accumulatedDelta = 0
    let smoothedYaw = 0

    h.interactable.onDragStart.add((e: DragInteractorEvent) => {
      const center = wrapperTransform.getWorldPosition()
      startYaw = this.currentYaw(wrapperTransform)
      const a = this.pointerAngle(e.interactor, center)
      havePrevAngle = !isNaN(a)
      prevPointerAngle = havePrevAngle ? a : 0
      accumulatedDelta = 0
      smoothedYaw = startYaw
      handleActive[idx] = true
      updateVisibility()
    })

    h.interactable.onDragUpdate.add((e: DragInteractorEvent) => {
      const center = wrapperTransform.getWorldPosition()
      const a = this.pointerAngle(e.interactor, center)
      // Skip frames where the pointing ray gives no reliable horizontal point
      // (e.g. near-horizontal ray): applying them would jerk the model.
      if (isNaN(a)) return
      if (!havePrevAngle) {
        prevPointerAngle = a
        havePrevAngle = true
        return
      }

      // Add only the shortest-arc step since last frame; this is what keeps the
      // accumulation continuous across the atan2 wrap boundary.
      accumulatedDelta += this.normalizeAngle(a - prevPointerAngle)
      prevPointerAngle = a

      const targetYaw = startYaw + accumulatedDelta
      // Exponential, frame-rate-independent smoothing toward the target. Both
      // values are continuous (no wrapping needed), so a plain lerp is safe.
      const s = Math.max(0, Math.min(0.95, this.rotationSmoothing))
      if (s > 0) {
        const k = 1 - Math.pow(s, getDeltaTime() * 60)
        smoothedYaw = smoothedYaw + (targetYaw - smoothedYaw) * k
      } else {
        smoothedYaw = targetYaw
      }

      const yaw = this.snapYawValue(smoothedYaw)
      wrapperTransform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
    })

    h.interactable.onDragEnd.add(() => {
      // Settle from the accumulated value (not a re-extracted Euler angle, which
      // can differ slightly and cause a small snap on release).
      const yaw = this.snapYawValue(startYaw + accumulatedDelta)
      wrapperTransform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
      handleActive[idx] = false
      updateVisibility()
    })
  }

  /**
   * Angle (radians) of the interactor's pointing position around `center` in the
   * horizontal plane. Intersects the interactor ray with the y=center.y plane so
   * the turntable tracks where the user points, independent of the moving handle.
   */
  private pointerAngle(interactor: Interactor, center: vec3): number {
    const origin = interactor.startPoint
    const dir = interactor.direction

    // Preferred: intersect the pointing ray with the horizontal plane through the
    // model center. Require a non-shallow ray (|dir.y| not tiny) and a forward hit
    // (t > 0) so we don't project to a wildly distant, jittery point.
    if (origin && dir && Math.abs(dir.y) > 1e-2) {
      const t = (center.y - origin.y) / dir.y
      if (t > 0) {
        const px = origin.x + dir.x * t
        const pz = origin.z + dir.z * t
        return Math.atan2(px - center.x, pz - center.z)
      }
    }

    // Fallback: use the actual hit point if we have one.
    const hit = interactor.targetHitPosition
    if (hit) {
      return Math.atan2(hit.x - center.x, hit.z - center.z)
    }

    // No reliable horizontal point this frame.
    return NaN
  }

  /** Wrap an angle (radians) into the shortest-arc range [-PI, PI]. */
  private normalizeAngle(angle: number): number {
    return Math.atan2(Math.sin(angle), Math.cos(angle))
  }

  private currentYaw(t: Transform): number {
    return t.getWorldRotation().toEulerAngles().y
  }

  private snapYawValue(yaw: number): number {
    if (!this.enableRotationSnap || this.rotationSnapDegrees <= 0) return yaw
    const stepRad = (this.rotationSnapDegrees * Math.PI) / 180
    return Math.round(yaw / stepRad) * stepRad
  }

  private snapToGrid(value: number): number {
    const unit = this.gridSnapUnit
    return Math.round(value / unit) * unit
  }

  private applyModelScale(obj: SceneObject): void {
    if (this.modelScale !== 1.0) {
      obj.getTransform().setLocalScale(new vec3(this.modelScale, this.modelScale, this.modelScale))
      this.debugLog(`Applied uniform scale ${this.modelScale}.`)
    }
  }

  /** Register a freshly spawned model, replacing any prior instance for the same key. */
  private registerSpawned(key: string, obj: SceneObject): void {
    const existing = this.spawnedByKey.get(key)
    if (existing) {
      existing.destroy()
      this.debugLog(`Replaced existing spawned model for key=${key}.`)
    }
    this.spawnedByKey.set(key, obj)
  }

  /** Destroy the spawned model for `key`. Returns true if one existed. */
  private removeSpawned(key: string): boolean {
    const obj = this.spawnedByKey.get(key)
    if (!obj) return false
    obj.destroy()
    this.spawnedByKey.delete(key)
    this.debugLog(`Removed spawned model key=${key}. Remaining=${this.spawnedByKey.size}.`)
    return true
  }

  /** Destroys every spawned model. Used on component teardown. */
  private clearAllSpawned(): void {
    let n = 0
    this.spawnedByKey.forEach((obj) => {
      if (obj) {
        obj.destroy()
        n++
      }
    })
    this.spawnedByKey.clear()
    this.debugLog(`Cleared ${n} spawned model(s).`)
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
