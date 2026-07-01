type FadeMaterialTarget = {
  material: Material;
  colorKeys: { key: string; color: vec4 }[];
  alphaKey?: string;
  baseAlpha?: number;
};

type FadeMeshTarget = {
  visual: RenderMeshVisual;
  materials: FadeMaterialTarget[];
};

type FadeTextTarget = {
  text: Text;
  baseColor: vec4;
};

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
  @hint("Seconds for the open expand animation.")
  private openAnimationDuration: number = 0.35;

  @input
  @hint("Seconds for the close collapse animation.")
  private closeAnimationDuration: number = 0.55;

  @input
  @hint("Y scale of open content when collapsed (should match the closed visual height).")
  private collapsedScaleY: number = 0.21;

  @input
  @hint("Local Y offset used to keep the top edge fixed while scaling.")
  private expandAnchorY: number = 0.2;
  @ui.group_end

  private openTransform: Transform | undefined;
  private openBaseScale: vec3 = vec3.one();
  private openBasePosition: vec3 = vec3.zero();
  private openMeshTargets: FadeMeshTarget[] = [];
  private closedMeshTargets: FadeMeshTarget[] = [];
  private openTextFadeTargets: FadeTextTarget[] = [];
  private closedTextFadeTargets: FadeTextTarget[] = [];

  private isOpen: boolean = true;
  private animPlaying: boolean = false;
  private animElapsed: number = 0;
  private animTargetOpen: boolean = true;
  private animStartT: number = 1;
  private currentExpandT: number = 1;

  private onAwake() {
    this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
  }

  private onStart() {
    this.openMeshTargets = this.collectMeshTargets(this.openContentRoot);
    this.closedMeshTargets = this.collectMeshTargets(this.closedVisualRoot);
    this.openTextFadeTargets = this.collectTextFadeTargets(this.openContentRoot);
    this.closedTextFadeTargets = this.collectTextFadeTargets(this.closedVisualRoot);

    if (this.openContentRoot) {
      this.openTransform = this.openContentRoot.getTransform();
      this.openBaseScale = this.openTransform.getLocalScale();
      this.openBasePosition = this.openTransform.getLocalPosition();
    }

    this.isOpen = true;
    this.currentExpandT = 1;
    this.applyVisualState(1, true);

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
    this.startExpandTransition();
  }

  public pushToBackground() {
    if (!this.isOpen && !this.animPlaying) {
      return;
    }
    if (this.animPlaying && !this.animTargetOpen) {
      return;
    }

    this.animTargetOpen = false;
    this.startExpandTransition();
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
      : this.easeInOutCubic(t);
    const expandT = this.lerp(this.animStartT, endT, eased);

    this.currentExpandT = expandT;
    this.applyVisualState(expandT, this.animTargetOpen);

    if (t >= 1) {
      this.finishExpandTransition();
    }
  }

  private startExpandTransition(): void {
    this.animElapsed = 0;
    this.animPlaying = true;
    this.animStartT = this.currentExpandT;

    if (this.openContentRoot) {
      this.openContentRoot.enabled = true;
    }
    if (this.closedVisualRoot) {
      this.closedVisualRoot.enabled = true;
    }

    this.applyVisualState(this.currentExpandT, this.animTargetOpen);
  }

  private finishExpandTransition(): void {
    this.animPlaying = false;
    this.isOpen = this.animTargetOpen;
    this.currentExpandT = this.animTargetOpen ? 1 : 0;

    if (this.isOpen) {
      this.applyVisualState(1, true);
      if (this.closedVisualRoot) {
        this.closedVisualRoot.enabled = false;
      }
      if (this.openContentRoot) {
        this.openContentRoot.enabled = true;
      }
    } else {
      this.resetOpenTransform();
      this.setMeshGroupAlpha(this.openMeshTargets, 0);
      this.setTextFadeGroupAlpha(this.openTextFadeTargets, 0);
      this.setMeshGroupAlpha(this.closedMeshTargets, 1);
      this.setTextFadeGroupAlpha(this.closedTextFadeTargets, 1);
      if (this.openContentRoot) {
        this.openContentRoot.enabled = false;
      }
      if (this.closedVisualRoot) {
        this.closedVisualRoot.enabled = true;
      }
    }
  }

  private applyVisualState(expandT: number, opening: boolean): void {
    const clampedT = Math.max(0, Math.min(1, expandT));
    const openAlpha = opening
      ? this.smoothStep(0.2, 1, clampedT)
      : 1 - this.smoothStep(0, 0.85, 1 - clampedT);
    const closedAlpha = opening
      ? 1 - this.smoothStep(0, 0.4, clampedT)
      : this.smoothStep(0.6, 1, 1 - clampedT);

    this.applyExpandState(clampedT);
    this.setMeshGroupAlpha(this.openMeshTargets, openAlpha);
    this.setTextFadeGroupAlpha(this.openTextFadeTargets, openAlpha);
    this.setMeshGroupAlpha(this.closedMeshTargets, closedAlpha);
    this.setTextFadeGroupAlpha(this.closedTextFadeTargets, closedAlpha);
  }

  private applyExpandState(expandT: number): void {
    if (!this.openTransform) {
      return;
    }

    const scaleY = this.lerp(this.collapsedScaleY, 1, expandT);
    const anchorOffset = this.expandAnchorY * (1 - scaleY);

    this.openTransform.setLocalScale(
      new vec3(this.openBaseScale.x, this.openBaseScale.y * scaleY, this.openBaseScale.z),
    );
    this.openTransform.setLocalPosition(
      new vec3(
        this.openBasePosition.x,
        this.openBasePosition.y + anchorOffset,
        this.openBasePosition.z,
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

  private collectMeshTargets(root: SceneObject | undefined): FadeMeshTarget[] {
    const targets: FadeMeshTarget[] = [];
    if (!root) {
      return targets;
    }

    this.collectMeshTargetsRecursive(root, targets);
    return targets;
  }

  private collectTextFadeTargets(root: SceneObject | undefined): FadeTextTarget[] {
    const targets: FadeTextTarget[] = [];
    if (!root) {
      return targets;
    }

    this.collectTextFadeTargetsRecursive(root, targets);
    return targets;
  }

  private collectMeshTargetsRecursive(
    node: SceneObject,
    targets: FadeMeshTarget[],
  ): void {
    const visuals = node.getComponents(
      "Component.RenderMeshVisual",
    ) as RenderMeshVisual[];

    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i];
      const materials: FadeMaterialTarget[] = [];
      const matCount = visual.getMaterialsCount();
      const clonedMaterials: Material[] = [];

      for (let m = 0; m < matCount; m++) {
        const sourceMaterial = visual.getMaterial(m);
        if (!sourceMaterial) {
          continue;
        }

        const material = sourceMaterial.clone();
        clonedMaterials.push(material);
        materials.push(this.createFadeMaterialTarget(material));
      }

      if (clonedMaterials.length > 0) {
        visual.clearMaterials();
        for (let m = 0; m < clonedMaterials.length; m++) {
          visual.addMaterial(clonedMaterials[m]);
        }
      }

      if (materials.length > 0) {
        targets.push({ visual, materials });
      }
    }

    const childCount = node.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      this.collectMeshTargetsRecursive(node.getChild(i), targets);
    }
  }

  private createFadeMaterialTarget(material: Material): FadeMaterialTarget {
    const pass = material.mainPass as Record<string, vec4 | number | undefined>;
    const colorKeys: { key: string; color: vec4 }[] = [];

    if (pass.baseColor) {
      colorKeys.push({ key: "baseColor", color: pass.baseColor as vec4 });
    }
    if (pass._baseColor) {
      colorKeys.push({ key: "_baseColor", color: pass._baseColor as vec4 });
    }

    const alphaKey = pass.alpha !== undefined ? "alpha" : undefined;
    const baseAlpha =
      alphaKey !== undefined ? (pass.alpha as number) : undefined;

    return { material, colorKeys, alphaKey, baseAlpha };
  }

  private collectTextFadeTargetsRecursive(
    node: SceneObject,
    targets: FadeTextTarget[],
  ): void {
    const texts = node.getComponents("Component.Text") as Text[];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      targets.push({ text, baseColor: text.textFill.color });
    }

    const childCount = node.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
      this.collectTextFadeTargetsRecursive(node.getChild(i), targets);
    }
  }

  private setMeshGroupAlpha(
    targets: FadeMeshTarget[],
    alphaMultiplier: number,
  ): void {
    const clampedAlpha = Math.max(0, Math.min(1, alphaMultiplier));

    for (let i = 0; i < targets.length; i++) {
      const meshTarget = targets[i];

      for (let m = 0; m < meshTarget.materials.length; m++) {
        this.setMaterialAlpha(meshTarget.materials[m], clampedAlpha);
      }

      meshTarget.visual.enabled = clampedAlpha > 0.01;
    }
  }

  private setMaterialAlpha(
    target: FadeMaterialTarget,
    alphaMultiplier: number,
  ): void {
    const pass = target.material.mainPass as Record<string, vec4 | number | undefined>;

    for (let i = 0; i < target.colorKeys.length; i++) {
      const entry = target.colorKeys[i];
      pass[entry.key] = new vec4(
        entry.color.x * alphaMultiplier,
        entry.color.y * alphaMultiplier,
        entry.color.z * alphaMultiplier,
        entry.color.w * alphaMultiplier,
      );
    }

    if (target.alphaKey && target.baseAlpha !== undefined) {
      pass[target.alphaKey] = target.baseAlpha * alphaMultiplier;
    }
  }

  private setTextFadeGroupAlpha(
    targets: FadeTextTarget[],
    alphaMultiplier: number,
  ): void {
    const clampedAlpha = Math.max(0, Math.min(1, alphaMultiplier));

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      target.text.textFill.color = new vec4(
        target.baseColor.x,
        target.baseColor.y,
        target.baseColor.z,
        target.baseColor.w * clampedAlpha,
      );
    }
  }

  private smoothStep(edge0: number, edge1: number, t: number): number {
    const x = Math.max(0, Math.min(1, (t - edge0) / (edge1 - edge0)));
    return x * x * (3 - 2 * x);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  }

  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  private easeInOutCubic(t: number): number {
    if (t < 0.5) {
      return 4 * t * t * t;
    }
    const p = -2 * t + 2;
    return 1 - (p * p * p) / 2;
  }
}
