import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { SceneManager } from "./SceneManager";

@component
export class NoteController extends BaseScriptComponent {
    @ui.group_start("Crop to Photo")
    @input private PictureController: PictureController;
    @ui.group_end
    @ui.separator
    @ui.group_start("Visual Feedback")
    @input private MidasTouchVisual: SceneObject;
    @ui.group_end

    public activateCreationProcess() {
        this.activateNoteAnchoringVisual();
        this.PictureController.enableCrop();
    }

    public deactivateCreationProcess() {
        this.deactivateNoteAnchoringVisual();
        this.PictureController.disableCrop();
    }
    
    private onAwake() {
        this.deactivateNoteAnchoringVisual();
    }

    private activateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = true;
    }

    private deactivateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = false;
    }

}