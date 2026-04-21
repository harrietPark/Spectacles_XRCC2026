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

  @input
  @hint("Pin scale multiplier while note is hidden.")
  private hiddenPinScaleMultiplier: number = 1.25

  @input
  @hint("Pin scale animation duration in seconds.")
  private pinScaleAnimationDuration: number = 0.22

  @input
  @hint("Enable hanging sway when note becomes visible.")
  private enableShowSway: boolean = true

  @input
  @hint("Total sway duration in seconds.")
  private showSwayDuration: number = 0.55

  @input
  @hint("Starting sway angle in degrees.")
  private showSwayMaxAngleDegrees: number = 11.0

  @input
  @hint("How quickly sway oscillates (cycles per second).")
  private showSwayFrequencyHz: number = 3.2

  @input
  @hint("How quickly sway settles (higher = faster settle).")
  private showSwayDamping: number = 4.0

  @input
  @hint("Use a top pivot so note feels like it hangs from pin.")
  private useHangingPivot: boolean = true

  @input
  @hint("Local pivot point on note root (top-middle). Tune Y for best hanging look.")
  private hangingPivotLocal: vec3 = new vec3(0, 5, 0)

  @input
  @hint("Optional explicit pin objects to scale (preferred: BluePin/Mesh + RedPin/Mesh).")
  private pinScaleObjects: SceneObject[] = []

  private isVisible: boolean = true
  private isReady: boolean = false
  private pinTransforms: Transform[] = []
  private pinBaseScales: vec3[] = []
  private pinAnimFromScales: vec3[] = []
  private pinAnimToScales: vec3[] = []
  private pinAnimElapsed: number = 0
  private pinAnimPlaying: boolean = false
  private noteRootTransform: Transform | undefined
  private noteRootBaseRotation: quat | undefined
  private noteRootBasePosition: vec3 | undefined
  private hangingAnchorTarget: vec3 | undefined
  private swayElapsed: number = 0
  private swayPlaying: boolean = false

  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())
  }

  private onStart(): void {
    this.cachePinTransforms()
    if (this.noteObjectsRoot) {
      this.noteRootTransform = this.noteObjectsRoot.getTransform()
      this.noteRootBasePosition = this.noteRootTransform.getLocalPosition()
      this.noteRootBaseRotation = this.noteRootTransform.getLocalRotation()
      this.hangingAnchorTarget = this.noteRootBasePosition.add(
        this.noteRootBaseRotation.multiplyVec3(this.hangingPivotLocal)
      )
    }

    this.isVisible = this.startVisible
    this.applyVisibility()
    this.applyPinScaleImmediate(this.isVisible ? 1.0 : this.hiddenPinScaleMultiplier)

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

    // ToggleButton can emit initial state-change callbacks on startup.
    // Arm interactions on the next tick so startVisible is respected.
    const armEvent = this.createEvent("DelayedCallbackEvent")
    armEvent.bind(() => {
      this.isReady = true
    })
    armEvent.reset(0)

    print(
      `[PinPointNoteSimpleVisibilityToggle] Ready on ${this.getSceneObject().name}. ` +
        `startVisible=${this.startVisible}, hasRoot=${this.noteObjectsRoot ? "yes" : "no"}, pins=${this.pinToggleButtons.length}`
    )
  }

  private toggleVisibility(): void {
    this.isVisible = !this.isVisible
    this.applyVisibility()
    this.startPinScaleAnimation(this.isVisible ? 1.0 : this.hiddenPinScaleMultiplier)
    if (this.isVisible) {
      this.startShowSwayAnimation()
    } else {
      this.stopShowSwayAnimation()
    }
  }

  private applyVisibility(): void {
    if (this.noteObjectsRoot) {
      this.noteObjectsRoot.enabled = this.isVisible
    }
  }

  private onUpdate(): void {
    if (this.pinAnimPlaying) {
      const duration = Math.max(0.01, this.pinScaleAnimationDuration)
      this.pinAnimElapsed += getDeltaTime()
      const t = Math.min(1, this.pinAnimElapsed / duration)
      const eased = this.easeInOutCubic(t)

      for (let i = 0; i < this.pinTransforms.length; i++) {
        const from = this.pinAnimFromScales[i]
        const to = this.pinAnimToScales[i]
        const x = this.lerp(from.x, to.x, eased)
        const y = this.lerp(from.y, to.y, eased)
        const z = this.lerp(from.z, to.z, eased)
        this.pinTransforms[i].setLocalScale(new vec3(x, y, z))
      }

      if (t >= 1) {
        this.pinAnimPlaying = false
      }
    }

    if (this.swayPlaying) {
      this.updateShowSwayAnimation()
    }
  }

  private cachePinTransforms(): void {
    this.pinTransforms = []
    this.pinBaseScales = []

    // Prefer explicitly assigned scale targets so we avoid conflicts
    // with button root transforms controlled by interaction components.
    for (let i = 0; i < this.pinScaleObjects.length; i++) {
      const scaleObj = this.pinScaleObjects[i]
      if (!scaleObj) {
        continue
      }
      const transform = scaleObj.getTransform()
      this.pinTransforms.push(transform)
      this.pinBaseScales.push(transform.getLocalScale())
    }

    if (this.pinTransforms.length > 0) {
      return
    }

    // Fallback: infer a mesh child under each toggle button root.
    for (let i = 0; i < this.pinToggleButtons.length; i++) {
      const button = this.pinToggleButtons[i]
      if (!button) {
        continue
      }
      const pinObj = button.getSceneObject()
      if (!pinObj) {
        continue
      }

      const meshChild = this.findChildByName(pinObj, "Mesh")
      const targetObj = meshChild ? meshChild : pinObj
      const transform = targetObj.getTransform()
      this.pinTransforms.push(transform)
      this.pinBaseScales.push(transform.getLocalScale())
    }
  }

  private applyPinScaleImmediate(multiplier: number): void {
    for (let i = 0; i < this.pinTransforms.length; i++) {
      const base = this.pinBaseScales[i]
      this.pinTransforms[i].setLocalScale(new vec3(base.x * multiplier, base.y * multiplier, base.z * multiplier))
    }
  }

  private startPinScaleAnimation(targetMultiplier: number): void {
    this.pinAnimFromScales = []
    this.pinAnimToScales = []
    this.pinAnimElapsed = 0
    this.pinAnimPlaying = true

    for (let i = 0; i < this.pinTransforms.length; i++) {
      const current = this.pinTransforms[i].getLocalScale()
      const base = this.pinBaseScales[i]
      this.pinAnimFromScales.push(current)
      this.pinAnimToScales.push(
        new vec3(base.x * targetMultiplier, base.y * targetMultiplier, base.z * targetMultiplier)
      )
    }
    print(
      `[PinPointNoteSimpleVisibilityToggle] Pin scale anim start: targets=${this.pinTransforms.length}, multiplier=${targetMultiplier}`
    )
  }

  private startShowSwayAnimation(): void {
    if (!this.enableShowSway || !this.noteRootTransform || !this.noteRootBaseRotation) {
      return
    }
    this.swayElapsed = 0
    this.swayPlaying = true
  }

  private stopShowSwayAnimation(): void {
    this.swayPlaying = false
    if (this.noteRootTransform && this.noteRootBaseRotation && this.noteRootBasePosition) {
      this.noteRootTransform.setLocalRotation(this.noteRootBaseRotation)
      this.noteRootTransform.setLocalPosition(this.noteRootBasePosition)
    }
  }

  private updateShowSwayAnimation(): void {
    if (!this.noteRootTransform || !this.noteRootBaseRotation || !this.noteRootBasePosition) {
      this.swayPlaying = false
      return
    }

    const duration = Math.max(0.01, this.showSwayDuration)
    this.swayElapsed += getDeltaTime()
    const t = Math.min(1, this.swayElapsed / duration)

    const timeSec = this.swayElapsed
    const decay = Math.exp(-this.showSwayDamping * t)
    const oscillation = Math.sin(timeSec * this.showSwayFrequencyHz * Math.PI * 2)
    const angleDeg = this.showSwayMaxAngleDegrees * decay * oscillation
    const swingRot = quat.angleAxis(angleDeg * (Math.PI / 180), vec3.forward())
    const currentRot = this.noteRootBaseRotation.multiply(swingRot)
    this.noteRootTransform.setLocalRotation(currentRot)

    if (this.useHangingPivot && this.hangingAnchorTarget) {
      // Keep top pivot fixed while lower note body swings.
      const pivotWorldFromCurrent = currentRot.multiplyVec3(this.hangingPivotLocal)
      const correctedPos = this.hangingAnchorTarget.sub(pivotWorldFromCurrent)
      this.noteRootTransform.setLocalPosition(correctedPos)
    }

    if (t >= 1) {
      this.noteRootTransform.setLocalRotation(this.noteRootBaseRotation)
      this.noteRootTransform.setLocalPosition(this.noteRootBasePosition)
      this.swayPlaying = false
    }
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t
  }

  private easeInOutCubic(t: number): number {
    if (t < 0.5) {
      return 4 * t * t * t
    }
    const p = -2 * t + 2
    return 1 - (p * p * p) / 2
  }

  private findChildByName(parent: SceneObject, name: string): SceneObject | undefined {
    const count = parent.getChildrenCount()
    for (let i = 0; i < count; i++) {
      const child = parent.getChild(i)
      if (child.name === name) {
        return child
      }
    }
    return undefined
  }
}

