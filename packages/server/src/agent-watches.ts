/**
 * The durable half of a session's doc watches.
 *
 * A watch is wired inside the MCP child: `watch_doc` opens an SSE connection
 * from that process to `/events/<docId>` and forwards frames into the session
 * as channel messages. The child dies with the session, so a Claude Code
 * respawn — a token switch, a `/clear`, a crash — drops every subscription and
 * `list_watched_docs` answers `[]`, which is exactly what a session that never
 * subscribed answers. Measured 2026-08-18 by two peers after a token-switch
 * cycle: 62 subscriptions on one, 6 with live threads on the other, all gone
 * and nothing said so. That reinstates the failure watches exist to prevent —
 * an answer sitting unread in a doc nobody is listening on.
 *
 * This store keeps the SET, keyed on the agent's stable identity (the same
 * `AUTHOR.id` every other MCP call carries — `agent-<slug>` from
 * `CW_AGENT_NAME`), so a respawned child can ask "what was I watching?"
 * and re-wire it. The server never opens the streams itself: the subscription
 * still lives in the child, because the child is the only thing that can push
 * into the session. What the server owns is the memory of it.
 *
 * Shape decisions, each with its reason:
 *
 * - **One JSON file, `agent-watches.json`, in the data dir.** Small (tens of
 *   keys per agent, a handful of agents), rewritten whole on every change via
 *   write-temp-then-rename so a crash mid-write leaves the previous file, not
 *   half of one. Per-agent files would need filename hygiene for an id the
 *   caller supplies; a map key needs none.
 * - **Union on write.** Two live sessions may share one agent name (a peer
 *   and its subagent, or a session and its respawn overlapping for a moment).
 *   `add` merges into the set and `remove` deletes named keys; nothing ever
 *   replaces the set wholesale, so neither session can clobber the other's
 *   watches by reporting its own view.
 * - **Prune on read, not on write.** A watch on a doc that no longer exists
 *   is dead weight — the child would open a stream that 404s forever. The
 *   store drops those when the set is READ (the restore path), given an
 *   `exists` predicate from whoever owns the docs, and reports what it dropped
 *   so the caller can see it. Read-time rather than write-time because the
 *   auto-watch fires BEFORE the tool that creates the doc runs, so at write
 *   time a brand-new doc legitimately does not exist yet. A watch set is
 *   subscription state, not user content — pruning it is not a soft-delete
 *   concern (see CLAUDE.md, "the rule is about user content and history").
 * - **The shared identity is refused.** `CW_AGENT_NAME` unset resolves
 *   every session to `known-agent`, and a set keyed on that would restore the
 *   union of every anonymous session's watches into each of them. Same rule
 *   the task owner check applies to the bare word "agent": a category is not
 *   somebody. Callers with a shared identity get a 400 that says how to fix
 *   it, and the MCP reports its watches as session-only rather than pretend.
 * - **A corrupt file is renamed aside, never overwritten.** Losing the set is
 *   recoverable (peers re-watch as they touch docs); silently discarding a
 *   file someone might read later to work out what happened is not.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILENAME = 'agent-watches.json';
const FORMAT_VERSION = 1;

/** Identities that name a category rather than a session. */
export const SHARED_AGENT_IDS = new Set(['known-agent', 'agent']);

export const SHARED_IDENTITY_ERROR = 'shared-identity';
export const SHARED_IDENTITY_MESSAGE =
  'This session has no stable identity — its watches cannot be kept across restarts. ' +
  'Set CW_AGENT_NAME in the launch environment (needs a session restart) so watches ' +
  'key to a name rather than to the shared "agent" identity every anonymous session resolves to.';

/** A watch key is a docId or `ws:<workspaceId>` — the MCP child's own map keys. */
const KEY_RE = /^[a-zA-Z0-9_.:~\-]{1,104}$/;
const AGENT_ID_RE = /^[^\s/\\]{1,200}$/;

export function isValidWatchKey(key: unknown): key is string {
  return typeof key === 'string' && !key.startsWith('.') && KEY_RE.test(key);
}

export function isValidAgentId(id: unknown): id is string {
  return typeof id === 'string' && AGENT_ID_RE.test(id);
}

export interface WatchEntry {
  key: string;
  /** When this key first entered the set (ms epoch). Survives re-adds. */
  since: number;
}

interface AgentRecord {
  /** Display name, if the caller sent one — for a human reading the file. */
  name?: string;
  watches: Record<string, { since: number }>;
  updatedAt: number;
}

interface FileShape {
  version: number;
  agents: Record<string, AgentRecord>;
}

export interface AgentWatchesOptions {
  dataDir: string;
  now?: () => number;
}

export interface ListResult {
  agentId: string;
  watches: WatchEntry[];
  /** Keys dropped by this read because `exists` said no. */
  pruned: string[];
  updatedAt: number | null;
}

export class AgentWatches {
  private readonly path: string;
  private readonly now: () => number;
  private state: FileShape;
  /** Set when the file on disk was unreadable and moved aside. */
  readonly loadError: string | null = null;

  constructor(opts: AgentWatchesOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.now = opts.now ?? Date.now;
    this.state = { version: FORMAT_VERSION, agents: {} };
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.agents !== 'object') {
        throw new Error('missing "agents" object');
      }
      this.state = { version: FORMAT_VERSION, agents: {} };
      for (const [agentId, rec] of Object.entries(parsed.agents ?? {})) {
        if (!rec || typeof rec !== 'object' || typeof rec.watches !== 'object') continue;
        const watches: Record<string, { since: number }> = {};
        for (const [key, meta] of Object.entries(rec.watches ?? {})) {
          if (!isValidWatchKey(key)) continue;
          const since = typeof meta?.since === 'number' ? meta.since : this.now();
          watches[key] = { since };
        }
        this.state.agents[agentId] = {
          ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
          watches,
          updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : this.now(),
        };
      }
    } catch (err) {
      // Move it aside rather than overwrite it — the next write would
      // otherwise destroy the only evidence of what went wrong.
      const aside = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        // If even the rename fails, the write path below will overwrite; there
        // is nothing better available and the loadError still says so.
      }
      this.loadError = `${err instanceof Error ? err.message : String(err)} (moved to ${aside})`;
      this.state = { version: FORMAT_VERSION, agents: {} };
    }
  }

  /**
   * The agent's live watch set, with dead keys dropped. `exists` decides
   * liveness — the server passes "is there a room / workspace by this key",
   * because the store itself knows nothing about docs.
   */
  list(agentId: string, exists: (key: string) => boolean): ListResult {
    const rec = this.state.agents[agentId];
    if (!rec) return { agentId, watches: [], pruned: [], updatedAt: null };
    const pruned: string[] = [];
    for (const key of Object.keys(rec.watches)) {
      if (!exists(key)) {
        pruned.push(key);
        delete rec.watches[key];
      }
    }
    if (pruned.length > 0) {
      rec.updatedAt = this.now();
      this.save();
    }
    return {
      agentId,
      watches: this.entries(rec),
      pruned,
      updatedAt: rec.updatedAt,
    };
  }

  /**
   * Union `add` into the set, delete `remove` from it. Returns the resulting
   * set. A key in both lists is removed — an explicit unwatch in the same
   * request outranks an implicit re-add.
   */
  update(
    agentId: string,
    change: { add?: string[]; remove?: string[]; name?: string },
  ): { agentId: string; watches: WatchEntry[]; added: string[]; removed: string[] } {
    const rec: AgentRecord = this.state.agents[agentId] ?? { watches: {}, updatedAt: 0 };
    const added: string[] = [];
    const removed: string[] = [];
    for (const key of change.add ?? []) {
      if (rec.watches[key]) continue;
      rec.watches[key] = { since: this.now() };
      added.push(key);
    }
    for (const key of change.remove ?? []) {
      if (!rec.watches[key]) continue;
      delete rec.watches[key];
      removed.push(key);
    }
    if (change.name) rec.name = change.name;
    if (added.length > 0 || removed.length > 0 || !this.state.agents[agentId] || change.name) {
      rec.updatedAt = this.now();
      this.state.agents[agentId] = rec;
      this.save();
    }
    return { agentId, watches: this.entries(rec), added, removed };
  }

  /**
   * The reverse question: which agents hold this key durably? This is what
   * ADDRESSES a queued comment — the durable watch set is the standing
   * statement "deliver this board's events to me", surviving the stream that
   * carries them. Shared identities are excluded for the same reason `list`
   * refuses them: a category is not somebody a delivery can be owed to.
   */
  agentsWatching(key: string): string[] {
    const out: string[] = [];
    for (const [agentId, rec] of Object.entries(this.state.agents)) {
      if (SHARED_AGENT_IDS.has(agentId)) continue;
      if (rec.watches[key]) out.push(agentId);
    }
    return out;
  }

  private entries(rec: AgentRecord): WatchEntry[] {
    return Object.entries(rec.watches)
      .map(([key, meta]) => ({ key, since: meta.since }))
      .sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
