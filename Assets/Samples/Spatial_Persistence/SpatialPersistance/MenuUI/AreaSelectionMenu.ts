import {ContainerFrame} from "SpectaclesInteractionKit.lspkg/Components/UI/ContainerFrame/ContainerFrame"
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {AreaDeleteButton} from "./AreaDeleteButton"
import {AreaSelectionButton} from "./AreaSelectionButton"

export const NEW_AREA_NAME = "New Area"
const BUTTON_VERTICAL_SPACING = 3
const MENU_TOP_PADDING_Y = 2
const MENU_BOTTOM_PADDING_Y = 2.0
const FIRST_AREA_Y = 3.0
const MENU_WIDTH_REDUCTION = 3

export type AreaSelectEvent = {
  areaName: string
  isNew: boolean
}

export type AreaDeleteEvent = {
  areaName: string
  isConfirmed: boolean
}

export type AreaClearEvent = {
  isConfirmed: boolean
}

/**
 * A simple menu to create several AreaSelectionButtons to allow user to choose between several areas (or create a new area).
 */
@component
export class AreaSelectionMenu extends BaseScriptComponent {
  private areaSelectionButtonPrefab: ObjectPrefab
  private areaDeleteButtonPrefab: ObjectPrefab

  private capsuleButtonMesh: RenderMesh

  private onAreaSelectEvent: Event<AreaSelectEvent> = new Event<AreaSelectEvent>()
  readonly onAreaSelect: PublicApi<AreaSelectEvent> = this.onAreaSelectEvent.publicApi()

  private onAreaDeleteEvent: Event<AreaDeleteEvent> = new Event<AreaDeleteEvent>()
  readonly onAreaDelete: PublicApi<AreaDeleteEvent> = this.onAreaDeleteEvent.publicApi()

  private onAreaClearEvent: Event<AreaClearEvent> = new Event<AreaClearEvent>()
  readonly onAreaClear: PublicApi<AreaClearEvent> = this.onAreaClearEvent.publicApi()

  private container: ContainerFrame | undefined
  private baseContainerWidth: number = 0

  onAwake() {
    this.container = this.findContainerFrame()
    if (!this.container) {
      throw new Error(
        `[AreaSelectionMenu] Missing ContainerFrame in parent chain for ${this.sceneObject.name}. ` +
          "Add a ContainerFrame on this object or one of its parents."
      )
    }

    this.areaSelectionButtonPrefab = requireAsset("Prefabs/AreaSelectionButtonPrefab") as ObjectPrefab
    this.areaDeleteButtonPrefab = requireAsset("Prefabs/AreaDeleteButtonPrefab") as ObjectPrefab
    this.baseContainerWidth = this.container.innerSize.x

    this.capsuleButtonMesh = requireAsset(
      "SpectaclesInteractionKit.lspkg/Assets/Meshes/ButtonCapsuleMesh"
    ) as RenderMesh

    if (this.capsuleButtonMesh == null) {
      throw new Error("capsuleButtonMesh not found at SpectaclesInteractionKit.lspkg/Assets/Meshes/ButtonCapsuleMesh")
    }
  }

  /**
   * Generates AreaSelectionButtons to represent all serialized areas to allow user to load into a certain area,
   * which will also instantiate previously serialized widgets through AreaManager's callback logic for onAreaSelectEvent.
   * @param areaNames - the names of all serialized areas available to load
   */
  public promptAreaSelection(areaNames: string[]) {
    if (!this.container) {
      print("[AreaSelectionMenu] promptAreaSelection skipped: container is not initialized.")
      return
    }

    const existingAreaNames = [...areaNames]
    const highestAreaY = FIRST_AREA_Y
    const lowestAreaY =
      existingAreaNames.length > 0
        ? FIRST_AREA_Y - (existingAreaNames.length - 1) * BUTTON_VERTICAL_SPACING
        : FIRST_AREA_Y
    const height = highestAreaY - lowestAreaY + MENU_TOP_PADDING_Y + MENU_BOTTOM_PADDING_Y
    const menuWidth = Math.max(1, this.baseContainerWidth - MENU_WIDTH_REDUCTION)
    this.container.innerSize = new vec2(menuWidth, height)

    this.selectionEnabled = true

    let yOffset = highestAreaY
    for (const areaName of existingAreaNames) {
      const prefab = this.areaSelectionButtonPrefab.instantiate(this.sceneObject)

      const areaSelectionButton = prefab.getComponent(AreaSelectionButton.getTypeName())

      areaSelectionButton.getTransform().setLocalPosition(new vec3(0, yOffset, 0))

      yOffset -= BUTTON_VERTICAL_SPACING

      areaSelectionButton.text = areaName

      areaSelectionButton.onSelect.add(() => {
        this.selectionEnabled = false

        // Add an extra AreaSelectionButton for new areas.
        // TODO: Add text input to area creation.
        this.onAreaSelectEvent.invoke({areaName: areaName, isNew: false})
      })

      const material = prefab.getChild(0).getComponent("RenderMeshVisual").mainMaterial.clone()

      const deleteButtonObject = this.areaDeleteButtonPrefab.instantiate(this.sceneObject)
      deleteButtonObject.getTransform().setLocalPosition(new vec3(-7, yOffset + BUTTON_VERTICAL_SPACING, 0))
      const deleteButton = deleteButtonObject.getComponent(AreaDeleteButton.getTypeName())
      deleteButton.initialize(this.capsuleButtonMesh, areaSelectionButton.buttonMesh)

      let isConfirmed = false
      deleteButton.onSelect.add(() => {
        if (isConfirmed) {
          this.onAreaDeleteEvent.invoke({
            areaName: areaName,
            isConfirmed: isConfirmed
          })
        } else {
          this.onAreaDeleteEvent.invoke({
            areaName: areaName,
            isConfirmed: isConfirmed
          })
          isConfirmed = true
          deleteButton.setIsConfirming()
        }
      })

      prefab.getChild(0).getComponent("RenderMeshVisual").mainMaterial = material
    }

  }

  public close() {
    this.selectionEnabled = false
  }

  private set selectionEnabled(enabled: boolean) {
    if (!this.container) {
      print("[AreaSelectionMenu] selectionEnabled ignored: container is not initialized.")
      return
    }

    if (enabled) {
      this.clearAreaSelectionButtons()
    }
    this.container.sceneObject.enabled = enabled

    // this.sceneObject.enabled = enabled;
  }

  private clearAreaSelectionButtons() {
    const children = this.sceneObject.children

    for (const child of children) {
      child.destroy()
    }
  }

  private findNextAreaName(areaNames: string[]): string {
    let i = 1
    let areaName = `Area ${i}`

    while (areaNames.includes(areaName)) {
      i++
      areaName = `Area ${i}`
    }

    return areaName
  }

  private findContainerFrame(): ContainerFrame | undefined {
    let current: SceneObject | undefined = this.sceneObject
    while (current) {
      const container = current.getComponent(ContainerFrame.getTypeName()) as ContainerFrame | undefined
      if (container) {
        return container
      }
      current = current.getParent()
    }

    return undefined
  }
}
