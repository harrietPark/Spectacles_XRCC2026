import { PictureController } from "Samples/Crop/Scripts/PictureController";
import { AreaManager } from "Samples/Spatial_Persistence/SpatialPersistance/AreaManager";
import { WidgetSelectionEvent } from "Samples/Spatial_Persistence/SpatialPersistance/MenuUI/WidgetSelection";
import { Note } from "Samples/Spatial_Persistence/SpatialPersistance/Notes/Note";
import { Widget } from "Samples/Spatial_Persistence/SpatialPersistance/Widget";
import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData";
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider";
import SIK from "SpectaclesInteractionKit.lspkg/SIK";
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event";

@component
export class NoteController extends BaseScriptComponent {
    private onUserViewCapturedEvent = new Event<Texture>();
    public readonly onUserViewCaptured: PublicApi<Texture> = this.onUserViewCapturedEvent.publicApi();

    private onNoteSpawnedEvent = new Event<WidgetSelectionEvent>();
    public readonly onNoteSpawned: PublicApi<WidgetSelectionEvent> = this.onNoteSpawnedEvent.publicApi();

    // @input private camera: CameraModule;
    @input
    @allowUndefined
    private areaManager: AreaManager | undefined;
    @ui.group_start("Note Anchoring Setup")
    @input private HandDwellingTimeThreshold: number = 3; // in seconds
    @ui.group_end
    @ui.group_start("Crop to Photo")
    @input
    @allowUndefined
    private pictureController: PictureController | undefined;
    private camModule: CameraModule = require("LensStudio:CameraModule") as CameraModule
    @ui.group_end
    @ui.separator
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
    @ui.group_start("Spawn Rotation")
    @input
    @hint("Additional yaw offset so note front faces the user. 180 fixes back-facing note meshes.")
    private noteSpawnYawOffsetDegrees: number = 180;
    @ui.group_end

    // Hand tracking
    private handProvider: HandInputData = SIK.HandInputData
    private rightHand = this.handProvider.getHand("right")
    private worldCameraTransform = WorldCameraFinderProvider.getInstance().getTransform();
    private handDwellingTimer: number = 0;
    private prevHandPosition: vec3 = vec3.zero();
    private handMovementRadiusRange: number = 0.1; // in meters
    private dwellBaseMeshVisual: RenderMeshVisual | undefined;
    private dwellIndicatorMaterial: Material | undefined;
    private dwellNotReadyStateObject: SceneObject | undefined;
    private dwellReadyStateObject: SceneObject | undefined;
    private lastDwellReadyVisualState: boolean | undefined;

    // State booleans
    private isNoteAnchoringActive: boolean = false;

    private notes: Note[] = [];
    
    private onAwake() {
        this.deactivateCreationProcess();

        this.createEvent("OnStartEvent").bind(this.onStart.bind(this));
        this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this));
    }

    private onStart() {
        this.initializeDwellStateVisuals();
        this.initializeDwellIndicatorMaterial();
        this.setDwellIndicatorReady(false);

        if (this.pictureController) {
            this.pictureController.onCropEnd.add(this.addCroppedImage.bind(this));
        } else {
            print("[NoteController] pictureController is not assigned; crop flow is disabled.");
        }

        if (this.areaManager) {
            this.areaManager.onWidgetsUpdated.add(this.updateNotes.bind(this));
        } else {
            print("[NoteController] areaManager is not assigned; crop-to-latest-note sync is disabled.");
        }
    }

    private onUpdate() {
        if (this.isNoteAnchoringActive) {
            if (this.tryAnchorNote()) {
                this.anchorNote();
            }
        }
    }

    public activateCreationProcess() {
        this.MidasTouchVisual.enabled = true;
        // this.VisualVisualRightIndexTipDwellingProgress.enabled = true;
        this.isNoteAnchoringActive = true;
    }

    public deactivateCreationProcess() {
        this.MidasTouchVisual.enabled = false;
        // this.VisualVisualRightIndexTipDwellingProgress.enabled = false;
        this.isNoteAnchoringActive = false;
    }

    private tryAnchorNote() : boolean {
        if (this.rightHand.isTracked()) {
            const currHandPosition = this.rightHand.indexTip.position;
            this.MidasTouchVisual.getTransform().setWorldPosition(currHandPosition);

            const distance = currHandPosition.distance(this.prevHandPosition);
            this.prevHandPosition = currHandPosition;
            // print("--- DISTANCE: " + distance);
            if (distance < this.handMovementRadiusRange) {
                // this.VisualRightIndexTipHighlight.enabled = true;

                this.handDwellingTimer += getDeltaTime();
                if (this.handDwellingTimer >= this.HandDwellingTimeThreshold) {
                    this.setDwellIndicatorReady(true);
                    this.handDwellingTimer = 0;
                    return true;
                }
                this.setDwellIndicatorReady(false);
                return false;
            }
            this.handDwellingTimer = 0;
            this.setDwellIndicatorReady(false);
            return false;
        } else {
            this.handDwellingTimer = 0;
            this.MidasTouchVisual.getTransform().setLocalScale(vec3.one().uniformScale(3));
            this.setDwellIndicatorReady(false);
            return false;
        }
    }

    private anchorNote() {
        const spawnPosition = this.rightHand.indexTip.position;
        // Spawn a spatial note
        this.onNoteSpawnedEvent.invoke({
            widgetIndex: 0,
            position: spawnPosition,
            rotation: this.getSpawnRotation(spawnPosition)
        });

        this.sendUserViewToBackend();
        this.enableCrop();
    }

    private updateNotes(widgets: Widget[]) {
        this.notes = [];
        for (let i = 0; i < widgets.length; i++) {
            const note = widgets[i].getSceneObject().getComponent(Note.getTypeName());
            if (note) {
                this.notes.push(note);
            }
        }
    }

    private enableCrop() {
        if (!this.pictureController) {
            return;
        }
        this.pictureController.enableCrop();
    }

    private sendUserViewToBackend() {
        // // Capture camera texture
        // this.onUserViewCapturedEvent.invoke(this.PictureController.captureImage);

        // TODO: send camera texture and note ID to backend
    }

    private addCroppedImage(image: Texture) {
        if (this.notes.length === 0) {
            print("[NoteController] No spawned notes found for cropped image.");
            return;
        }

        const latestNote = this.notes[this.notes.length - 1];
        latestNote.setCroppedImage(image);
    }

    private activateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = true;
        this.setDwellIndicatorReady(false);
    }

    private deactivateNoteAnchoringVisual() {
        this.MidasTouchVisual.enabled = false;
        this.setDwellIndicatorReady(false);
    }

    private getSpawnRotation(spawnPosition: vec3): quat {
        const cameraPosition = this.worldCameraTransform.getWorldPosition();
        const distanceToCamera = spawnPosition.distance(cameraPosition);

        if (distanceToCamera < 0.001) {
            return this.rightHand.indexTip.rotation.multiply(this.getYawOffsetRotation());
        }

        const cameraFacingRotation = quat.lookAt(cameraPosition.sub(spawnPosition), vec3.up());
        return cameraFacingRotation.multiply(this.getYawOffsetRotation());
    }

    private getYawOffsetRotation(): quat {
        const yawRadians = this.noteSpawnYawOffsetDegrees * Math.PI / 180;
        return quat.angleAxis(yawRadians, vec3.up());
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