// ======================================================================
// [SnapCloudCapture] Added: quiet camera capture uploader. Used below in
// sendProductViewToBackend() to push a single frame to the
// `specs-captures/captures/<session_id>/` folder on note-spawn.
// ======================================================================
import { SnapCloudCaptureManager } from "./SnapCloudCaptureManager";
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

    public sendProductViewToBackend() {
        const cap = SnapCloudCaptureManager.getInstance();
        if (!cap) {
            print("[SceneManager] SnapCloudCaptureManager not in scene; capture skipped.");
            return;
        }
        cap.captureAndUpload((url) => {
            print(`[SceneManager] product view uploaded -> ${url || "(failed)"}`);
        });
    }

    public sendCompleteNoteDataToBackend(noteData: INoteData) {
        // TODO: send note data to backend
        print("--- sending complete note data to backend: \n" + JSON.stringify(noteData));
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
