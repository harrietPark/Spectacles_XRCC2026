import { BreathingAnimation } from "./Utils/BreathingAnimation";

@component
export class PresetNote extends BaseScriptComponent {
    private breathingAnimation: BreathingAnimation;

    private onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart() {
        this.breathingAnimation = this.sceneObject.getComponent(BreathingAnimation.getTypeName());
    }

    public pullToForeground() {

    }

    public pushToBackground() {

    }
}
