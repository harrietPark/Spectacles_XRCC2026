import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import SIK from "SpectaclesInteractionKit.lspkg/SIK";

@component
export class NoteController extends BaseScriptComponent {
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
    private handMovementRadiusRange: number = 0.05; // in meters

    private isNoteAnchoringActive: boolean = false;

    public activateCreationProcess() {
        this.activateNoteAnchoringVisual();
        this.isNoteAnchoringActive = true;
        this.PictureController.enableCrop();
    }

    public deactivateCreationProcess() {
        this.deactivateNoteAnchoringVisual();
        this.isNoteAnchoringActive = false;
        this.PictureController.disableCrop();
    }
    
    private onAwake() {
        this.deactivateNoteAnchoringVisual();
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
                this.handDwellingTimer += getDeltaTime();
                if (this.handDwellingTimer >= this.HandDwellingTimeThreshold) {
                    return true;
                }
            }
        } else {
            this.handDwellingTimer = 0;
            return false;
        }
    }

    private anchorNote() {
        print("... Anchoring note");
    }

}