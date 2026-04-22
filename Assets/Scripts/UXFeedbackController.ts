import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import { AreaManager } from "Samples/Spatial_Persistence/SpatialPersistance/AreaManager";

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
    @input
    @hint("Seconds the dwell signal must remain changed before applying state (reduces jitter flicker).")
    private dwellSignalDebounceSeconds: number = 0.08;
    @input
    @hint("Seconds in active dwell before switching from not-ready to ready visual.")
    private dwellReadyAfterSeconds: number = 1.5;
    @ui.group_end
    @ui.group_start("Post-Ready Loading")
    @input
    @hint("Show loading icon while note is being created after dwell is ready.")
    private showLoadingIndicator: boolean = false;
    @input
    @allowUndefined
    @hint("Optional loading indicator prefab. If empty, tries 3DLoadingIndicator__PLACE_IN_SCENE prefab.")
    private loadingIndicatorPrefab: ObjectPrefab | undefined;
    @input
    @hint("Offset from pin position in local space. Use negative Y to place below.")
    private loadingIndicatorLocalOffset: vec3 = new vec3(0, -5, 0);
    @input
    @hint("Uniform scale multiplier for loading indicator.")
    private loadingIndicatorScale: number = 1.0;
    @input
    @allowUndefined
    @hint("Assign AreaManager to hide loading indicator when a new note widget is actually created.")
    private areaManagerForLoadingTracking: AreaManager | undefined;
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
    private isDwellSignalActive: boolean = false;
    private pendingDwellSignalActive: boolean = false;
    private dwellSignalChangedAt: number = 0;
    private dwellActivatedAt: number = 0;
    private loadingIndicatorObject: SceneObject | undefined;
    private isLoadingIndicatorActive: boolean = false;
    private latestWidgetCount: number = 0;
    private waitingForWidgetSpawn: boolean = false;
    private expectedWidgetCountAfterSpawn: number = 0;

    private onAwake() {
        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private onStart() {
        this.deactivateIndexTipHighlight();
        this.initializeDwellStateVisuals();
        this.initializeDwellIndicatorMaterial();
        this.initializeLoadingIndicator();
        this.setDwellIndicatorReady(false);
        this.isDwellSignalActive = false;
        this.pendingDwellSignalActive = false;
        this.dwellSignalChangedAt = getTime();
        this.dwellActivatedAt = 0;

        this.areaManagerForLoadingTracking?.onWidgetsUpdated.add((widgets) => {
            this.latestWidgetCount = widgets.length;
            if (this.waitingForWidgetSpawn && widgets.length >= this.expectedWidgetCountAfterSpawn) {
                this.waitingForWidgetSpawn = false;
                this.hideLoadingIndicator();
            }
        });
    }

    private onUpdate() {
        if (this.isIndexTipHighlightActive) {
            this.MidasTouchVisual.getTransform().setWorldPosition(this.rightHand.indexTip.position);
        }

        this.updateDwellVisualState();
    }

    public activateIndexTipHighlight() {
        this.hideLoadingIndicator();
        this.forceNotReadyVisualState();
        this.MidasTouchVisual.enabled = true;
        this.isIndexTipHighlightActive = true;
    }

    public deactivateIndexTipHighlight() {
        if (this.shouldShowLoadingIndicatorForReadyTransition()) {
            this.showLoadingIndicatorAtCurrentPin();
        } else {
            this.MidasTouchVisual.enabled = false;
        }
        this.isIndexTipHighlightActive = false;
    }

    public activateDwellIndicator() {
        this.requestDwellSignalState(true);
    }

    public deactivateDwellIndicator() {
        this.hideLoadingIndicator();
        this.requestDwellSignalState(false);
    }

    private forceNotReadyVisualState(): void {
        this.isDwellSignalActive = false;
        this.pendingDwellSignalActive = false;
        this.dwellActivatedAt = 0;
        this.dwellSignalChangedAt = getTime();
        this.applyDwellIndicatorState(false, true);
    }

    private initializeLoadingIndicator(): void {
        if (!this.showLoadingIndicator) {
            return;
        }

        let prefab = this.loadingIndicatorPrefab;
        if (!prefab) {
            try {
                prefab = requireAsset(
                    "3D Loading Indicator.lspkg/3DLoadingIndicator__PLACE_IN_SCENE"
                ) as ObjectPrefab;
            } catch (_error) {
                print("[UXFeedbackController] Could not auto-load default loading indicator prefab.");
            }
        }

        if (!prefab) {
            print("[UXFeedbackController] Loading indicator is enabled but no prefab is assigned.");
            return;
        }

        this.loadingIndicatorObject = prefab.instantiate(this.sceneObject);
        this.loadingIndicatorObject.enabled = false;
        const loadingTransform = this.loadingIndicatorObject.getTransform();
        loadingTransform.setLocalRotation(quat.quatIdentity());
        loadingTransform.setLocalScale(vec3.one().uniformScale(Math.max(0.01, this.loadingIndicatorScale)));
    }

    private shouldShowLoadingIndicatorForReadyTransition(): boolean {
        return (
            this.showLoadingIndicator &&
            this.loadingIndicatorObject !== undefined &&
            this.lastDwellReadyVisualState === true
        );
    }

    private showLoadingIndicatorAtCurrentPin(): void {
        if (!this.loadingIndicatorObject) {
            this.MidasTouchVisual.enabled = false;
            return;
        }

        this.MidasTouchVisual.enabled = false;
        const pinTransform = this.MidasTouchVisual.getTransform();
        const worldPosition = pinTransform
            .getWorldPosition()
            .add(pinTransform.getWorldRotation().multiplyVec3(this.loadingIndicatorLocalOffset));

        const loadingTransform = this.loadingIndicatorObject.getTransform();
        loadingTransform.setWorldPosition(worldPosition);
        loadingTransform.setWorldRotation(pinTransform.getWorldRotation());
        loadingTransform.setWorldScale(vec3.one().uniformScale(Math.max(0.01, this.loadingIndicatorScale)));

        this.loadingIndicatorObject.enabled = true;
        this.isLoadingIndicatorActive = true;
        this.waitingForWidgetSpawn = true;
        this.expectedWidgetCountAfterSpawn = this.latestWidgetCount + 1;
    }

    private hideLoadingIndicator(): void {
        if (!this.isLoadingIndicatorActive && !this.loadingIndicatorObject?.enabled) {
            return;
        }

        this.isLoadingIndicatorActive = false;
        this.waitingForWidgetSpawn = false;
        this.expectedWidgetCountAfterSpawn = this.latestWidgetCount;
        if (this.loadingIndicatorObject) {
            this.loadingIndicatorObject.enabled = false;
        }
    }
    private requestDwellSignalState(isActive: boolean): void {
        if (this.pendingDwellSignalActive === isActive) {
            return;
        }

        this.pendingDwellSignalActive = isActive;
        this.dwellSignalChangedAt = getTime();
    }

    private updateDwellVisualState(): void {
        const now = getTime();
        const debounceSeconds = Math.max(0, this.dwellSignalDebounceSeconds);
        if (this.pendingDwellSignalActive !== this.isDwellSignalActive) {
            if (now - this.dwellSignalChangedAt < debounceSeconds) {
                return;
            }

            this.isDwellSignalActive = this.pendingDwellSignalActive;
            if (this.isDwellSignalActive) {
                this.dwellActivatedAt = now;
                this.setDwellIndicatorReady(false);
            } else {
                this.dwellActivatedAt = 0;
                this.setDwellIndicatorReady(false);
            }
        }

        if (!this.isDwellSignalActive) {
            return;
        }

        const readyAfterSeconds = Math.max(0, this.dwellReadyAfterSeconds);
        if (now - this.dwellActivatedAt >= readyAfterSeconds) {
            this.setDwellIndicatorReady(true);
        }
    }

    
    private initializeDwellIndicatorMaterial(): void {
        this.dwellBaseMeshVisual = this.midasTouchVisualMesh ?? this.MidasTouchVisual.getComponent("Component.RenderMeshVisual");
        if (!this.dwellBaseMeshVisual || !this.dwellBaseMeshVisual.mainMaterial) {
            print("[UXFeedbackController] Dwell indicator mesh/material not found; color feedback disabled.");
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
        this.applyDwellIndicatorState(isReady, false);
    }

    private applyDwellIndicatorState(isReady: boolean, force: boolean): void {
        if (!force && this.lastDwellReadyVisualState !== undefined && this.lastDwellReadyVisualState === isReady) {
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

        const pass = this.dwellIndicatorMaterial.mainPass as unknown as { [key: string]: vec4 };
        pass[this.midasTouchColorParameter] = isReady ? this.dwellReadyColor : this.dwellNotReadyColor;
    }
    
}
