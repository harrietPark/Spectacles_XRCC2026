import { NotesController } from "./NotesController";
import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";
import { UXFeedbackController } from "./UXFeedbackController";

@component
export class SceneManager extends BaseScriptComponent {
    @ui.group_start("Controller References")
    @input public uxFeedbackController: UXFeedbackController;
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

    private static instance;

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

    public sendProductViewToBackend() {
        // // Capture camera texture
        // this.onUserViewCapturedEvent.invoke(this.PictureController.captureImage);

        // TODO: send camera texture and note ID to backend
    }

    private activateNoteCreation() {
        print("--- Activating note creation process");
        this.NoteController.activateCreationProcess();
    }

    private deactivateNoteCreation() {
        print("--- Deactivating note creation process");
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
