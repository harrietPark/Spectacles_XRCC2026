import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { WidgetSelectionEvent } from "Samples/Spatial_Persistence/SpatialPersistance/MenuUI/WidgetSelection";
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
    @ui.group_start("Note Anchoring Setup")
    @input private HandDwellingTimeThreshold: number = 3; // in seconds
    @ui.group_end
    @ui.group_start("Crop to Photo")
    @input private PictureController: PictureController;
    @ui.group_end
    @ui.separator
    @ui.group_start("Visual Feedback")
    @input private MidasTouchVisual: SceneObject;
    @ui.group_end

    private handProvider: HandInputData = SIK.HandInputData
    private rightHand = this.handProvider.getHand("right")
    private handDwellingTimer: number = 0;
    private prevHandPosition: vec3 = vec3.zero();
    private handMovementRadiusRange: number = 0.1; // in meters

    private isNoteAnchoringActive: boolean = false;

    public activateCreationProcess() {
        this.activateNoteAnchoringVisual();
        this.isNoteAnchoringActive = true;
    }

    public deactivateCreationProcess() {
        this.deactivateNoteAnchoringVisual();
        this.isNoteAnchoringActive = false;
    }
    
    private onAwake() {
        this.deactivateCreationProcess();
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private onUpdate() {
        if (this.isNoteAnchoringActive) {
            if (this.tryAnchorNote()) {
                this.anchorNote();
            }
        }
    }

    private activateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = true;
    }

    private deactivateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = false;
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

    private enableCrop() {
        this.PictureController.enableCrop();
    }
}