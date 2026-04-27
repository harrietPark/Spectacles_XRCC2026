import Easing from "LSTween.lspkg/TweenJS/Easing";
import { LSTween } from "LSTween.lspkg/Examples/Scripts/LSTween";

@component
export class BreathingAnimation extends BaseScriptComponent {
    @input public scaleDifference: number = 0.1;
    @input public durationMs: number = 1000;

    private transform: Transform;
    private maxScale: vec3;
    private minScale: vec3;
    private baseScale: vec3;

    onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart() {
        this.transform = this.sceneObject.getTransform();
        this.baseScale = this.transform.getLocalScale();

        this.refreshAnimation();
        this.startAnimation();
    }

    private refreshAnimation() {
        this.maxScale = new vec3(
            this.baseScale.x * (1 + this.scaleDifference),
            this.baseScale.y * (1 + this.scaleDifference),
            this.baseScale.z * (1 + this.scaleDifference),
        );
        this.minScale = new vec3(
            this.baseScale.x * (1 - this.scaleDifference),
            this.baseScale.y * (1 - this.scaleDifference),
            this.baseScale.z * (1 - this.scaleDifference),
        );   
    }

    private startAnimation() {
        this.transform.setLocalScale(this.minScale);
        this.breathIn();
    }

    private breathIn() {
        LSTween.scaleFromToLocal(this.transform, this.minScale, this.maxScale, this.durationMs)
        .easing(Easing.Quadratic.InOut)
        .onComplete(this.breathOut.bind(this))
        .start();
    }

    private breathOut() {
        LSTween.scaleFromToLocal(this.transform, this.maxScale, this.minScale, this.durationMs)
        .easing(Easing.Quadratic.InOut)
        .onComplete(this.breathIn.bind(this))
        .start();
    }
}
