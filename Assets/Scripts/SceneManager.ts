// ======================================================================
// [SnapCloudCapture] Changed: quiet camera capture is now owned by
// SnapCloudPinManager so the resulting image_url can be folded straight
// into the `pins` row it inserts on note completion. SnapCloudCaptureManager
// still exists as a file for fallback but its component should be disabled
// in the scene; leaving the import behind would just bind to a null
// singleton.
// ======================================================================
import { SnapCloudPinManager } from "./SnapCloudPinManager";
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";
import { SoundEffectsController } from "./SoundEffectsController";
// import { UXFeedbackController } from "./UXFeedbackController";
import { NotesController } from "./NotesController";
import { INoteData } from "./INoteData";

type UXFeedbackControllerApi = {
    activateIndexTipHighlight: () => void;
    deactivateIndexTipHighlight: () => void;
    activateDwellIndicator: () => void;
    deactivateDwellIndicator: () => void;
};

@component
export class SceneManager extends BaseScriptComponent {
    @ui.group_start("Controller References")
    @input
    @allowUndefined
    @hint("Assign UXFeedbackController component. Uses safe no-op fallback if missing or still compiling.")
    private uxFeedbackControllerComponent: BaseScriptComponent | undefined;
    @input
    @allowUndefined
    @hint("Optional centralized sound effects controller.")
    private soundEffectsController: SoundEffectsController | undefined;
    @input private NoteController: NotesController;
    @ui.group_end
    @ui.group_start("UI References")
    @input private buttonActivateNoteCreation: RoundButton;
    @ui.group_end
    @ui.separator
    @ui.group_start("Microphone Setup")
    @input
    @hint("If enabled, request microphone permission on lens start.")
    private requestMicrophonePermissionOnStart: boolean = true;
    @input
    @allowUndefined
    @hint("Assign the same microphone asset used by Note.ts to trigger permission prompt.")
    private microphoneAsset: AudioTrackAsset | undefined;
    @input
    @hint("How long to keep the mic open (seconds) before stopping warmup.")
    private microphoneWarmupDurationSeconds: number = 0.25;
    @ui.group_end
    private microphoneControl: MicrophoneAudioProvider | undefined;
    private didWarnMissingUxFeedbackController: boolean = false;

    private static instance;
    private readonly noopUxFeedbackController: UXFeedbackControllerApi = {
        activateIndexTipHighlight: () => {},
        deactivateIndexTipHighlight: () => {},
        activateDwellIndicator: () => {},
        deactivateDwellIndicator: () => {},
    };

    private onAwake() {
        if (!SceneManager.instance) {
            SceneManager.instance = this;
        } else {
            throw new Error("SceneManager already exists");
        }

        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    }

    private onStart() {
        // left hand menu button press to activate note creation process
        this.buttonActivateNoteCreation.onTriggerUp.add(this.activateNoteCreation.bind(this));
        this.requestMicrophonePermissionEarly();
    }

    public static getInstance(): SceneManager {
        if (!SceneManager.instance) {
            throw new Error("SceneManager not initialized");
        }
        return SceneManager.instance;
    }

    public get uxFeedbackController(): UXFeedbackControllerApi {
        const candidate = this.uxFeedbackControllerComponent as unknown as Partial<UXFeedbackControllerApi> | undefined;
        if (
            candidate &&
            typeof candidate.activateIndexTipHighlight === "function" &&
            typeof candidate.deactivateIndexTipHighlight === "function" &&
            typeof candidate.activateDwellIndicator === "function" &&
            typeof candidate.deactivateDwellIndicator === "function"
        ) {
            return candidate as UXFeedbackControllerApi;
        }

        if (!this.didWarnMissingUxFeedbackController) {
            this.didWarnMissingUxFeedbackController = true;
            print(
                "[SceneManager] uxFeedbackController is missing or not ready; using no-op fallback until component loads."
            );
        }
        return this.noopUxFeedbackController;
    }

    // ======================================================================
    // [SnapCloudCapture] Changed: delegate the quiet capture to
    // SnapCloudPinManager. It snapshots the camera, uploads the JPEG to
    // `specs-captures/captures/<session_id>/...`, and stashes the
    // resulting public URL so that when the matching Note is discovered
    // by SnapCloudPinManager's scene scan, it can be folded into the
    // eventual pins-row INSERT as `image_url`. No DB writes happen here.
    // ======================================================================
    public sendProductViewToBackend() {
        const pm = SnapCloudPinManager.getInstance();
        if (!pm) {
            print("[SceneManager] SnapCloudPinManager not in scene; capture skipped.");
            return;
        }
        pm.captureForNextNote();
    }

    public sendCompleteNoteDataToBackend(noteData: INoteData) {
        // TODO: send note data to backend
        print("--- sending complete note data to backend: \n" + JSON.stringify(noteData));
    }

    public playDwellCancelledFeedback(): void {
        this.soundEffectsController?.playDwellCancelled();
    }

    public playLoadingStartFeedback(): void {
        this.soundEffectsController?.playLoadingStart();
    }

    public playLoadingDoneFeedback(): void {
        this.soundEffectsController?.playLoadingDone();
    }

    public playCropCapturedFeedback(): void {
        this.soundEffectsController?.playCropCaptured();
    }

    private activateNoteCreation() {
        this.soundEffectsController?.playActivateDwell();
        this.NoteController.activateCreationProcess();
    }

    private deactivateNoteCreation() {
        this.NoteController.deactivateCreationProcess();
    }

    private requestMicrophonePermissionEarly(): void {
        if (!this.requestMicrophonePermissionOnStart) {
            return;
        }

        if (!this.microphoneAsset) {
            print("[SceneManager] microphoneAsset not assigned; skipping early microphone permission request.");
            return;
        }

        try {
            this.microphoneControl = this.microphoneAsset.control as MicrophoneAudioProvider;
            this.microphoneControl.start();

            const stopEvent = this.createEvent("DelayedCallbackEvent");
            stopEvent.bind(() => {
                this.microphoneControl?.stop();
            });
            stopEvent.reset(Math.max(0.05, this.microphoneWarmupDurationSeconds));
        } catch (_error) {
            print("[SceneManager] Failed to request microphone permission at startup.");
        }
    }

}
