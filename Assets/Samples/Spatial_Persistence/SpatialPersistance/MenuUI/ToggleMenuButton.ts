import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import {ToggleButton} from "SpectaclesInteractionKit.lspkg/Components/UI/ToggleButton/ToggleButton"
import {TransformFollower} from "./TransformFollower"

/**
 * A simple button using SpectaclesInteractionKit events to signal user intent to select a certain area and load serialized content.
 */
@component
export class ToggleMenuButton extends BaseScriptComponent {
  private toggleButton = this.sceneObject.getComponent(ToggleButton.getTypeName())

  private interactable = this.sceneObject.getComponent(Interactable.getTypeName())

  private visuals: RenderMeshVisual[]

  private transformFollower: TransformFollower

  private targetMenu: SceneObject

  public onStateChanged

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this))
  }

  onStart() {
    if (!this.toggleButton || !this.interactable) {
      print(
        `[ToggleMenuButton] Missing required components on '${this.sceneObject.name}'. ` +
          "Expected ToggleButton and Interactable."
      )
      return
    }

    this.onStateChanged = this.toggleButton.onStateChanged
    this.toggleButton.onStateChanged.add(this.handleStateChanged.bind(this))

    this.visuals = []
    const childCount = this.sceneObject.getChildrenCount()
    for (let i = 0; i < childCount; i++) {
      const visual = this.sceneObject.getChild(i).getComponent("Component.RenderMeshVisual")
      if (visual) {
        this.visuals.push(visual)
      }
    }

    this.interactable.onHoverEnter.add(() => {
      this.setHoveredState(1)
    })
    this.interactable.onHoverExit.add(() => {
      this.setHoveredState(0)
    })

    this.transformFollower = this.sceneObject.getComponent(TransformFollower.getTypeName())
  }

  private handleStateChanged(isToggledOn: boolean) {
    if (this.targetMenu == null) {
      return
    }

    this.targetMenu.enabled = isToggledOn
  }

  public setTargetMenu(targetMenu: SceneObject) {
    this.targetMenu = targetMenu
  }

  public setFollowTarget(followTarget: Transform, translationOffset: vec3, rotationOffset: quat) {
    if (!this.transformFollower) {
      return
    }
    this.transformFollower.setTarget(followTarget, translationOffset, rotationOffset)
  }

  private setHoveredState(value: number) {
    for (let i = 0; i < this.visuals.length; i++) {
      const material = this.visuals[i].mainMaterial as any
      if (material && material.mainPass) {
        material.mainPass.hovered = value
      }
    }
  }
}
