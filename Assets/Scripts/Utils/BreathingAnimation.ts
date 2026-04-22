import Easing from "LSTween.lspkg/TweenJS/Easing";
import { LSTween } from "LSTween.lspkg/Examples/Scripts/LSTween";

@component
export class BreathingAnimation extends BaseScriptComponent {
    onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart() {
        this.startAnimation();
    }

    private startAnimation() {
        const transform = this.getTransform();
        const baseScale = transform.getLocalScale();
        const maxScale = new vec3(baseScale.x * 1.1, baseScale.y * 1.1, baseScale.z * 1.1);
        const minScale = new vec3(baseScale.x * 0.9, baseScale.y * 0.9, baseScale.z * 0.9);

        const durationMs = 1000;

        const animateUp = () => {
            LSTween.scaleFromToLocal(transform, minScale, maxScale, durationMs)
                .easing(Easing.Quadratic.InOut)
                .onComplete(animateDown)
                .start();
        };

        const animateDown = () => {
            LSTween.scaleFromToLocal(transform, maxScale, minScale, durationMs)
                .easing(Easing.Quadratic.InOut)
                .onComplete(animateUp)
                .start();
        };

        transform.setLocalScale(minScale);
        animateUp();
    }

}
