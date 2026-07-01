import Easing from "LSTween.lspkg/TweenJS/Easing";
import { LSTween } from "LSTween.lspkg/Examples/Scripts/LSTween";
import type Tween from "LSTween.lspkg/TweenJS/Tween";

@component
export class BreathingAnimation extends BaseScriptComponent {
    @input public scaleDifference: number = 0.1;
    @input public durationMs: number = 1000;

    private transform: Transform;
    private maxScale: vec3;
    private minScale: vec3;
    private baseScale: vec3;

    private currentTween: Tween | null = null;
    private destroyed: boolean = false;

    onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
        this.createEvent("OnDestroyEvent").bind(this.onDestroyed.bind(this));
    }

    private onDestroyed() {
        // Stop the in-flight tween so its onComplete chain can't keep scaling a
        // destroyed transform (which throws "Object is null" in the tween loop).
        this.destroyed = true;
        if (this.currentTween) {
            this.currentTween.stop();
            this.currentTween = null;
        }
    }

    private onStart() {
        this.transform = this.sceneObject.getTransform();
        this.baseScale = this.transform.getLocalScale();

        this.refreshAnimation();
        this.startAnimation();
    }

    public refreshAnimation() {
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
        if (this.destroyed) return;
        this.currentTween = LSTween.scaleFromToLocal(this.transform, this.minScale, this.maxScale, this.durationMs)
        .easing(Easing.Quadratic.InOut)
        .onComplete(this.breathOut.bind(this))
        .start();
    }

    private breathOut() {
        if (this.destroyed) return;
        this.currentTween = LSTween.scaleFromToLocal(this.transform, this.maxScale, this.minScale, this.durationMs)
        .easing(Easing.Quadratic.InOut)
        .onComplete(this.breathIn.bind(this))
        .start();
    }
}
