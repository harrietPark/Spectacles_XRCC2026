import {HandInputData} from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData"
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";

@component
export class SceneManager extends BaseScriptComponent {
    private handProvider: HandInputData = SIK.HandInputData
    private leftHand = this.handProvider.getHand("left")
    private rightHand = this.handProvider.getHand("right")

    private static instance;


    public static getInstance(): SceneManager {
        if (!SceneManager.instance) {
            throw new Error("SceneManager not initialized");
        }
        return SceneManager.instance;
    }

    private onAwake() {
        if (!SceneManager.instance) {
            SceneManager.instance = this;
        } else {
            throw new Error("SceneManager already exists");
        }

        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private onStart() {
        // left hand pinch down to activate note creation process
        this.leftHand.onPinchDown.add(this.activateNoteCreation.bind(this));
    }

    private onUpdate() {}

    private activateNoteCreation() {
        print("... Activating note creation process");
    }

}
