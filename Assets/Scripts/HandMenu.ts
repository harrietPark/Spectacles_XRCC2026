import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider";
import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import { HandType } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandType";
import TrackedHand from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/TrackedHand";
import type Tween from "LSTween.lspkg/TweenJS/Tween";
import { TweenAnimations } from "Scripts/Utils/TweenAnimation";
import { ExponentialMovingAverage } from "Scripts/Utils/ExponentialMovingAverage";

@component
export class HandMenu extends BaseScriptComponent {
    @input
    @widget(new ComboBoxWidget([new ComboBoxItem("Palm Menu", 0), new ComboBoxItem("Back Menu", 1)]))
    private menuType: number = 0;

    @ui.group_start("Menu Visibility")
    @input
    private maxAngleToCamera: number = 20;
    @input private maxNoTrackCount: number = 10;
    @ui.group_end
    @ui.separator
    @ui.group_start("Menu Trasnform")
    @input
    private uiContainer: SceneObject;
    @input private distanceToHandOnXAxis: number = 5; // distance in centimeter to hand on hand's local X axis
    @input private distanceToHandOnZAxis: number = 1; // distance in centimeter to hand on hand's local Z axis
    @ui.group_end
    private handProvider: HandInputData = HandInputData.getInstance();
    private leftHand: TrackedHand = this.handProvider.getHand("left" as HandType);
    private camera: WorldCameraFinderProvider = WorldCameraFinderProvider.getInstance();
    private noTrackCount: number = 0;
    private isShown: boolean = false;
    private shouldShow: boolean = false;
    private tween: Tween;
    private ema: ExponentialMovingAverage;

    private onAwake(): void {
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
        this.uiContainer.enabled = false;
        this.ema = new ExponentialMovingAverage(0.5);
    }

    private onUpdate(): void {
        if (this.tryShowHandMenu(this.leftHand)) {
            this.shouldShow = true;
            this.noTrackCount = 0;
        } else {
            this.noTrackCount++;
            if (this.noTrackCount > this.maxNoTrackCount) {
                this.shouldShow = false;
            }
        }

        if (this.isShown != this.shouldShow) {
            if (this.tween?.isPlaying()) this.tween.stop();
            this.tween = TweenAnimations.tweenOnOff(
                this.uiContainer,
                this.shouldShow,
                200,
                vec3.zero(),
                vec3.one(),
            );
        }
        this.isShown = this.shouldShow;
    }

    private tryShowHandMenu(hand: TrackedHand): boolean {
        if (this.determineIfHandMenuVisible(hand, this.menuType)) {
            this.updateHandMenuTransform(hand, this.menuType, hand.pinkyKnuckle.position);
            return true;
        }
        return false;
    }

    private determineIfHandMenuVisible(hand: TrackedHand, menuType: number): boolean {
        if (!hand.isTracked()) return false;

        // if palm menu type, take the palm normal, otherwise take the back normal
        const handNormal = menuType == 0 ? hand.indexKnuckle.forward : hand.indexKnuckle.back;
        const cameraForward = this.camera.getTransform().forward;
        const angle =
            (Math.acos(handNormal.dot(cameraForward) / (handNormal.length * cameraForward.length)) * 180.0) / Math.PI;
        if (Math.abs(angle) > this.maxAngleToCamera) {
            return false;
        }
        return true;
    }

    private updateHandMenuTransform(hand: TrackedHand, menuType: number, anchorPos: vec3) {
        const directionToHandOnXAxis = menuType === 0 ? hand.indexKnuckle.right : hand.indexKnuckle.left;
        const directionToHandOnZAxis = menuType === 0 ? hand.indexKnuckle.forward : hand.indexKnuckle.back;
        const rotation =
            menuType == 0
                ? hand.indexKnuckle.rotation
                : hand.indexKnuckle.rotation.multiply(quat.angleAxis(Math.PI, vec3.up()));
        this.uiContainer.getTransform().setWorldRotation(rotation);
        // calculate smoothened menu world position
        const currMenuWorldPos = this.ema.process(
            anchorPos
                .add(directionToHandOnXAxis.mult(vec3.one().uniformScale(this.distanceToHandOnXAxis)))
                .add(directionToHandOnZAxis.mult(vec3.one().uniformScale(this.distanceToHandOnZAxis))),
        );
        this.uiContainer.getTransform().setWorldPosition(currMenuWorldPos);
    }
}