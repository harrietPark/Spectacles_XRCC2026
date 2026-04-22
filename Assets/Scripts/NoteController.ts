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
export class NoteController extends BaseScriptComponent {
    private onUserViewCapturedEvent = new Event<Texture>();
    public readonly onUserViewCaptured: PublicApi<Texture> = this.onUserViewCapturedEvent.publicApi();

    private onNoteSpawnedEvent = new Event<WidgetSelectionEvent>();
    public readonly onNoteSpawned: PublicApi<WidgetSelectionEvent> = this.onNoteSpawnedEvent.publicApi();

    // @input private camera: CameraModule;
    @input
    @allowUndefined
    private areaManager: AreaManager | undefined;
    @ui.group_start("Note Anchoring Setup")
    @input private HandDwellingTimeThreshold: number = 3; // in seconds
    @ui.group_end
    @ui.group_start("Crop to Photo")
    @input
    @allowUndefined
    private pictureController: PictureController | undefined;
    private camModule: CameraModule = require("LensStudio:CameraModule") as CameraModule
    @ui.group_end
    @ui.separator
    @ui.group_start("Spawn Rotation")
    @input
    @hint("Additional yaw offset so note front faces the user. 180 fixes back-facing note meshes.")
    private noteSpawnYawOffsetDegrees: number = 180;
    @ui.group_end

    // Hand tracking
    private handProvider: HandInputData = SIK.HandInputData
    private rightHand = this.handProvider.getHand("right")
    private worldCameraTransform = WorldCameraFinderProvider.getInstance().getTransform();
    private handDwellingTimer: number = 0;
    private prevHandPosition: vec3 = vec3.zero();
    private handMovementRadiusRange: number = 0.1; // in meters


    // State booleans
    private isNoteAnchoringActive: boolean = false;

    // State objects
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
        } else {
            print("[NoteController] pictureController is not assigned; crop flow is disabled.");
        }

        if (this.areaManager) {
            this.areaManager.onWidgetsUpdated.add(this.updateNotes.bind(this));
        } else {
            print("[NoteController] areaManager is not assigned; crop-to-latest-note sync is disabled.");
        }
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

    private tryAnchorNote() : boolean {
        if (this.rightHand.isTracked()) {
            const currHandPosition = this.rightHand.indexTip.position;

            const distance = currHandPosition.distance(this.prevHandPosition);
            this.prevHandPosition = currHandPosition;
            // print("--- DISTANCE: " + distance);
            if (distance < this.handMovementRadiusRange) {
                this.sceneManager.uxFeedbackController.activateDwellIndicator();

                this.handDwellingTimer += getDeltaTime();
                if (this.handDwellingTimer >= this.HandDwellingTimeThreshold) {
                    this.spawnNote();
                    this.handDwellingTimer = 0;
                    return true;
                }
                return false;
            }
            this.handDwellingTimer = 0;
            this.sceneManager.uxFeedbackController.deactivateDwellIndicator();
            return false;
        } else {
            this.handDwellingTimer = 0;
            this.sceneManager.uxFeedbackController.deactivateDwellIndicator();
            return false;
        }
    }

    private spawnNote() {
        print("--- Spawning note");
        const spawnPosition = this.rightHand.indexTip.position;
        // Spawn a spatial note
        this.onNoteSpawnedEvent.invoke({
            widgetIndex: 0,
            position: spawnPosition,
            rotation: this.getSpawnRotation(spawnPosition)
        });

        this.sceneManager.sendProductViewToBackend();
        this.enableCrop();
    }

    private updateNotes(widgets: Widget[]) {
        this.notes = [];
        for (let i = 0; i < widgets.length; i++) {
            const note = widgets[i].getSceneObject().getComponent(Note.getTypeName());
            if (note) {
                this.notes.push(note);
            }
        }
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
        const yawRadians = this.noteSpawnYawOffsetDegrees * Math.PI / 180;
        return quat.angleAxis(yawRadians, vec3.up());
    }

}