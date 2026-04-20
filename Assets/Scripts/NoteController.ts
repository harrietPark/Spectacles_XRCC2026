import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { SceneManager } from "./SceneManager";

@component
export class NoteController extends BaseScriptComponent {
    @input private PictureController: PictureController;

    public activateCreationProcess() {
        this.PictureController.enableCrop();
    }

    public deactivateCreationProcess() {
        this.PictureController.disableCrop();
    }
    
    private onAwake() {}

}