import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";

@component
export class UXFeedbackController extends BaseScriptComponent {
    @ui.group_start("Visual Feedback")
    @input private MidasTouchVisual: SceneObject;
    @input
    @allowUndefined
    @hint("Optional mesh visual for dwell indicator color feedback. If empty, uses first RenderMeshVisual on MidasTouchVisual.")
    private midasTouchVisualMesh: RenderMeshVisual | undefined;
    @input
    @allowUndefined
    @hint("Optional prefab shown while dwell is not ready. Falls back to color sphere when unassigned.")
    private dwellNotReadyStatePrefab: ObjectPrefab | undefined;
    @input
    @allowUndefined
    @hint("Optional prefab shown when dwell is ready to place a note. Falls back to color sphere when unassigned.")
    private dwellReadyStatePrefab: ObjectPrefab | undefined;
    @input
    @hint("Uniform scale multiplier for the not-ready state prefab.")
    private dwellNotReadyStateScale: number = 1.0;
    @input
    @hint("Uniform scale multiplier for the ready state prefab.")
    private dwellReadyStateScale: number = 1.0;
    @input
    @hint("Shader color parameter name on the dwell indicator material.")
    private midasTouchColorParameter: string = "baseColor";
    @input
    @widget(new ColorWidget())
    private dwellNotReadyColor: vec4 = new vec4(1, 0, 0, 1);
    @input
    @widget(new ColorWidget())
    private dwellReadyColor: vec4 = new vec4(0, 1, 0, 1);
    @ui.group_end

    // Hand tracking
    private handProvider: HandInputData = SIK.HandInputData
    private rightHand = this.handProvider.getHand("right")

    // State booleans
    private isIndexTipHighlightActive: boolean = false;

    private dwellBaseMeshVisual: RenderMeshVisual | undefined;
    private dwellIndicatorMaterial: Material | undefined;
    private dwellNotReadyStateObject: SceneObject | undefined;
    private dwellReadyStateObject: SceneObject | undefined;
    private lastDwellReadyVisualState: boolean | undefined;

    private onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private onStart() {
        this.initializeDwellStateVisuals();
        this.initializeDwellIndicatorMaterial();
        this.setDwellIndicatorReady(false);
    }

    private onUpdate() {
        if (this.isIndexTipHighlightActive) {
            this.MidasTouchVisual.getTransform().setWorldPosition(this.rightHand.indexTip.position);
        }
    }

    public activateIndexTipHighlight() {
        this.MidasTouchVisual.enabled = true;
        this.isIndexTipHighlightActive = true;
    }

    public deactivateIndexTipHighlight() {
        this.MidasTouchVisual.enabled = false;
        this.isIndexTipHighlightActive = false;
    }

    public activateDwellIndicator() {
        this.setDwellIndicatorReady(true);
    }

    public deactivateDwellIndicator() {
        this.setDwellIndicatorReady(false);
    }
    
    private initializeDwellIndicatorMaterial(): void {
        this.dwellBaseMeshVisual = this.midasTouchVisualMesh ?? this.MidasTouchVisual.getComponent("Component.RenderMeshVisual");
        if (!this.dwellBaseMeshVisual || !this.dwellBaseMeshVisual.mainMaterial) {
            print("[NoteController] Dwell indicator mesh/material not found; color feedback disabled.");
            return;
        }

        this.dwellIndicatorMaterial = this.dwellBaseMeshVisual.mainMaterial.clone();
        this.dwellBaseMeshVisual.mainMaterial = this.dwellIndicatorMaterial;
    }

    private initializeDwellStateVisuals(): void {
        this.dwellNotReadyStateObject = this.instantiateStatePrefab(
            this.dwellNotReadyStatePrefab,
            this.dwellNotReadyStateScale
        );
        this.dwellReadyStateObject = this.instantiateStatePrefab(this.dwellReadyStatePrefab, this.dwellReadyStateScale);
    }

    private instantiateStatePrefab(prefab: ObjectPrefab | undefined, scaleMultiplier: number): SceneObject | undefined {
        if (!prefab) {
            return undefined;
        }

        const stateObject = prefab.instantiate(this.MidasTouchVisual);
        const stateTransform = stateObject.getTransform();
        stateTransform.setLocalPosition(vec3.zero());
        stateTransform.setLocalRotation(quat.quatIdentity());
        stateTransform.setLocalScale(vec3.one().uniformScale(Math.max(0.01, scaleMultiplier)));
        stateObject.enabled = false;
        return stateObject;
    }

    private setDwellIndicatorReady(isReady: boolean): void {
        if (this.lastDwellReadyVisualState !== undefined && this.lastDwellReadyVisualState === isReady) {
            return;
        }
        this.lastDwellReadyVisualState = isReady;

        const activeStateObject = isReady ? this.dwellReadyStateObject : this.dwellNotReadyStateObject;
        const inactiveStateObject = isReady ? this.dwellNotReadyStateObject : this.dwellReadyStateObject;

        if (inactiveStateObject) {
            inactiveStateObject.enabled = false;
        }
        if (activeStateObject) {
            activeStateObject.enabled = true;
        }

        const shouldUseColorFallback = !activeStateObject;
        if (this.dwellBaseMeshVisual) {
            this.dwellBaseMeshVisual.enabled = shouldUseColorFallback;
        }

        if (!shouldUseColorFallback || !this.dwellIndicatorMaterial) {
            return;
        }

        const pass = this.dwellIndicatorMaterial.mainPass as unknown as {[key: string]: vec4};
        pass[this.midasTouchColorParameter] = isReady ? this.dwellReadyColor : this.dwellNotReadyColor;
    }
    
}
