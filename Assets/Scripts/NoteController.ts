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
    @input private areaManager: AreaManager;
    @ui.group_start("Note Anchoring Setup")
    @input private HandDwellingTimeThreshold: number = 3; // in seconds
    @ui.group_end
    @ui.group_start("Crop to Photo")
    @input private pictureController: PictureController;
    @ui.group_end
    @ui.separator
    @ui.group_start("Visual Feedback")
    @input private MidasTouchVisual: SceneObject;
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
        this.pictureController.onCropEnd.add(this.addCroppedImage.bind(this));
        this.areaManager.onWidgetsUpdated.add(this.updateNotes.bind(this));
    }

    private onUpdate() {
        if (this.isNoteAnchoringActive) {
            if (this.tryAnchorNote()) {
                this.anchorNote();
            }
        }
    }

    public activateCreationProcess() {
        this.activateNoteAnchoringVisual();
        this.isNoteAnchoringActive = true;
    }

    public deactivateCreationProcess() {
        this.deactivateNoteAnchoringVisual();
        this.isNoteAnchoringActive = false;
    }

    private tryAnchorNote() : boolean {
        if (this.rightHand.isTracked()) {
            const currHandPosition = this.rightHand.indexTip.position;
            const distance = currHandPosition.distance(this.prevHandPosition);
            this.prevHandPosition = currHandPosition;
            // print("DISTANCE: " + distance);
            if (distance < this.handMovementRadiusRange) {
                this.MidasTouchVisual.getTransform().setLocalScale(vec3.one().uniformScale(5));
                this.handDwellingTimer += getDeltaTime();
                if (this.handDwellingTimer >= this.HandDwellingTimeThreshold) {
                    this.handDwellingTimer = 0;
                    return true;
                }
            }
        } else {
            this.handDwellingTimer = 0;
            this.MidasTouchVisual.getTransform().setLocalScale(vec3.one().uniformScale(3));
            return false;
        }
    }

    private anchorNote() {
        // Spawn a spatial note
        this.onNoteSpawnedEvent.invoke({
            widgetIndex: 0,
            position: this.rightHand.indexTip.position,
            rotation: this.rightHand.indexTip.rotation
        });

        this.deactivateCreationProcess();
        this.enableCrop();

        // // Capture camera texture
        // this.onUserViewCapturedEvent.invoke(this.PictureController.captureImage);
    }

    private updateNotes(widgets: Widget[]) {
        this.notes = widgets.map(widget => widget.getSceneObject().getComponent(Note.getTypeName()));
    }

    private enableCrop() {
        this.pictureController.enableCrop();
    }

    private addCroppedImage(image: Texture) {
        print("----- Note Controller: " + image.getWidth());
        if(this.notes.length == 0) return;
        
        this.notes[this.notes.length - 1].setCroppedImage(image);
    }

    private activateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = true;

    }

    private deactivateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = false;
    }
}