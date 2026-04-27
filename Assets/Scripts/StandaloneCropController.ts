import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { setTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils";

/**
 * Standalone crop trigger.
 *
 * Replaces the notes-coupled crop arming that used to live in NotesController.
 * Once wired to the existing PictureController, the user can perform the
 * two-hand pinch + thumbs-close gesture at any time during the experience to
 * spawn the Scanner prefab and capture a cropped image.
 *
 * The Snap Cloud (Supabase) upload still happens inside
 * PictureBehavior.processImage(), so no additional plumbing is required for
 * Storage / `captures` table writes.
 *
 * Public API (callable from a button, voice command, hand menu, etc.):
 *   - arm()    : enable crop so the next two-hand pinch spawns a scanner.
 *   - disarm() : block crop temporarily (e.g. while a modal UI is open).
 */
@component
export class StandaloneCropController extends BaseScriptComponent {
    @input
    @allowUndefined
    @hint("PictureController instance that owns the two-hand pinch detection and Scanner prefab spawn.")
    private pictureController: PictureController | undefined;

    @ui.separator
    @ui.group_start("Behaviour")
    @input
    @hint("Arm crop automatically when the lens starts so the user can trigger it at any time.")
    private autoArmOnStart: boolean = true;

    @input
    @hint("Re-arm crop automatically after each successful capture so the user can crop repeatedly.")
    private rearmAfterCapture: boolean = true;

    @input
    @hint("Delay (in seconds) before re-arming after a capture. Lets the ChatGPT request and Snap Cloud upload finish before another crop is taken.")
    @widget(new SliderWidget(0, 10, 0.5))
    private rearmDelaySeconds: number = 2.5;
    @ui.group_end

    @ui.separator
    @ui.group_start("Debug")
    @input
    @hint("Print verbose logs (arm / disarm / capture) to help debug timing.")
    private debugLogging: boolean = true;
    @ui.group_end

    private isArmed: boolean = false;

    private onAwake(): void {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart(): void {
        if (!this.pictureController) {
            print("[StandaloneCropController] No PictureController assigned. Standalone crop disabled.");
            return;
        }

        this.pictureController.onCropEnd.add(this.handleCropEnd);

        if (this.autoArmOnStart) {
            this.arm();
        }
    }

    /**
     * Arm the next crop. The user can then perform the two-hand pinch +
     * thumbs-close gesture to spawn the Scanner prefab. Idempotent — calling
     * while already armed is a no-op (PictureController.enableCrop() just
     * sets a boolean).
     */
    public arm(): void {
        if (!this.pictureController) {
            return;
        }
        this.pictureController.enableCrop();
        this.isArmed = true;
        if (this.debugLogging) {
            print("[StandaloneCropController] Crop armed.");
        }
    }

    /**
     * Block the next crop attempt. Useful when a modal UI / cinematic is
     * playing and you don't want stray pinches to capture. Idempotent.
     */
    public disarm(): void {
        if (!this.pictureController) {
            return;
        }
        this.pictureController.disableCrop();
        this.isArmed = false;
        if (this.debugLogging) {
            print("[StandaloneCropController] Crop disarmed.");
        }
    }

    /** Returns true if the next two-hand pinch will spawn a Scanner. */
    public isCropArmed(): boolean {
        return this.isArmed;
    }

    private handleCropEnd = (_image: Texture): void => {
        if (this.debugLogging) {
            print("[StandaloneCropController] Crop captured. Snap Cloud upload running inside PictureBehavior.");
        }

        this.isArmed = false;

        if (!this.rearmAfterCapture) {
            return;
        }

        const delayMs = Math.max(0, this.rearmDelaySeconds) * 1000;
        setTimeout(() => this.arm(), delayMs);
    };
}
