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
    @input private fovCollider: ColliderComponent;
    @ui.group_end
    @ui.group_start("Spawn Rotation")
    @input
    @hint("Additional yaw offset so note front faces the user. 180 fixes back-facing note meshes.")
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
    private worldCameraTransform = WorldCameraFinderProvider.getInstance().getTransform();
    private fingerDwellTimer: number = 0;
    private prevHandPosition: vec3 = vec3.zero();

    // User looks away and notes minimised
    private prevNotesObjInFOV: SceneObject[] = [];

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
            this.pictureController.onCropAISummarised.add(this.addCropAISummary.bind(this));
        } else {
            print("[NoteController] pictureController is not assigned; crop flow is disabled.");
        }

        if (this.areaManager) {
            this.areaManager.onWidgetsUpdated.add(this.updateNotes.bind(this));
        } else {
            print(
                "[NoteController] areaManager is not assigned; crop-to-latest-note sync is disabled.",
            );
        }

        // Setup FOV collider to only detect overlap with Notes
        const notesFilter = Physics.Filter.create();
        notesFilter.onlyLayers = LayerSet.fromNumber(1);
        this.fovCollider.overlapFilter = notesFilter;
        this.fovCollider.onOverlapStay.add((OverlapStayEventArgs) => this.updateNotesInFOV(OverlapStayEventArgs))

    }

    private onUpdate() {
        if (this.isNoteAnchoringActive) {
            if (this.tryAnchorNote()) {
                this.spawnNote();
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

        const addedNotes = updatedNotes.filter((note) => !this.notes.includes(note));
        for (const note of addedNotes) {
            note.onNoteCompleted.add((noteData) => {
                this.sceneManager.sendCompleteNoteDataToBackend(noteData);
            });
        }

        const removedNotes = this.notes.filter((note) => !updatedNotes.includes(note));
        for (const note of removedNotes) {
            note.onNoteCompleted.remove((noteData) => {
                this.sceneManager.sendCompleteNoteDataToBackend(noteData);
            });
        }
        this.notes = updatedNotes;
    }

    private updateNotesInFOV(overlap: OverlapStayEventArgs) {
        if (this.prevNotesObjInFOV.length == 0) {
            this.prevNotesObjInFOV = overlap.currentOverlaps.map((overlap)=> overlap.collider.getSceneObject());
            return;
        }
        const currNotesObjInFOV = overlap.currentOverlaps.map((overlap)=> overlap.collider.getSceneObject());
        const addedNotesObjInFOV = currNotesObjInFOV.filter((obj) => !this.prevNotesObjInFOV.includes(obj));
        const removedNotesObjInFOV = this.prevNotesObjInFOV.filter((obj) => !currNotesObjInFOV.includes(obj));
        for (const note of addedNotesObjInFOV) {
            note.getComponent(Note.getTypeName())?.pullToForeground();
        }
        for (const note of removedNotesObjInFOV) {
            note.getComponent(Note.getTypeName())?.pushToBackground();
        }
        this.prevNotesObjInFOV = currNotesObjInFOV;
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

    private spawnNote() {
        this.deactivateCreationProcess();

        const spawnPosition = this.rightHand.indexTip.position;
        // Spawn a spatial note
        this.onNoteSpawnedEvent.invoke({
            widgetIndex: 0,
            position: spawnPosition,
            rotation: this.getSpawnRotation(spawnPosition),
            fromDwell: true,
        });

        this.sceneManager.sendProductViewToBackend();
        this.enableCrop();

        print("--- Spawned a note");
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
            print("[NoteController] No spawned notes found for cropped image summary.");
            return;
        }

        const latestNote = this.notes[this.notes.length - 1];
        latestNote.setCroppedImageAISummary(summary);
    }

    private getSpawnRotation(spawnPosition: vec3): quat {
        const cameraPosition = this.worldCameraTransform.getWorldPosition();
        const distanceToCamera = spawnPosition.distance(cameraPosition);

        if (distanceToCamera < 0.001) {
            return this.rightHand.indexTip.rotation.multiply(this.getYawOffsetRotation());
        }

        const cameraFacingRotation = quat.lookAt(cameraPosition.sub(spawnPosition), vec3.up());
        return cameraFacingRotation.multiply(this.getYawOffsetRotation());
    }

    private getYawOffsetRotation(): quat {
        const yawRadians = (this.noteSpawnYawOffsetDegrees * Math.PI) / 180;
        return quat.angleAxis(yawRadians, vec3.up());
    }
}
