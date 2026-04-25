import {createClient, SupabaseClient} from "SupabaseClient.lspkg/supabase-snapcloud"

/**
 * SnapCloudSessionManager
 * -----------------------
 * SINGLE source of truth for everything that other backend-aware scripts
 * need to share: the Supabase client, the active session_id, and the
 * current customer_id / employee_id (dummy values for now).
 *
 * Responsibilities (and ONLY these):
 *   - On awake, create ONE Supabase client (using the wired SupabaseProject).
 *   - Generate a fresh session_id for this launch.
 *   - Upsert the dummy `customers` row so sessions.customer_id FK passes.
 *   - Upsert the `sessions` row (customer_id, employee_id, status='active').
 *
 * It does NOT touch pins, captures, notes, edge functions, or anything else.
 * Other scripts (SnapCloudPinManager, SnapCloudCropManager, future scripts) call:
 *     SnapCloudSessionManager.getInstance()
 *       ?.getClient()       // SupabaseClient | null
 *       ?.getSessionId()    // string
 *       ?.getCustomerId()   // string (uuid)
 *       ?.getEmployeeId()   // string (uuid)
 *       ?.isReady()         // bootstrap (customer+session upsert) finished?
 *
 * Place ONE component of this script on a scene-root SceneObject and wire
 * the `supabaseProject` input. No other placement is needed.
 */
@component
export class SnapCloudSessionManager extends BaseScriptComponent {
  @input
  @hint("PinPoint Snap Cloud project asset (url + publicToken). Required.")
  @allowUndefined
  private supabaseProject: SupabaseProject | undefined

  @input
  @hint("Dummy customer UUID used on customers, sessions and pins rows.")
  private customerId: string = "00000000-0000-4000-8000-000000000001"

  @input
  @hint("Dummy employee (salesperson) UUID used on the sessions row.")
  private employeeId: string = "00000000-0000-4000-8000-000000000002"

  @input
  @hint("Display name written when auto-creating the dummy customer row.")
  private customerName: string = "Demo Customer"

  @input
  @hint("Email written when auto-creating the dummy customer row.")
  private customerEmail: string = "demo@pinpoint.local"

  @input
  @hint("Supabase table name for customers.")
  private customersTableName: string = "customers"

  @input
  @hint("Supabase table name for sessions.")
  private sessionsTableName: string = "sessions"

  private static instanceRef: SnapCloudSessionManager | null = null

  private client: SupabaseClient | null = null
  private sessionId: string = ""
  private ready: boolean = false
  private stoppingSession: boolean = false
  private startingSession: boolean = false
  private sessionStopped: boolean = false

  static getInstance(): SnapCloudSessionManager | null {
    return SnapCloudSessionManager.instanceRef
  }

  onAwake() {
    if (SnapCloudSessionManager.instanceRef) {
      print("[SessionManager] Another instance already registered; this one stays idle.")
      return
    }
    SnapCloudSessionManager.instanceRef = this

    if (!this.supabaseProject) {
      print("[SessionManager] Missing supabaseProject input; backend calls will be skipped.")
      return
    }

    this.client = createClient(this.supabaseProject.url, this.supabaseProject.publicToken, {
      realtime: {heartbeatIntervalMs: 2500}
    })
    this.sessionId = `session_${Date.now()}`
    print(`[SessionManager] client + sessionId ready. sessionId=${this.sessionId}`)

    this.bootstrap()
  }

  onDestroy() {
    if (SnapCloudSessionManager.instanceRef === this) {
      SnapCloudSessionManager.instanceRef = null
    }
    if (this.client) {
      this.client.removeAllChannels()
      this.client = null
    }
  }

  getClient(): SupabaseClient | null {
    return this.client
  }

  getSessionId(): string {
    return this.sessionId
  }

  getCustomerId(): string {
    return this.customerId
  }

  getEmployeeId(): string {
    return this.employeeId
  }

  isReady(): boolean {
    return this.ready
  }

  async stopActiveSession(): Promise<boolean> {
    if (this.sessionStopped) {
      return true
    }
    if (this.stoppingSession) {
      return false
    }
    if (!this.client || !this.sessionId) {
      print("[SessionManager] stopActiveSession skipped: client/sessionId unavailable.")
      return false
    }

    this.stoppingSession = true
    try {
      const updatePayload = {
        status: "stopped",
        updated_at: new Date().toISOString()
      }

      const result = await this.client.from(this.sessionsTableName).update(updatePayload).eq("id", this.sessionId)
      if (result.error) {
        print(`[SessionManager] sessions UPDATE(stop) failed: ${JSON.stringify(result.error)}`)
        return false
      }

      this.ready = false
      this.sessionStopped = true
      print(`[SessionManager] sessions UPDATE(stop) ok (id=${this.sessionId}).`)
      return true
    } finally {
      this.stoppingSession = false
    }
  }

  async startNewSession(): Promise<boolean> {
    if (this.ready) {
      return true
    }
    if (this.startingSession) {
      return false
    }
    if (!this.client) {
      print("[SessionManager] startNewSession skipped: client unavailable.")
      return false
    }

    this.startingSession = true
    try {
      this.sessionId = `session_${Date.now()}`
      this.sessionStopped = false
      await this.bootstrap()
      return this.ready
    } finally {
      this.startingSession = false
    }
  }

  /**
   * Upsert the dummy `customers` row, then the `sessions` row. Both are
   * idempotent (onConflict "id"), so re-launches are safe. Runs once on
   * awake; other scripts should call isReady() before writing child rows
   * that FK into sessions or customers.
   */
  private async bootstrap(): Promise<void> {
    if (!this.client) return

    const customerRow = {
      id: this.customerId,
      name: this.customerName,
      email: this.customerEmail,
      created_at: new Date().toISOString()
    }
    const c = await this.client
      .from(this.customersTableName)
      .upsert([customerRow], {onConflict: "id"})
    if (c.error) {
      print(`[SessionManager] customers UPSERT failed: ${JSON.stringify(c.error)}`)
      return
    }
    print(`[SessionManager] customers UPSERT ok (id=${this.customerId}).`)

    const now = new Date().toISOString()
    const sessionRow = {
      id: this.sessionId,
      customer_id: this.customerId,
      employee_id: this.employeeId,
      started_at: now,
      created_at: now,
      status: "active"
    }
    const s = await this.client
      .from(this.sessionsTableName)
      .upsert([sessionRow], {onConflict: "id"})
    if (s.error) {
      print(`[SessionManager] sessions UPSERT failed: ${JSON.stringify(s.error)}`)
      return
    }
    print(`[SessionManager] sessions UPSERT ok (id=${this.sessionId}).`)

    this.ready = true
  }
}
