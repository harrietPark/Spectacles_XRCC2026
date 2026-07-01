@component
export class PresetNote extends BaseScriptComponent {
  @ui.group_start("Open / Close (head movement)")
  @input
  @allowUndefined
  @hint("Full open note content shown when the user looks at the note.")
  private openContentRoot: SceneObject | undefined;

  @input
  @allowUndefined
  @hint("Compact closed visual shown when the user looks away.")
  private closedVisualRoot: SceneObject | undefined;

  @input
  @hint("Seconds for the fly-in zoom when opening.")
  private openAnimationDuration: number = 0.65;

  @input
  @hint("Seconds for the fly-away zoom when closing.")
  private closeAnimationDuration: number = 0.55;

  @input
  @hint("Local Z offset when flown away (positive = deeper into the scene).")
  private flyBackDistance: number = 0.45;

  @input
  @hint("Uniform scale when flown away (0-1).")
  private flyAwayScale: number = 0.1;

  @input
  @hint("Progress (0-1) where visibility swaps at the vanishing point.")
  private handoffMidpoint: number = 0.5;
  @ui.group_end

  private openTransform: Transform | undefined;
  private closedTransform: Transform | undefined;
  private openBaseScale: vec3 = vec3.one();
  private openBasePosition: vec3 = vec3.zero();
  private closedBaseScale: vec3 = vec3.one();
  private closedBasePosition: vec3 = vec3.zero();

  private isOpen: boolean = true;
  private animPlaying: boolean = false;
  private animElapsed: number = 0;
  private animTargetOpen: boolean = true;
  private animStartT: number = 1;
  private currentOpenPresenceT: number = 1;

  private onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
  }

  private onStart() {
    this.resolveContentRoots();

    if (this.openContentRoot) {
      this.openTransform = this.openContentRoot.getTransform();
      this.openBaseScale = this.openTransform.getLocalScale();
      this.openBasePosition = this.openTransform.getLocalPosition();
    }
    if (this.closedVisualRoot) {
      this.closedTransform = this.closedVisualRoot.getTransform();
      this.closedBaseScale = this.closedTransform.getLocalScale();
      this.closedBasePosition = this.closedTransform.getLocalPosition();
    }

    this.isOpen = true;
    this.currentOpenPresenceT = 1;
    this.applyDualFlyState(1, false);

    if (this.openContentRoot) {
      this.openContentRoot.enabled = true;
    }
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = false;
    }
  }

  public pullToForeground() {
    if (this.isOpen && !this.animPlaying) {
      return;
    }
    if (this.animPlaying && this.animTargetOpen) {
      return;
    }

    this.animTargetOpen = true;
    this.startTransition();
  }

  public pushToBackground() {
    if (!this.isOpen && !this.animPlaying) {
      return;
    }
    if (this.animPlaying && !this.animTargetOpen) {
      return;
    }

    this.animTargetOpen = false;
    this.startTransition();
  }

  private onUpdate() {
    if (!this.animPlaying) {
      return;
    }

    const duration = Math.max(
      0.01,
      this.animTargetOpen
        ? this.openAnimationDuration
        : this.closeAnimationDuration,
    );
    this.animElapsed += getDeltaTime();
    const t = Math.min(1, this.animElapsed / duration);
    const endT = this.animTargetOpen ? 1 : 0;
    const eased = this.animTargetOpen
      ? this.easeOutCubic(t)
      : this.easeInCubic(t);
    const openPresenceT = this.lerp(this.animStartT, endT, eased);

    this.currentOpenPresenceT = openPresenceT;
    this.applyDualFlyState(openPresenceT, true);

    if (t >= 1) {
      this.finishTransition();
    }
  }

  private startTransition(): void {
    this.animElapsed = 0;
    this.animPlaying = true;
    this.animStartT = this.currentOpenPresenceT;

    if (this.openContentRoot) {
      this.openContentRoot.enabled = true;
    }
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = true;
    }

    this.applyDualFlyState(this.currentOpenPresenceT, true);
  }

  private resolveContentRoots(): void {
    const host = this.getSceneObject();

    if (!this.openContentRoot || !this.closedVisualRoot) {
      const childCount = host.getChildrenCount();
      for (let i = 0; i < childCount; i++) {
        const child = host.getChild(i);
        if (!this.openContentRoot && child.name === "OpenContent") {
          this.openContentRoot = child;
        }
        if (!this.closedVisualRoot && child.name === "ClosedVisual") {
          this.closedVisualRoot = child;
        }
      }
    }

    if (!this.openContentRoot) {
      print(
        `[PresetNote] Missing openContentRoot on "${host.name}". Assign OpenContent in the Inspector.`,
      );
    }
    if (!this.closedVisualRoot) {
      print(
        `[PresetNote] Missing closedVisualRoot on "${host.name}". Assign ClosedVisual in the Inspector.`,
      );
    }
  }

  private finishTransition(): void {
    this.animPlaying = false;
    this.isOpen = this.animTargetOpen;
    this.currentOpenPresenceT = this.animTargetOpen ? 1 : 0;

    if (this.isOpen) {
      this.resetClosedTransform();
      this.applyDualFlyState(1, false);
      if (this.closedVisualRoot) {
        this.closedVisualRoot.enabled = false;
      }
      if (this.openContentRoot) {
        this.openContentRoot.enabled = true;
      }
      return;
    }

    this.resetOpenTransform();
    this.applyDualFlyState(0, false);
    if (this.openContentRoot) {
      this.openContentRoot.enabled = false;
    }
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = true;
    }
  }

  private applyDualFlyState(openPresenceT: number, useMidpointHandoff: boolean): void {
    const t = Math.max(0, Math.min(1, openPresenceT));
    const mid = Math.max(0.05, Math.min(0.95, this.handoffMidpoint));
    const { openSpatialT, closedSpatialT } = this.computeSpatialPresence(t, mid);

    this.applyZoomTransform(
      this.openTransform,
      this.openBaseScale,
      this.openBasePosition,
      openSpatialT,
    );
    this.applyZoomTransform(
      this.closedTransform,
      this.closedBaseScale,
      this.closedBasePosition,
      closedSpatialT,
    );

    if (!useMidpointHandoff) {
      return;
    }

    this.applyMidpointVisibility(t, mid);
  }

  private applyMidpointVisibility(openPresenceT: number, mid: number): void {
    const showOpen = openPresenceT > mid;
    const showClosed = openPresenceT < mid;

    if (this.openContentRoot) {
      this.openContentRoot.enabled = showOpen;
    }
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = showClosed;
    }
  }

  private computeSpatialPresence(
    openPresenceT: number,
    mid: number,
  ): { openSpatialT: number; closedSpatialT: number } {
    const openSpatialT =
      openPresenceT <= mid ? 0 : this.inverseLerp(mid, 1, openPresenceT);
    const closedSpatialT =
      openPresenceT >= mid ? 0 : this.inverseLerp(mid, 0, openPresenceT);

    return { openSpatialT, closedSpatialT };
  }

  private inverseLerp(start: number, end: number, value: number): number {
    if (Math.abs(end - start) < 0.0001) {
      return value >= end ? 1 : 0;
    }

    return Math.max(0, Math.min(1, (value - start) / (end - start)));
  }

  private applyZoomTransform(
    transform: Transform | undefined,
    baseScale: vec3,
    basePosition: vec3,
    presenceT: number,
  ): void {
    if (!transform) {
      return;
    }

    const t = Math.max(0, Math.min(1, presenceT));
    const awayT = 1 - t;
    const scaleMul = this.lerp(this.flyAwayScale, 1, t);
    const zOffset = this.flyBackDistance * awayT;

    transform.setLocalScale(
      new vec3(
        baseScale.x * scaleMul,
        baseScale.y * scaleMul,
        baseScale.z * scaleMul,
      ),
    );
    transform.setLocalPosition(
      new vec3(
        basePosition.x,
        basePosition.y,
        basePosition.z + zOffset,
      ),
    );
  }

  private resetOpenTransform(): void {
    if (!this.openTransform) {
      return;
    }

    this.openTransform.setLocalScale(this.openBaseScale);
    this.openTransform.setLocalPosition(this.openBasePosition);
  }

  private resetClosedTransform(): void {
    if (!this.closedTransform) {
      return;
    }

    this.closedTransform.setLocalScale(this.closedBaseScale);
    this.closedTransform.setLocalPosition(this.closedBasePosition);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  private easeInCubic(t: number): number {
    return t * t * t;
  }
}
