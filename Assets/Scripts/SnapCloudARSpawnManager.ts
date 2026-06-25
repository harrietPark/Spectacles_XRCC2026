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

  private pollTimer: DelayedCallbackEvent | null = null
  private isPolling: boolean = false
  private pollingEnabled: boolean = true
  private spawnedObjects: SceneObject[] = []
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

    // Note: previously spawned models are intentionally NOT removed here, so
    // multiple recommended products can coexist. Use clearAllSpawned() to reset.

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
      this.spawnedObjects.push(wrapper)
      this.debugLog(`Instantiated GLB '${glb.name}' inside grabbable wrapper. Total spawned=${this.spawnedObjects.length}.`)
    } else {
      this.placeInFront(glb)
      this.spawnedObjects.push(glb)
      this.debugLog(`Instantiated GLB under '${root.name}' as '${glb.name}'. Total spawned=${this.spawnedObjects.length}.`)
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

    let startPointerAngle = 0
    let startYaw = 0

    h.interactable.onDragStart.add((e: DragInteractorEvent) => {
      const center = wrapperTransform.getWorldPosition()
      startYaw = this.currentYaw(wrapperTransform)
      startPointerAngle = this.pointerAngle(e.interactor, center)
      handleActive[idx] = true
      updateVisibility()
    })

    h.interactable.onDragUpdate.add((e: DragInteractorEvent) => {
      const center = wrapperTransform.getWorldPosition()
      const delta = this.pointerAngle(e.interactor, center) - startPointerAngle
      const yaw = this.snapYawValue(startYaw + delta)
      wrapperTransform.setWorldRotation(quat.angleAxis(yaw, vec3.up()))
    })

    h.interactable.onDragEnd.add(() => {
      const yaw = this.snapYawValue(this.currentYaw(wrapperTransform))
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
    let point: vec3 | null = interactor.targetHitPosition

    if (origin && dir && Math.abs(dir.y) > 1e-4) {
      const t = (center.y - origin.y) / dir.y
      if (t > 0) {
        point = new vec3(origin.x + dir.x * t, center.y, origin.z + dir.z * t)
      }
    }
    if (!point) point = origin ? origin : center

    return Math.atan2(point.x - center.x, point.z - center.z)
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

  /** Destroys every spawned model. Not called on spawn; available for a manual reset. */
  private clearAllSpawned(): void {
    for (let i = 0; i < this.spawnedObjects.length; i++) {
      const obj = this.spawnedObjects[i]
      if (obj) obj.destroy()
    }
    this.debugLog(`Cleared ${this.spawnedObjects.length} spawned model(s).`)
    this.spawnedObjects = []
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
