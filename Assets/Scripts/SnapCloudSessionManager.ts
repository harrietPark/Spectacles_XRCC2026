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
 *   - Defer the `customers` + `sessions` upsert until the user starts a session
 *     (e.g. SnapToWorldInit toggle) via `startNewSession()`.
 *   - On `stopActiveSession()`, set `ended_at` and `status` to `ended` on success, or
 *     `abandon` if the session row update or the `summaries-table` visit summary call fails.
 *     (Full URL: `{supabaseProject.url}/functions/v1/summaries-table` — same host as the project.)
 *
 * It does NOT touch pins, captures, or notes.
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

  @input
  @hint("Edge function name (maps to {project url}/functions/v1/{slug}, e.g. summaries-table). Empty = skip invoke.")
  private visitSummaryFunctionName: string = "summaries-table"

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
    this.sessionId = ""
    this.ready = false
    print(`[SessionManager] client ready. Session row is created on startNewSession() only.`)
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
    if (!this.client) {
      print("[SessionManager] stopActiveSession skipped: client unavailable.")
      return false
    }
    if (!this.sessionId) {
      // No row was started (e.g. spurious "end" toggle before first start, or first-frame UI).
      print("[SessionManager] stopActiveSession: no session to end (idempotent).")
      return true
    }

    this.stoppingSession = true
    try {
      const endedAt = new Date().toISOString()
      const markEnded = await this.client
        .from(this.sessionsTableName)
        .update({
          status: "ended",
          ended_at: endedAt
        })
        .eq("id", this.sessionId)

      if (markEnded.error) {
        print(`[SessionManager] sessions UPDATE(ended) failed: ${JSON.stringify(markEnded.error)}`)
        await this.markSessionAbandoned(endedAt)
        this.finishStopLocal()
        return false
      }
      print(`[SessionManager] sessions status=ended (id=${this.sessionId}) ended_at=${endedAt}.`)

      const visitSummaryOk = await this.invokeVisitSummaryEdgeFunction()
      if (!visitSummaryOk) {
        const markAb = await this.client
          .from(this.sessionsTableName)
          .update({status: "abandon"})
          .eq("id", this.sessionId)
        if (markAb.error) {
          print(`[SessionManager] sessions UPDATE(abandon) failed: ${JSON.stringify(markAb.error)}`)
        } else {
          print(`[SessionManager] sessions status=abandon (after visit summary failure). id=${this.sessionId}`)
        }
      }

      this.finishStopLocal()
      // false if we had to mark abandon after a failed `summaries-table` invoke
      return visitSummaryOk
    } finally {
      this.stoppingSession = false
    }
  }

  private finishStopLocal(): void {
    this.ready = false
    this.sessionStopped = true
  }

  /** Sets status to `abandon` (and ended_at if the row was never closed). */
  private async markSessionAbandoned(endedAt: string): Promise<void> {
    if (!this.client || !this.sessionId) {
      return
    }
    const {error} = await this.client
      .from(this.sessionsTableName)
      .update({
        status: "abandon",
        ended_at: endedAt
      })
      .eq("id", this.sessionId)
    if (error) {
      print(`[SessionManager] sessions UPDATE(abandon after error) failed: ${JSON.stringify(error)}`)
    } else {
      print(`[SessionManager] sessions status=abandon (id=${this.sessionId}).`)
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

  /** @returns true if invoke succeeded or was skipped; false on error (caller may set `abandon`). */
  private async invokeVisitSummaryEdgeFunction(): Promise<boolean> {
    if (!this.client || !this.sessionId) {
      return false
    }
    if (!this.visitSummaryFunctionName) {
      print("[SessionManager] visit summary: skipped (no function name).")
      return true
    }
    const clientWithFns = this.client as unknown as {
      functions: {
        invoke: (
          name: string,
          opts: {body: Record<string, unknown>}
        ) => Promise<{data: unknown; error: unknown}>
      }
    }
    try {
      const res = await clientWithFns.functions.invoke(this.visitSummaryFunctionName, {
        body: {session_id: this.sessionId}
      })
      if (res.error) {
        print(`[SessionManager] visit summary edge (summaries-table) failed: ${JSON.stringify(res.error)}`)
        return false
      }
      print(`[SessionManager] visit summary (summaries-table) ok: ${JSON.stringify(res.data)}`)
      return true
    } catch (e) {
      print(`[SessionManager] visit summary exception: ${e}`)
      return false
    }
  }

  /**
   * Upsert the dummy `customers` row, then the `sessions` row. Both are
   * idempotent (onConflict "id"). Called from `startNewSession` only; other
   * scripts should call isReady() before writing child rows that FK into
   * sessions or customers.
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
