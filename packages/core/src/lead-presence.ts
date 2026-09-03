/**
 * Whether a meeting doc's asks have a live lead agent to land on — the
 * server's answer (`lead-presence.ts` there) and the doc page's banner
 * (`lead-banner.ts` in workspaces-app) share this shape. It rides the doc's
 * event stream under `LEAD_PRESENCE_EVENT`, change-only, no replay.
 */
export const LEAD_PRESENCE_EVENT = 'lead.presence';

export interface LeadPresence {
  event: typeof LEAD_PRESENCE_EVENT;
  docId: string;
  /** The board this doc's asks go to. Absent when no board holds the doc —
   *  then nothing could be listening, and `live` is false. */
  workspaceId?: string;
  /** Who holds the seat, whether or not they are there. */
  leadAgentId?: string;
  /** Somebody in the seat can be handed an ask right now. */
  live: boolean;
  /** When the seat's holder was last seen, if ever. */
  observedAt?: number;
}
