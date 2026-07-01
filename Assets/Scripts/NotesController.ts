import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { AreaManager } from "Samples/Spatial_Persistence/SpatialPersistance/AreaManager";
import { WidgetSelectionEvent } from "Samples/Spatial_Persistence/SpatialPersistance/MenuUI/WidgetSelection";
import { Note } from "Samples/Spatial_Persistence/SpatialPersistance/Notes/Note";
import { Widget } from "Samples/Spatial_Persistence/SpatialPersistance/Widget";
import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider";
import SIK from "SpectaclesInteractionKit.lspkg/SIK";
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event";
import { SceneManager } from "./SceneManager";
import { PresetNote } from "./PresetNote";
// [AutoStartSTT] NEW: explicit, race-free Snap Cloud subscription at spawn.
import { SnapCloudPinManager } from "./SnapCloudPinManager";
import { setTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils";

@component
export class NotesController extends BaseScriptComponent {
  private onUserViewCapturedEvent = new Event<Texture>();
  public readonly onUserViewCaptured: PublicApi<Texture> =
    this.onUserViewCapturedEvent.publicApi();

  private onNoteSpawnedEvent = new Event<WidgetSelectionEvent>();
  public readonly onNoteSpawned: PublicApi<WidgetSelectionEvent> =
    this.onNoteSpawnedEvent.publicApi();

  @input
  @allowUndefined
  private areaManager: AreaManager | undefined;
  @input private presetNotes: SceneObject;
  @ui.group_start("Note Spawning Settings")
  @input
  private fingerDwellingTimeThreshold: number = 2; // in seconds
  @input private fingerDwellRadius: number = 1; // in cm
  @ui.group_end
  @ui.group_start("Crop to Photo")
  @input
  @allowUndefined
  private pictureController: PictureController | undefined;
  @ui.group_end
  @ui.separator
  @ui.group_start("Note Visual Settings")
  @input
  private fovCone: SceneObject;
  @ui.group_end
  @ui.group_start("Spawn Rotation")
  @input
  @hint(
    "Additional yaw offset so note front faces the user. 180 fixes back-facing note meshes.",
  )
  private noteSpawnYawOffsetDegrees: number = 180;
  @ui.group_end
  @ui.group_start("Editor Debug Spawn")
  @input
  @hint("Spawn distance in front of camera for editor debug note placement.")
  private debugSpawnDistanceFromCamera: number = 40;
  @input
  @hint("Enable capture/crop flow when using debug spawn in editor.")
  private debugSpawnRunsCaptureAndCrop: boolean = false;
  @ui.group_end

  // Hand tracking
  private handProvider: HandInputData = SIK.HandInputData;
  private rightHand = this.handProvider.getHand("right");
  private worldCameraTransform =
    WorldCameraFinderProvider.getInstance().getTransform();
  private fingerDwellTimer: number = 0;
  private prevHandPosition: vec3 = vec3.zero();

  // User looks away and notes minimised
  private prevLiveNotesObjInFOV: SceneObject[] = [];
  private prevPresetNotesObjInFOV: SceneObject[] = [];

  // ============================================================
  // [DeleteCrashFix] NEW
  // Authoritative set of currently-alive live-note SceneObjects, rebuilt
  // by updateNotes() on every widget add/remove (incl. delete). The FOV
  // diff filters against this by REFERENCE (Set.has) - a pure JS compare
  // that never calls a native API on a possibly-destroyed handle - so a
  // deleted note's object is dropped before we ever dereference it. This
  // is the primary guard against the delete-then-create crash; the
  // isSceneObjectAlive() probe and try/catch blocks are secondary backups.
  // ============================================================
  private liveNoteObjects: Set<SceneObject> = new Set();

  // State booleans
  private isNoteAnchoringActive: boolean = false;
  private wasFingerDwellIndicatorActive: boolean = false;

  // Stateful objects
  private notes: Note[] = [];
  private sceneManager: SceneManager = SceneManager.getInstance();

  private onAwake() {
    this.deactivateCreationProcess();

    this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
  }

  private onStart() {
    if (this.pictureController) {
      this.pictureController.onCropEnd.add(this.addCroppedImage.bind(this));
      this.pictureController.onCropAISummarised.add(
        this.addCropAISummary.bind(this),
      );
    } else {
      print(
        "[NoteController] pictureController is not assigned; crop flow is disabled.",
      );
    }

    if (this.areaManager) {
      this.areaManager.onWidgetsUpdated.add(this.updateNotes.bind(this));
    } else {
      print(
        "[NoteController] areaManager is not assigned; crop-to-latest-note sync is disabled.",
      );
    }

    const fovCollider = this.fovCone.getComponent("Physics.ColliderComponent");
    // Setup FOV collider to only detect overlap with Notes
    const notesFilter = Physics.Filter.create();
    notesFilter.onlyLayers = LayerSet.fromNumber(1);
    fovCollider.overlapFilter = notesFilter;
    fovCollider.onOverlapEnter.add((OverlapEnterEventArgs) => {
      this.updateAllNotesInFOV(OverlapEnterEventArgs);
    });
    fovCollider.onOverlapExit.add((OverlapExitEventArgs) => {
      this.updateAllNotesInFOV(OverlapExitEventArgs);
    });
  }

  private onUpdate() {
    if (this.isNoteAnchoringActive) {
      if (this.tryAnchorNote()) {
        this.spawnANote();
      }
    }
  }

  public activateCreationProcess() {
    this.sceneManager.uxFeedbackController.activateIndexTipHighlight();
    this.isNoteAnchoringActive = true;
  }

  public deactivateCreationProcess() {
    this.sceneManager.uxFeedbackController.deactivateIndexTipHighlight();
    this.sceneManager.uxFeedbackController.deactivateDwellIndicator();
    this.isNoteAnchoringActive = false;
  }

  private updateNotes(widgets: Widget[]) {
    const updatedNotes = widgets.map((widget) =>
      widget.getSceneObject().getComponent(Note.getTypeName()),
    );

    const addedNotes = updatedNotes.filter(
      (note) => !this.notes.includes(note),
    );
    for (const note of addedNotes) {
      note.onNoteCompleted.add((noteData) => {
        this.sceneManager.sendCompleteNoteDataToBackend(noteData);
      });

      // ============================================================
      // [AutoStartSTT] NEW
      // Subscribe the note to Snap Cloud immediately at spawn time
      // instead of waiting for SnapCloudPinManager's ~1s scene scan.
      // With auto-start, recording begins right at spawn, so a short
      // first utterance could otherwise finalize before the scan
      // subscribes. registerNote() is guarded against double-subscribe.
      // ============================================================
      SnapCloudPinManager.getInstance()?.registerNote(note);
    }

    const removedNotes = this.notes.filter(
      (note) => !updatedNotes.includes(note),
    );
    for (const note of removedNotes) {
      note.onNoteCompleted.remove((noteData) => {
        this.sceneManager.sendCompleteNoteDataToBackend(noteData);
      });
    }
    this.notes = updatedNotes;

    // ============================================================
    // [DeleteCrashFix] NEW
    // updateNotes runs on every widget add/remove (incl. delete), so
    // this is the earliest deterministic point to refresh state. The
    // passed-in `widgets` are all alive, so their SceneObjects form the
    // authoritative live-note set. Rebuild it here, then scrub the FOV
    // tracking array by REFERENCE against that set: a deleted note's
    // object is no longer in the set, so it is dropped without ever
    // calling a native API on the destroyed handle. (The note's Widget
    // and Note components live on the same SceneObject, so this object
    // is exactly what the FOV overlap reports for that note.)
    // ============================================================
    const nextLiveNoteObjects = new Set<SceneObject>();
    for (const widget of widgets) {
      try {
        nextLiveNoteObjects.add(widget.getSceneObject());
      } catch (_) {
        // Widget mid-teardown; skip it.
      }
    }
    this.liveNoteObjects = nextLiveNoteObjects;

    this.prevLiveNotesObjInFOV = this.prevLiveNotesObjInFOV.filter((obj) =>
      this.liveNoteObjects.has(obj),
    );

    // Preset notes are never deleted by this flow, but keep the probe-based
    // scrub as a safety net in case a preset object is ever torn down.
    this.prevPresetNotesObjInFOV = this.prevPresetNotesObjInFOV.filter((obj) =>
      this.isSceneObjectAlive(obj),
    );
  }

  private updateAllNotesInFOV(
    overlap: OverlapEnterEventArgs | OverlapExitEventArgs,
  ) {
    // ============================================================
    // [DeleteCrashFix] NEW
    // The physics overlap set can still reference a just-deleted note's
    // collider/SceneObject. Resolving it (getSceneObject) or calling
    // getComponent() on it throws on a destroyed object. Build the list
    // defensively: skip any overlap whose object can't be safely read.
    // ============================================================
    const currAllNotesObjInFOV: SceneObject[] = [];
    for (const singleOverlap of overlap.currentOverlaps) {
      try {
        const obj = singleOverlap.collider.getSceneObject();
        if (this.isSceneObjectAlive(obj)) {
          currAllNotesObjInFOV.push(obj);
        }
      } catch (_) {
        // Destroyed/invalid collider left in the overlap set; skip it.
      }
    }

    const currLiveNotesObjInFOV = currAllNotesObjInFOV.filter(
      (obj) => obj.getComponent(Note.getTypeName()) !== undefined,
    );
    const currPresetNotesObjInFOV = currAllNotesObjInFOV.filter(
      (obj) => obj.getComponent(PresetNote.getTypeName()) !== undefined,
    );

    this.updateLiveNotesInFOV(currLiveNotesObjInFOV);
    this.updatePresetNotesInFOV(currPresetNotesObjInFOV);
  }

  private updateLiveNotesInFOV(currLiveNotesObjInFOV: SceneObject[]) {
    // ============================================================
    // [DeleteCrashFix] NEW
    // A note deleted while inside the FOV cone leaves its destroyed
    // SceneObject stranded in prevLiveNotesObjInFOV (destroying a
    // collider does not reliably emit onOverlapExit). On the next
    // overlap event - which fires reliably the moment the user spawns
    // the next note in view - the old diff below dereferenced that
    // destroyed object via getComponent() and crashed the lens.
    // Drop any dead objects from both the previous and current lists
    // BEFORE diffing/dereferencing so we never touch a destroyed note.
    // The `prev` list is filtered by REFERENCE against the authoritative
    // live-note set (no native call on a destroyed handle); `curr` comes
    // from current overlaps and is additionally guarded by the probe.
    // ============================================================
    const prevLiveNotesObjInFOV = this.prevLiveNotesObjInFOV.filter((obj) =>
      this.liveNoteObjects.has(obj),
    );
    currLiveNotesObjInFOV = currLiveNotesObjInFOV.filter((obj) =>
      this.isSceneObjectAlive(obj),
    );

    if (prevLiveNotesObjInFOV.length == 0) {
      this.prevLiveNotesObjInFOV = currLiveNotesObjInFOV;
      return;
    }

    const addedNotesObjInFOV = currLiveNotesObjInFOV.filter(
      (obj) => !prevLiveNotesObjInFOV.includes(obj),
    );
    const removedNotesObjInFOV = prevLiveNotesObjInFOV.filter(
      (obj) => !currLiveNotesObjInFOV.includes(obj),
    );

    // [DeleteCrashFix] NEW: defense-in-depth try/catch so a note destroyed
    // between overlap events can never crash the lens here.
    for (const note of addedNotesObjInFOV) {
      try {
        note.getComponent(Note.getTypeName())?.pullToForeground();
      } catch (_) {
        // Note destroyed between events; nothing to bring to foreground.
      }
    }
    for (const note of removedNotesObjInFOV) {
      try {
        note.getComponent(Note.getTypeName())?.pushToBackground();
      } catch (_) {
        // Note destroyed between events; nothing to push to background.
      }
    }
    this.prevLiveNotesObjInFOV = currLiveNotesObjInFOV;
  }

  private updatePresetNotesInFOV(currPresetNotesObjInFOV: SceneObject[]) {
    // ============================================================
    // [DeleteCrashFix] NEW
    // Same destroyed-object protection as updateLiveNotesInFOV: a
    // destroyed preset note left in prevPresetNotesObjInFOV would be
    // dereferenced on the next overlap event and crash the lens.
    // Filter out dead objects from both lists before diffing.
    // ============================================================
    const prevPresetNotesObjInFOV = this.prevPresetNotesObjInFOV.filter((obj) =>
      this.isSceneObjectAlive(obj),
    );
    currPresetNotesObjInFOV = currPresetNotesObjInFOV.filter((obj) =>
      this.isSceneObjectAlive(obj),
    );

    if (prevPresetNotesObjInFOV.length == 0) {
      this.prevPresetNotesObjInFOV = currPresetNotesObjInFOV;
      return;
    }

    const addedNotesObjInFOV = currPresetNotesObjInFOV.filter(
      (obj) => !prevPresetNotesObjInFOV.includes(obj),
    );
    const removedNotesObjInFOV = prevPresetNotesObjInFOV.filter(
      (obj) => !currPresetNotesObjInFOV.includes(obj),
    );

    // [DeleteCrashFix] NEW: defense-in-depth try/catch (see updateLiveNotesInFOV).
    for (const note of addedNotesObjInFOV) {
      try {
        note.getComponent(PresetNote.getTypeName())?.pullToForeground();
      } catch (_) {
        // Preset note destroyed between events; skip.
      }
    }
    for (const note of removedNotesObjInFOV) {
      try {
        note.getComponent(PresetNote.getTypeName())?.pushToBackground();
      } catch (_) {
        // Preset note destroyed between events; skip.
      }
    }
    this.prevPresetNotesObjInFOV = currPresetNotesObjInFOV;
  }

  // ============================================================
  // [DeleteCrashFix] NEW (v2 - reliable probe)
  // Validity check used before calling component APIs on any FOV-tracked
  // SceneObject. A note deleted via its delete button runs
  // sceneObject.destroy(); afterwards any native API call on that handle
  // throws and crashes the lens.
  //
  // NOTE: the previous version only read `isNull`, which does not exist
  // on SceneObject in this runtime (it returned undefined, so the check
  // always reported "alive" and never filtered the dead object). We now
  // actively PROBE the handle: getTransform() throws on a destroyed
  // object, so the catch is what actually detects destruction. `isNull`
  // is still honoured first for runtimes that expose it.
  // ============================================================
  private isSceneObjectAlive(obj: SceneObject): boolean {
    if (!obj) {
      return false;
    }
    try {
      if ((obj as unknown as { isNull?: boolean }).isNull === true) {
        return false;
      }
      // Probe a native accessor; this throws if the object was destroyed.
      obj.getTransform();
      return true;
    } catch (_) {
      return false;
    }
  }

  private tryAnchorNote(): boolean {
    const uxFeedbackController = this.sceneManager.uxFeedbackController;
    const shouldPlayDwellCancelledSfx = (): boolean => {
      return (
        this.wasFingerDwellIndicatorActive &&
        this.fingerDwellTimer > 0 &&
        this.fingerDwellTimer < this.fingerDwellingTimeThreshold
      );
    };
    const resetDwellState = () => {
      this.fingerDwellTimer = 0;
      this.wasFingerDwellIndicatorActive = false;
      uxFeedbackController.deactivateDwellIndicator();
    };

    if (this.rightHand.isTracked()) {
      const currHandPosition = this.rightHand.indexTip.position;
      const distance = currHandPosition.distance(this.prevHandPosition);
      this.prevHandPosition = currHandPosition;

      if (distance < this.fingerDwellRadius) {
        if (!this.wasFingerDwellIndicatorActive) {
          this.wasFingerDwellIndicatorActive = true;
          uxFeedbackController.activateDwellIndicator();
        }
        this.fingerDwellTimer += getDeltaTime();
        if (this.fingerDwellTimer >= this.fingerDwellingTimeThreshold) {
          resetDwellState();
          return true;
        }
        return false;
      }
    }

    if (shouldPlayDwellCancelledSfx()) {
      this.sceneManager.playDwellCancelledFeedback();
    }
    resetDwellState();
    return false;
  }

  private spawnANote() {
    this.deactivateCreationProcess();

    const spawnPosition = this.rightHand.indexTip.position;
    // Spawn a spatial note
    this.onNoteSpawnedEvent.invoke({
      widgetIndex: 0,
      position: spawnPosition,
      rotation: this.getSpawnRotation(spawnPosition),
      fromDwell: true,
    });

    this.sceneManager.sendProductViewToBackend().then((frozenFrame) => {
      this.segmentObjectsInView(frozenFrame);
    });
    this.enableCrop();
  }

  public segmentObjectsInView(frozenFrame: Texture | null) {
    if (this.notes.length === 0) return;

    // play start feedback
    const latestNote = this.notes[this.notes.length - 1];
    latestNote.playObjectSegmentationStartFeedback();

    print("...[NotesController] segmenting objects in view");
    this.sceneManager.objectSegmentator.segmentObjectsInView(frozenFrame).then(() => {
      // play end feedback
      latestNote.playObjectSegmentationEndFeedback();
      this.sceneManager.playCropCapturedFeedback();
    });
  }

  public spawnDebugNoteInEditor(spawnPositionOverride?: vec3): void {
    if (!global.deviceInfoSystem.isEditor()) {
      return;
    }

    this.deactivateCreationProcess();

    let spawnPosition: vec3;
    if (spawnPositionOverride) {
      spawnPosition = spawnPositionOverride;
    } else {
      const distance = Math.max(10, this.debugSpawnDistanceFromCamera);
      const cameraPosition = this.worldCameraTransform.getWorldPosition();
      spawnPosition = cameraPosition.add(
        this.worldCameraTransform.forward.uniformScale(distance),
      );
    }

    this.onNoteSpawnedEvent.invoke({
      widgetIndex: 0,
      position: spawnPosition,
      rotation: this.getSpawnRotation(spawnPosition),
      fromDwell: true,
      fromDebugSpawn: true,
    });

    if (this.debugSpawnRunsCaptureAndCrop) {
      this.sceneManager.sendProductViewToBackend();
      this.enableCrop();
    }

    print("--- Spawned debug note in editor");
  }

  private enableCrop() {
    if (!this.pictureController) {
      return;
    }
    this.pictureController.enableCrop();
  }

  private addCroppedImage(image: Texture) {
    if (this.notes.length === 0) {
      print("[NoteController] No spawned notes found for cropped image.");
      return;
    }

    const latestNote = this.notes[this.notes.length - 1];
    latestNote.setCroppedImage(image);
    this.sceneManager.playCropCapturedFeedback();
  }

  private addCropAISummary(summary: string) {
    if (this.notes.length === 0) {
      print(
        "[NoteController] No spawned notes found for cropped image summary.",
      );
      return;
    }

    const latestNote = this.notes[this.notes.length - 1];
    latestNote.setCroppedImageAISummary(summary);
  }

  private getSpawnRotation(spawnPosition: vec3): quat {
    const cameraPosition = this.worldCameraTransform.getWorldPosition();
    const distanceToCamera = spawnPosition.distance(cameraPosition);

    if (distanceToCamera < 0.001) {
      return this.rightHand.indexTip.rotation.multiply(
        this.getYawOffsetRotation(),
      );
    }

    const cameraFacingRotation = quat.lookAt(
      cameraPosition.sub(spawnPosition),
      vec3.up(),
    );
    return cameraFacingRotation.multiply(this.getYawOffsetRotation());
  }

  private getYawOffsetRotation(): quat {
    const yawRadians = (this.noteSpawnYawOffsetDegrees * Math.PI) / 180;
    return quat.angleAxis(yawRadians, vec3.up());
  }
}
