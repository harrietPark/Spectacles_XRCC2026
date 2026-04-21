import {ToggleButton} from "SpectaclesInteractionKit.lspkg/Components/UI/ToggleButton/ToggleButton"

@component
export class PinPointNoteSimpleVisibilityToggle extends BaseScriptComponent {
  @input
  @hint("Pin toggles that trigger visibility changes (e.g. BluePin + RedPin).")
  private pinToggleButtons: ToggleButton[] = []

  @input
  @allowUndefined
  @hint("Single root object to hide/show (recommended: NoteObjects).")
  private noteObjectsRoot: SceneObject | undefined

  @input
  @hint("If true, note objects start visible. If false, hidden.")
  private startVisible: boolean = true

  private isVisible: boolean = true
  private isReady: boolean = false

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  private onStart(): void {
    this.isVisible = this.startVisible
    this.applyVisibility()

    this.pinToggleButtons.forEach((button) => {
      if (!button || !button.onStateChanged) {
        return
      }

      button.onStateChanged.add(() => {
        if (!this.isReady) {
          return
        }
        this.toggleVisibility()
      })
    })

    this.isReady = true
    print(
      `[PinPointNoteSimpleVisibilityToggle] Ready on ${this.getSceneObject().name}. ` +
        `startVisible=${this.startVisible}, hasRoot=${this.noteObjectsRoot ? "yes" : "no"}, pins=${this.pinToggleButtons.length}`
    )
  }

  private toggleVisibility(): void {
    this.isVisible = !this.isVisible
    this.applyVisibility()
  }

  private applyVisibility(): void {
    if (this.noteObjectsRoot) {
      this.noteObjectsRoot.enabled = this.isVisible
    }
  }
}

