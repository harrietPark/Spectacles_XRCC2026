import { LSTween } from "LSTween.lspkg/Examples/Scripts/LSTween";
import Easing from "LSTween.lspkg/TweenJS/Easing";
import type Tween from "LSTween.lspkg/TweenJS/Tween";

export class TweenAnimations {
    public static tweenOnOff(
        object: SceneObject,
        toTurnOn: boolean,
        duration: number = 200,
        startScale: vec3 = vec3.zero(),
        endScale: vec3 = vec3.one(),
        onAudioTrack?: AudioTrackAsset,
        offAudioTrack?: AudioTrackAsset,
        audioComponent?: AudioComponent,
    ): Tween {
        return LSTween.scaleFromToLocal(
            object.getTransform(),
            toTurnOn ? startScale : endScale,
            toTurnOn ? endScale : startScale,
            duration,
        )
            .easing(Easing.Quadratic.Out)
            .onStart(() => {
                if (toTurnOn) {
                    object.enabled = true;
                    if (audioComponent && onAudioTrack) {
                        audioComponent.audioTrack = onAudioTrack;
                        audioComponent.play(1);
                    }
                } else {
                    if (audioComponent && offAudioTrack) {
                        audioComponent.audioTrack = offAudioTrack;
                        audioComponent.play(1);
                    }
                }
            })
            .onComplete(() => {
                if (!toTurnOn) {
                    object.enabled = false;
                }
            })
            .start();
    }
}