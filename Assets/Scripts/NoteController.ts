import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { AreaManager } from "Samples/Spatial_Persistence/SpatialPersistance/AreaManager";
import { WidgetSelectionEvent } from "Samples/Spatial_Persistence/SpatialPersistance/MenuUI/WidgetSelection";
import { Note } from "Samples/Spatial_Persistence/SpatialPersistance/Notes/Note";
import { Widget } from "Samples/Spatial_Persistence/SpatialPersistance/Widget";
import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import SIK from "SpectaclesInteractionKit.lspkg/SIK";
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event";

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
    @ui.group_start("Visual & Audio Feedback")
    @input private VisualRightIndexTipHighlight: SceneObject;
    // @input private VisualVisualRightIndexTipDwellingProgress: SceneObject;
    @ui.group_end

    // Hand tracking
    private handProvider: HandInputData = SIK.HandInputData
    private rightHand = this.handProvider.getHand("right")
    private handDwellingTimer: number = 0;
    private prevHandPosition: vec3 = vec3.zero();
    private handMovementRadiusRange: number = 0.1; // in meters

    // State booleans
    private isNoteAnchoringActive: boolean = false;

    private notes: Note[] = [];
    
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
        this.VisualRightIndexTipHighlight.enabled = true;
        // this.VisualVisualRightIndexTipDwellingProgress.enabled = true;
        this.isNoteAnchoringActive = true;
    }

    public deactivateCreationProcess() {
        this.VisualRightIndexTipHighlight.enabled = false;
        // this.VisualVisualRightIndexTipDwellingProgress.enabled = false;
        this.isNoteAnchoringActive = false;
    }

    private tryAnchorNote() : boolean {
        if (this.rightHand.isTracked()) {
            const currHandPosition = this.rightHand.indexTip.position;
            this.VisualRightIndexTipHighlight.getTransform().setWorldPosition(currHandPosition);

            const distance = currHandPosition.distance(this.prevHandPosition);
            this.prevHandPosition = currHandPosition;
            // print("--- DISTANCE: " + distance);
            if (distance < this.handMovementRadiusRange) {
                // this.VisualRightIndexTipHighlight.enabled = true;

                this.handDwellingTimer += getDeltaTime();
                if (this.handDwellingTimer >= this.HandDwellingTimeThreshold) {
                    this.handDwellingTimer = 0;
                    return true;
                }
            } else {
                // this.VisualVisualRightIndexTipDwellingProgress.enabled = false;
            }
        } else {
            this.handDwellingTimer = 0;
            return false;
        }
    }

    private spawnNote() {
        this.deactivateCreationProcess();

        // Spawn a spatial note
        this.onNoteSpawnedEvent.invoke({
            widgetIndex: 0,
            position: this.rightHand.indexTip.position,
            rotation: this.rightHand.indexTip.rotation
        });

        this.sendUserViewToBackend();
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

    private sendUserViewToBackend() {
        // // Capture camera texture
        // this.onUserViewCapturedEvent.invoke(this.PictureController.captureImage);

        // TODO: send camera texture and note ID to backend
    }

    private addCroppedImage(image: Texture) {
        if (this.notes.length === 0) {
            print("[NoteController] No spawned notes found for cropped image.");
            return;
        }

        const latestNote = this.notes[this.notes.length - 1];
        latestNote.setCroppedImage(image);
    }
}