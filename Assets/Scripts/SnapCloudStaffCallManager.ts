import { SnapCloudSessionManager } from "./SnapCloudSessionManager";
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider";

/**
 * Writes `sessions.staff_call_requested_at` and `staff_call_spatial_position`
 * when the customer taps Button_CallSalesPerson.
 *
 * Place ONE component on a scene-root object (e.g. next to SnapCloudSessionManager).
 */
@component
export class SnapCloudStaffCallManager extends BaseScriptComponent {
  private static instanceRef: SnapCloudStaffCallManager | null = null;

  static getInstance(): SnapCloudStaffCallManager | null {
    return SnapCloudStaffCallManager.instanceRef;
  }

  onAwake() {
    if (SnapCloudStaffCallManager.instanceRef) {
      print("[StaffCall] Another instance already registered; this one stays idle.");
      return;
    }
    SnapCloudStaffCallManager.instanceRef = this;
  }

  onDestroy() {
    if (SnapCloudStaffCallManager.instanceRef === this) {
      SnapCloudStaffCallManager.instanceRef = null;
    }
  }

  /** CapsuleButton Trigger Up callback on Button_CallSalesPerson. */
  public callSalesPerson(): void {
    this.requestStaffHelp();
  }

  private async requestStaffHelp(): Promise<void> {
    const sm = SnapCloudSessionManager.getInstance();
    if (!sm || !sm.isReady()) {
      print("[StaffCall] Start a session first.");
      return;
    }

    const client = sm.getClient();
    const sessionId = sm.getSessionId();
    if (!client || !sessionId) {
      print("[StaffCall] Missing client or session id.");
      return;
    }

    const now = new Date().toISOString();
    const updateRow: Record<string, unknown> = { staff_call_requested_at: now };
    const spatialPosition = this.getCameraSpatialPosition();
    if (spatialPosition) {
      updateRow.staff_call_spatial_position = spatialPosition;
    }

    const { error } = await client
      .from("sessions")
      .update(updateRow)
      .eq("id", sessionId);

    if (error) {
      print("[StaffCall] UPDATE failed: " + JSON.stringify(error));
      return;
    }

    print(
      "[StaffCall] Help requested at " +
        now +
        (spatialPosition
          ? ` @ (${spatialPosition.x.toFixed(1)}, ${spatialPosition.z.toFixed(1)}) cm`
          : "")
    );
  }

  private getCameraSpatialPosition(): { x: number; y: number; z: number } | undefined {
    try {
      const worldPos = WorldCameraFinderProvider.getInstance().getTransform().getWorldPosition();
      return { x: worldPos.x, y: worldPos.y, z: worldPos.z };
    } catch (_) {
      return undefined;
    }
  }
}
