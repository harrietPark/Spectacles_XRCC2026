import { PinPointNoteSimpleVisibilityToggle } from "./PinPointNoteSimpleVisibilityToggle";
import { BreathingAnimation } from "./Utils/BreathingAnimation";

@component
export class PresetNote extends BaseScriptComponent {
  @ui.group_start("Visibility (head movement)")
  @input
  @allowUndefined
  @hint("Hides/shows open note content on look away (same as PinPoint voice note).")
  private visibilityToggle: PinPointNoteSimpleVisibilityToggle | undefined;

  @input
  @allowUndefined
  @hint("Closed-state visual (e.g. p_preset_note_closed root). Shown when user looks away.")
  private closedVisualRoot: SceneObject | undefined;
  @ui.group_end

  @ui.group_start("Visual Settings")
  @input private foregroundScaleDifference: number = 0.1;
  @input private foregroundDurationMs: number = 1000;
  @input private backgroundScaleDifference: number = 0.05;
  @input private backgroundDurationMs: number = 2000;
  @ui.group_end

  private breathingAnimation: BreathingAnimation | undefined;

  private onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
  }

  private onStart() {
    this.breathingAnimation = this.sceneObject.getComponent(
      BreathingAnimation.getTypeName(),
    );
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = false;
    }
  }

  public pullToForeground() {
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = false;
    }
    this.visibilityToggle?.show();
    this.applyBreathingForeground();
  }

  public pushToBackground() {
    this.visibilityToggle?.hide();
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = true;
    }
    this.applyBreathingBackground();
  }

  private applyBreathingForeground() {
    if (!this.breathingAnimation) {
      return;
    }
    this.breathingAnimation.scaleDifference = this.foregroundScaleDifference;
    this.breathingAnimation.durationMs = this.foregroundDurationMs;
    this.breathingAnimation.refreshAnimation();
  }

  private applyBreathingBackground() {
    if (!this.breathingAnimation) {
      return;
    }
    this.breathingAnimation.scaleDifference = this.backgroundScaleDifference;
    this.breathingAnimation.durationMs = this.backgroundDurationMs;
    this.breathingAnimation.refreshAnimation();
  }
}
