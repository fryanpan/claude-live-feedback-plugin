/**
 * Recall's bot status codes, mapped to the coarse state a person reads.
 *
 * The vendor's list is fourteen codes across two vocabularies — the webhook
 * `event` names (`bot.in_call_recording`) and the `status_changes[].code`
 * values on `GET /bot/{id}` (`in_call_recording`) — which are the same words
 * with a prefix. One mapping serves both, because a state that depended on
 * which door the fact came through would drift the moment one door is used
 * more than the other.
 *
 * Codes are mapped, never guessed at: an unknown code returns null and the
 * caller keeps the state it had. A vendor adding a code must not be able to
 * move a bot to a state this product does not model, and silently dropping to
 * 'failed' on an unrecognised word would end meetings that are still running.
 *
 * (docs.recall.ai/docs/bot-status-change-events, /reference/bot_list, read
 * 2026-08-30.)
 */

import type { MeetingBotState } from '@feedback/core';

/** Every documented status-change event name, without the `bot.` prefix. */
const CODE_TO_STATE: Readonly<Record<string, MeetingBotState>> = {
  ready: 'requested',
  joining_call: 'joining',
  in_waiting_room: 'waiting_room',
  in_call_not_recording: 'in_call',
  recording_permission_allowed: 'in_call',
  recording_permission_denied: 'permission_denied',
  in_call_recording: 'recording',
  recording_done: 'left',
  call_ended: 'left',
  done: 'left',
  fatal: 'failed',
  media_expired: 'left',
  // Post-call analysis states say nothing about the CALL, which is the only
  // thing this strip reports. Mapped to 'left' rather than dropped so a bot
  // whose only remaining events are these does not sit reading "recording".
  analysis_done: 'left',
  analysis_failed: 'left',
};

/**
 * The state a code means, or null when the code is not one we model.
 *
 * Accepts both `bot.in_call_recording` and `in_call_recording`.
 */
export function botStateFromCode(rawCode: string): MeetingBotState | null {
  const code = rawCode.startsWith('bot.') ? rawCode.slice('bot.'.length) : rawCode;
  return CODE_TO_STATE[code] ?? null;
}

/** One status-change fact, from either vocabulary. */
export interface BotStatusEvent {
  botId: string;
  state: MeetingBotState;
  /** Vendor sub-code or message, for a state a person cannot act on. */
  detail?: string;
}

/**
 * Parse a `POST`ed bot status-change webhook body.
 *
 * Shape (docs.recall.ai/docs/bot-status-change-events):
 *   {event, data: {data: {code, sub_code, updated_at}, bot: {id, metadata}}}
 *
 * The `event` name and the inner `code` are the same fact twice; the inner one
 * wins when both are present, because it is the one that carries `sub_code`
 * alongside it and therefore the one the vendor treats as authoritative.
 */
export function parseBotStatusWebhook(raw: unknown): BotStatusEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const top = raw as Record<string, unknown>;
  const outer = asRecord(top.data);
  if (!outer) return null;
  const bot = asRecord(outer.bot);
  const botId = bot && typeof bot.id === 'string' ? bot.id : '';
  if (!botId) return null;
  const inner = asRecord(outer.data);
  const code =
    inner && typeof inner.code === 'string'
      ? inner.code
      : typeof top.event === 'string'
        ? top.event
        : '';
  if (!code) return null;
  const state = botStateFromCode(code);
  if (!state) return null;
  const sub = inner && typeof inner.sub_code === 'string' ? inner.sub_code : '';
  return { botId, state, ...(sub ? { detail: sub } : {}) };
}

/**
 * The latest state from a `GET /bot/{id}` payload's `status_changes[]`.
 *
 * Last RECOGNISED entry, not last entry: the array is append-only and an
 * unmodelled code at the end must not erase the state before it.
 */
export function latestBotState(
  changes: readonly { code: string; sub_code?: string | null }[],
): { state: MeetingBotState; detail?: string } | null {
  for (let i = changes.length - 1; i >= 0; i--) {
    const entry = changes[i];
    if (!entry) continue;
    const state = botStateFromCode(entry.code);
    if (!state) continue;
    return { state, ...(entry.sub_code ? { detail: entry.sub_code } : {}) };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
