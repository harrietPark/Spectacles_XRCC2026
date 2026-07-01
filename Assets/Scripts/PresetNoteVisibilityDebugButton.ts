import { RoundButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton";
import { PresetNote } from "./PresetNote";

@component
export class PresetNoteVisibilityDebugButton extends BaseScriptComponent {
  @input
  @allowUndefined
  @hint("RoundButton that toggles the preset note open/closed state.")
  private debugButton: RoundButton | undefined;

  @input
  @allowUndefined
  @hint("Preset note to test (assign the PresetNote component on p_Preset_Note).")
  private presetNote: PresetNote | undefined;

  @input
  @hint("If true, starts in the open (foreground) state.")
  private startOpen: boolean = true;

  private isOpen: boolean = true;

  private onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
  }

  private onStart(): void {
    if (!this.debugButton || !this.presetNote) {
      print(
        "[PresetNoteVisibilityDebugButton] Assign debugButton and presetNote in the Inspector.",
      );
      return;
    }

    this.isOpen = this.startOpen;
    this.applyState(false);

    this.debugButton.onTriggerUp.add(() => {
      this.isOpen = !this.isOpen;
      this.applyState(true);
    });
  }

  private applyState(log: boolean): void {
    if (!this.presetNote) {
      return;
    }

    if (this.isOpen) {
      this.presetNote.pullToForeground();
    } else {
      this.presetNote.pushToBackground();
    }

    if (log) {
      print(
        `[PresetNoteVisibilityDebugButton] ${this.isOpen ? "OPEN" : "CLOSED"}`,
      );
    }
  }
}
