import {ToggleButton} from "SpectaclesInteractionKit.lspkg/Components/UI/ToggleButton/ToggleButton"
import {SnapToWorld} from "./SnapToWorld"
import {SnapCloudSessionManager} from "Scripts/SnapCloudSessionManager"

@component
export class SnapToWorldInit extends BaseScriptComponent {
  @input private previewInWorld: SceneObject
  @input private worldQueryModule: WorldQueryModule
  @input private snappingToggle: ToggleButton

  private snapToWorld: SnapToWorld
  private stopRequested: boolean = false

  onAwake() {
    this.snapToWorld = SnapToWorld.getInstance()
    this.snapToWorld.init(this.worldQueryModule, this.previewInWorld)
    this.snapToWorld.isOn = false

    this.createEvent("OnStartEvent").bind(() => {
      // Session is created as active on launch, so default button state should be "Stop Session".
      this.snappingToggle.isToggledOn = true
      this.snappingToggle.onStateChanged.add((isOn) => this.handleStopSessionTriggered(isOn))
    })

    this.createEvent("UpdateEvent").bind(() => {
      this.snapToWorld.tick()
    })
  }

  private async handleStopSessionTriggered(isToggledOn: boolean) {
    if (this.stopRequested) {
      return
    }
    this.stopRequested = true

    try {
      const sessionManager = SnapCloudSessionManager.getInstance()
      if (!sessionManager) {
        print("[SnapToWorldInit] Session toggle requested, but SessionManager is missing.")
        return
      }

      const shouldStopSession = isToggledOn === true
      if (shouldStopSession) {
        const stopped = await sessionManager.stopActiveSession()
        print(`[SnapToWorldInit] Stop Session requested. success=${stopped}`)
      } else {
        const started = await sessionManager.startNewSession()
        print(`[SnapToWorldInit] Start Session requested. success=${started}`)
      }
    } finally {
      // Keep button interactive for the next stop/start cycle.
      this.snappingToggle.enabled = true
      this.stopRequested = false
    }
  }
}
