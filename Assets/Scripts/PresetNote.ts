import { BreathingAnimation } from "./Utils/BreathingAnimation";

@component
export class PresetNote extends BaseScriptComponent {
    @ui.group_start("Visual Settings")
    @input private foregroundScaleDifference: number = 0.1;
    @input private foregroundDurationMs: number = 1000;
    @input private backgroundScaleDifference: number = 0.05;
    @input private backgroundDurationMs: number = 2000;
    @ui.group_end

    private breathingAnimation: BreathingAnimation;

    private onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart() {
        this.breathingAnimation = this.sceneObject.getComponent(BreathingAnimation.getTypeName());
    }

    public pullToForeground() {
        this.breathingAnimation.scaleDifference = this.foregroundScaleDifference;
        this.breathingAnimation.durationMs = this.foregroundDurationMs;
        this.breathingAnimation.refreshAnimation();

    }

    public pushToBackground() {
        this.breathingAnimation.scaleDifference = this.backgroundScaleDifference;
        this.breathingAnimation.durationMs = this.backgroundDurationMs;
        this.breathingAnimation.refreshAnimation();
    }
}
