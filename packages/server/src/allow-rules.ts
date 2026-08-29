/**
 * Allow-rule proposals — turning a denial the classifier keeps repeating
 * into ONE question Bryan can answer from his phone.
 *
 * The plugin's PermissionDenied hook posts a `denial` note carrying only the
 * command's SHAPE (`git push`, `rm -rf`, or a tool name); the pane shows each
 * one. What the pane cannot do is stop the loop: auto mode re-asks after
 * every chat approval, so the third `git push` block in a week is the same
 * block as the first. This module notices the repeat and files a `decision`
 * review item on the task the note landed on, carrying a paste-ready
 * `permissions.allow` rule for the person to apply themselves.
 *
 * Two things it deliberately does NOT do:
 *  - **Write settings.** No code path here — or anywhere the server owns —
 *    opens a `settings.json`. The rule is text in the item's detail; pasting
 *    it is the person's act, and an agent asked to do it says no. That is
 *    what keeps "truly dangerous commands still stop" true: the only hand on
 *    the allowlist is a human one.
 *  - **Count from the notes.** Neither copy of a denial note is a reliable
 *    tally. The per-agent ring is in-process, capped at 20 notes of every
 *    kind, and gone on restart — three denials a day apart never meet in
 *    it. The task notes are durable but capped at 200 per row from the old
 *    end, and a busy row posts a turn note every turn, so a week's denials
 *    on a chatty task can be evicted before the third arrives (codex review,
 *    2026-08-29). So the tally lives here: one small sidecar beside the
 *    workspace files, keyed `(agent, shape)`, holding the denial timestamps
 *    inside the window and which item was last filed. The notes stay the
 *    pane's record; this is the counter.
 *
 * Whether the filed item is still open, or was answered "Never propose
 * again", is read from the review item itself — the one record a person
 * actually touched — not from a second flag free to disagree with it. A
 * `never` answer is honoured for as long as the item exists.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type TaskReviewItem, agentIdForName, isReviewItemOpen } from '@feedback/core';
import { normalizeAgent } from './chat-audit.ts';
import type { Task, TaskStore } from './tasks.ts';

/** Denials of one shape, by one agent, inside the window, before the
 *  question is asked. Three: one is a slip, two is a coincidence, three is a
 *  loop. */
export const ALLOW_RULE_THRESHOLD = 3;
/** How far back a denial still counts. */
export const ALLOW_RULE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** `<dataDir>/allow-rule-proposals.json` — beside `workspaces/`, because a
 *  proposal is keyed on the agent, not on any one board. */
export const ALLOW_RULES_FILENAME = 'allow-rule-proposals.json';
/** Denial timestamps kept per pair, newest kept. Far above the threshold;
 *  it bounds the file against a shape blocked hundreds of times while its
 *  item sits unanswered. */
export const ALLOW_RULE_TALLY_CAP = 50;

/** Option ids on the filed item. The `never` id is the one this module reads
 *  back; the other two are the person's to act on. */
export const ALLOW_OPTION_ALLOW = 'allow';
export const ALLOW_OPTION_KEEP = 'keep-asking';
export const ALLOW_OPTION_NEVER = 'never';
const NEVER_LABEL = 'Never propose again';

/**
 * The `permissions.allow` entry for a denial shape, or undefined when there
 * is nothing safe to propose.
 *
 * A Claude Code tool name starts with a capital (`WebFetch`, `Write`) or is
 * an MCP tool (`mcp__server__tool`); the hook posts one verbatim when the
 * denied tool is not Bash. Anything else is a Bash command shape and becomes
 * a prefix rule. The bare `Bash` shape — a command the hook could not reduce
 * — is refused: `Bash` alone would allow every command, which is the opposite
 * of a rule scoped to what was blocked.
 */
export function allowRuleFor(shape: string): string | undefined {
  const s = shape.trim();
  if (s === '' || s === 'Bash') return undefined;
  if (/^[A-Z]/.test(s) || s.startsWith('mcp__')) return s;
  return `Bash(${s}:*)`;
}

interface Proposal {
  taskId: string;
  itemId: string;
  filedAt: number;
}
interface Tally {
  /** Denials inside the window, oldest first, each with the row it hit. */
  denials: Array<{ ts: number; taskId: string }>;
  filed?: Proposal;
}
type Sidecar = Record<string, Record<string, Tally>>;

export interface DenialInput {
  agent: string;
  /** The shape as the note carried it. */
  text: string;
  ts: number;
}

export interface AllowRuleFiled {
  task: Task;
  item: TaskReviewItem;
}

function isNeverAnswer(item: TaskReviewItem): boolean {
  const answer = item.answer;
  if (!answer) return false;
  if (answer.answeredWith === ALLOW_OPTION_NEVER) return true;
  const never = item.review.options?.find((o) => o.id === ALLOW_OPTION_NEVER);
  const label = (never?.label ?? NEVER_LABEL).trim().toLowerCase();
  return answer.text.trim().toLowerCase() === label;
}

function joinTitles(titles: string[]): string {
  if (titles.length <= 1) return titles[0] ?? 'a task';
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  if (titles.length === 3) return `${titles[0]}, ${titles[1]} and ${titles[2]}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
}

/** The review payload — plain words for someone on a phone who was not
 *  there, then the snippet, then what it does NOT unlock. */
export function buildAllowRuleReview(input: {
  agent: string;
  shape: string;
  rule: string;
  count: number;
  taskTitles: string[];
}): Record<string, unknown> {
  const { agent, shape, rule, count, taskTitles } = input;
  const bashRule = rule.startsWith('Bash(');
  const what = bashRule ? `running \`${shape}\`` : `using the ${shape} tool`;
  const scope = bashRule ? `only commands that start with \`${shape}\`` : `only the ${shape} tool`;
  const detail = [
    `Auto mode blocked **${agent}** ${what} ${count} times in the last 7 days, on ${joinTitles(taskTitles)}. Each block stopped the agent until someone approved it in chat, and the approval did not stick.`,
    '',
    'To stop the re-asking, paste this into `~/.claude/settings.json` (every project) or `.claude/settings.json` in the repo (this project only) — add it to the `allow` list if one is already there:',
    '',
    '```json',
    `{ "permissions": { "allow": [${JSON.stringify(rule)}] } }`,
    '```',
    '',
    `This rule does not unlock anything else: ${scope}. The agent never edits settings itself — pasting is yours to do.`,
  ].join('\n');
  return {
    review_type: 'decision',
    headline: `Allow "${shape}" for ${agent} without asking?`,
    detail,
    options: [
      {
        id: ALLOW_OPTION_ALLOW,
        label: 'Paste the rule',
        detail: 'You paste it yourself; blocks stop for this prefix only.',
      },
      {
        id: ALLOW_OPTION_KEEP,
        label: 'Keep blocking',
        detail: `Nothing changes. Asked again after ${ALLOW_RULE_THRESHOLD} more blocks.`,
      },
      {
        id: ALLOW_OPTION_NEVER,
        label: NEVER_LABEL,
        detail: 'Stops this question for this agent and shape. Blocks still show in the pane.',
      },
    ],
  };
}

export class AllowRuleProposals {
  private readonly path: string;
  private sidecar: Sidecar = {};

  constructor(dataDir: string) {
    this.path = join(dataDir, ALLOW_RULES_FILENAME);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.sidecar = parsed as Sidecar;
      }
    } catch {
      // A corrupt sidecar costs a possible duplicate question, never a crash;
      // the review items themselves are the record and are untouched.
      this.sidecar = {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.sidecar, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  /** The item last filed for this pair, when it still exists. */
  private filedItem(store: TaskStore, prior: Proposal | undefined): TaskReviewItem | undefined {
    if (!prior) return undefined;
    return store.listReviewItems(prior.taskId).find((i) => i.id === prior.itemId);
  }

  /**
   * Called after a `denial` note landed on `task`. Records the denial, and
   * files the review item when this is the agent's `ALLOW_RULE_THRESHOLD`th
   * denial of the shape inside the window — returned so the caller can
   * announce and re-project; undefined otherwise.
   *
   * A pair whose item is still open, or was answered "never", records
   * nothing: there is no count to keep for a question that will not be
   * asked. After any other answer the tally restarts at the answer, so
   * "asked again after three more blocks" means three blocks the person
   * had not yet seen when they said keep blocking.
   */
  onDenial(store: TaskStore, note: DenialInput, task: Task): AllowRuleFiled | undefined {
    const shape = note.text.trim();
    const rule = allowRuleFor(shape);
    if (rule === undefined) return undefined;
    const key = normalizeAgent(note.agent);
    const tally: Tally = this.sidecar[key]?.[shape] ?? { denials: [] };
    const existing = this.filedItem(store, tally.filed);
    let since = 0;
    if (existing) {
      if (isReviewItemOpen(existing) || isNeverAnswer(existing)) return undefined;
      since = existing.answer?.ts ?? tally.filed?.filedAt ?? 0;
    }

    const now = note.ts;
    const floor = now - ALLOW_RULE_WINDOW_MS;
    const denials = tally.denials.filter((d) => d.ts >= floor && d.ts > since);
    denials.push({ ts: now, taskId: task.id });
    if (denials.length > ALLOW_RULE_TALLY_CAP)
      denials.splice(0, denials.length - ALLOW_RULE_TALLY_CAP);
    tally.denials = denials;
    this.sidecar[key] = { ...(this.sidecar[key] ?? {}), [shape]: tally };

    if (denials.length < ALLOW_RULE_THRESHOLD) {
      this.save();
      return undefined;
    }

    // Titles in order of first block; a row since purged is simply not named.
    const titles: string[] = [];
    const seen = new Set<string>();
    for (const d of denials) {
      if (seen.has(d.taskId)) continue;
      seen.add(d.taskId);
      const title = store.getTask(d.taskId)?.title;
      if (title) titles.push(title);
    }
    const review = buildAllowRuleReview({
      agent: note.agent,
      shape,
      rule,
      count: denials.length,
      taskTitles: titles,
    });
    const res = store.addReviewItem(task.id, review, {
      actor: { id: agentIdForName(note.agent), name: note.agent, kind: 'agent' },
    });
    if (!res.ok) {
      this.save();
      return undefined;
    }
    tally.filed = { taskId: task.id, itemId: res.item.id, filedAt: now };
    tally.denials = [];
    this.save();
    return { task: res.task, item: res.item };
  }
}
