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
      // Off = no session in DB (show "Start Session" in the toggle UI). On = live session (show "End Session").
      this.snappingToggle.isToggledOn = false
      this.snappingToggle.onStateChanged.add((isOn) => this.handleSessionToggleChanged(isOn))
    })

    this.createEvent("UpdateEvent").bind(() => {
      this.snapToWorld.tick()
    })
  }

  private async handleSessionToggleChanged(isToggledOn: boolean) {
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

      if (isToggledOn) {
        const started = await sessionManager.startNewSession()
        print(`[SnapToWorldInit] Start Session requested. success=${started}`)
      } else {
        if (!sessionManager.getSessionId()) {
          print(
            "[SnapToWorldInit] End Session ignored: no session id yet (initial toggle fire or use Start first)."
          )
          return
        }
        const stopped = await sessionManager.stopActiveSession()
        print(`[SnapToWorldInit] End Session requested. success=${stopped}`)
      }
    } finally {
      // Keep button interactive for the next stop/start cycle.
      this.snappingToggle.enabled = true
      this.stopRequested = false
    }
  }
}
