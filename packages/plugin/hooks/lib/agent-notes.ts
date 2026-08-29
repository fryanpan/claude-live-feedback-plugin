/**
 * Agent notes — the pure half of the plugin's Stop and PermissionDenied
 * hooks. Each hook posts ONE line to `POST /api/agent-notes` so the board's
 * per-agent activity pane can say what an agent did lately: the closing
 * message of every turn, and the shape of every tool call auto mode denied.
 *
 * Everything that decides what to post lives here as functions of their
 * inputs (payload, env, clock, fetch); `../stop-note.ts` and
 * `../permission-denied-note.ts` are thin mains around `runHook`. That is
 * what makes the hooks unit-testable without spawning a process — and the
 * hooks run from the INSTALLED plugin (`packages/plugin` alone), so this
 * module imports nothing from the monorepo.
 *
 * Two rules the whole file serves:
 *  - Never block the turn. A hook that throws, hangs, or exits non-zero
 *    stalls the agent that fired it; every path here ends in exit 0, and the
 *    POST is capped at `POST_TIMEOUT_MS`.
 *  - Reduce, never forward. A closing message becomes one stripped line; a
 *    denied command becomes its first two tokens with anything path-, URL-
 *    or token-shaped dropped. The server stores text verbatim (its test says
 *    so), so THIS is the only place the reduction happens.
 */

export type EnvLike = Record<string, string | undefined>;

export type NoteKind = 'turn' | 'denial';

/** The wire body `POST /api/agent-notes` accepts. `cwd` is accepted there
 *  and dropped (a host path is not workspace content); it rides along so a
 *  future reader can decide. */
export interface NotePayload {
  agent: string;
  kind: NoteKind;
  text: string;
  cwd?: string;
  sessionId?: string;
  /** Millisecond timestamp — the server refuses an ISO string. */
  at: number;
}

export type Decision = { post: NotePayload } | { skip: string };

export const DEFAULT_BASE_URL = 'http://localhost:8787';
/** One line of a closing message, ellipsis included. */
export const NOTE_TEXT_CAP = 200;
/** A denied command's shape; shapes are two tokens, so this only bites on
 *  a pathological first token. */
const SHAPE_CAP = 80;
export const POST_TIMEOUT_MS = 1500;
const SHORT_STRING_MAX = 200;

// ---------------------------------------------------------------------------
// Env

function present(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== '';
}

/** Current spelling first, then the pre-rename one — the same fallback the
 *  MCP child applies (`readRenamedEnv`), spelled here because the installed
 *  plugin cannot import it. */
function readRenamed(env: EnvLike, current: string, legacy: string): string | undefined {
  if (present(env[current])) return env[current];
  if (present(env[legacy])) return env[legacy];
  return undefined;
}

export function readAgentName(env: EnvLike): string | undefined {
  return readRenamed(env, 'CW_AGENT_NAME', 'FEEDBACK_AGENT_NAME')?.trim();
}

/**
 * CW_BASE_URL, then FEEDBACK_BASE_URL, then the server's discovery file
 * (the port it published at boot — what the MCP child itself resolves
 * through), then the documented default. A throwing discovery reader is
 * treated as absent: nothing in a hook may throw.
 */
export function resolveBaseUrl(
  env: EnvLike,
  discoveryPort?: () => number | undefined,
): string | undefined {
  const fromEnv = readRenamed(env, 'CW_BASE_URL', 'FEEDBACK_BASE_URL');
  if (fromEnv) return fromEnv.trim().replace(/\/+$/, '');
  if (discoveryPort) {
    try {
      const port = discoveryPort();
      if (typeof port === 'number' && Number.isFinite(port) && port > 0) {
        return `http://localhost:${port}`;
      }
    } catch {
      // absent
    }
  }
  return DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// Reduction

const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^#{1,6}\s+/;
const RULE_RE = /^([-*_]\s*){3,}$/;
const TABLE_SEP_RE = /^\|?[\s:|-]+\|?$/;

/** One markdown line → plain text. Empty when the line was only markup. */
function stripInline(line: string): string {
  let s = line.trim();
  if (s === '' || RULE_RE.test(s) || TABLE_SEP_RE.test(s)) return '';
  s = s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(>\s?)+/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function capText(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1).trimEnd()}…`;
}

/**
 * A closing message reduced to one line: markdown stripped, the first line
 * with any prose, capped at `cap` with an ellipsis marking the cut. A
 * heading (`## Done`) and fenced code are fallbacks, not first choice — the
 * sentence under the heading says what happened; the heading names it.
 */
export function oneLine(text: unknown, cap = NOTE_TEXT_CAP): string {
  if (typeof text !== 'string') return '';
  let inFence = false;
  let fallback = '';
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim();
    if (FENCE_RE.test(t)) {
      inFence = !inFence;
      continue;
    }
    const secondary = inFence || HEADING_RE.test(t);
    const s = inFence ? t.replace(/\s+/g, ' ') : stripInline(t);
    if (s === '') continue;
    if (!secondary) return capText(s, cap);
    if (fallback === '') fallback = s;
  }
  return capText(fallback, cap);
}

/** Anything a person would not want repeated: a path or URL, an
 *  assignment, an address, or a long opaque run of the kind tokens are. */
function looksOpaque(token: string): boolean {
  return (
    /[/\\:=@~]/.test(token) ||
    token.startsWith('.') ||
    /[A-Za-z0-9_-]{20,}/.test(token) ||
    /\d{6,}/.test(token)
  );
}

/** A path token's last segment, so `./scripts/x/run.sh` reads as `run.sh`
 *  without the directory. */
function basenameOf(token: string): string {
  const parts = token.split(/[/\\]/).filter((p) => p !== '');
  return parts.length > 0 ? parts[parts.length - 1] : token;
}

/**
 * A Bash command reduced to its shape: the first two whitespace tokens
 * (`git rm`), or the first alone when either token looks like a path, URL,
 * assignment or token. A command that IS a path keeps only the file name.
 */
export function commandShape(command: unknown): string {
  if (typeof command !== 'string') return '';
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((t) => t !== '');
  if (tokens.length === 0) return '';
  const first = tokens[0];
  if (/[/\\]/.test(first)) return capText(basenameOf(first), SHAPE_CAP);
  if (tokens.length === 1 || looksOpaque(first) || looksOpaque(tokens[1])) {
    return capText(first, SHAPE_CAP);
  }
  return capText(`${first} ${tokens[1]}`, SHAPE_CAP);
}

// ---------------------------------------------------------------------------
// Decisions

export interface DecideContext {
  agent?: string;
  now: number;
}

type Payload = Record<string, unknown>;

function asPayload(payload: unknown): Payload | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return payload as Payload;
}

function shortString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' && v.length <= SHORT_STRING_MAX ? v : undefined;
}

function note(
  p: Payload,
  ctx: DecideContext,
  agent: string,
  kind: NoteKind,
  text: string,
): Decision {
  const cwd = shortString(p.cwd);
  const sessionId = shortString(p.session_id);
  return {
    post: {
      agent,
      kind,
      text,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      at: ctx.now,
    },
  };
}

/** The Stop hook: the turn's closing message as one line. */
export function decideTurnNote(payload: unknown, ctx: DecideContext): Decision {
  const p = asPayload(payload);
  if (!p) return { skip: 'malformed payload' };
  if (p.stop_hook_active === true) return { skip: 'stop hook active' };
  if (!ctx.agent) return { skip: 'no agent name' };
  const text = oneLine(p.last_assistant_message);
  if (text === '') return { skip: 'empty message' };
  return note(p, ctx, ctx.agent, 'turn', text);
}

/** The PermissionDenied hook: the denied call's shape, never its content. */
export function decideDenialNote(payload: unknown, ctx: DecideContext): Decision {
  const p = asPayload(payload);
  if (!p) return { skip: 'malformed payload' };
  if (!ctx.agent) return { skip: 'no agent name' };
  const tool = shortString(p.tool_name);
  if (!tool) return { skip: 'no tool name' };
  let text = tool;
  if (tool === 'Bash') {
    const input = asPayload(p.tool_input);
    const shape = commandShape(input?.command);
    if (shape !== '') text = shape;
  }
  return note(p, ctx, ctx.agent, 'denial', text);
}

/** Top-level key NAMES of a hook payload, sorted — what gets logged the
 *  first time so the live shape is learned without a value ever leaving. */
export function payloadKeys(payload: unknown): string[] {
  const p = asPayload(payload);
  return p ? Object.keys(p).sort() : [];
}

// ---------------------------------------------------------------------------
// Transport

/** POST the note. Resolves true on a 2xx, false on anything else — a
 *  refusal, a timeout, a thrown fetch — and never rejects. */
export async function postNote(
  baseUrl: string,
  body: NotePayload,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = POST_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/agent-notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The main, minus the process

export interface HookDeps {
  env: EnvLike;
  fetch?: typeof fetch;
  now?: () => number;
  /** Overrides `resolveBaseUrl(env, discoveryPort)` when given. */
  baseUrl?: () => string | undefined;
  discoveryPort?: () => number | undefined;
  /** Where the one-time shape line goes (stderr in the script). */
  log?: (line: string) => void;
  /** True when this hook's shape was already logged; marks it seen. */
  shapeSeen?: (kind: NoteKind) => boolean;
}

/**
 * Read stdin → decide → post. Always resolves 0: the hook never blocks the
 * turn, whatever went wrong.
 */
export async function runHook(kind: NoteKind, stdin: string, deps: HookDeps): Promise<0> {
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(stdin);
    } catch {
      return 0;
    }
    if (deps.log && deps.shapeSeen && !deps.shapeSeen(kind)) {
      deps.log(`[claude-workspaces] ${kind} hook payload keys: ${payloadKeys(payload).join(', ')}`);
    }
    const ctx: DecideContext = {
      agent: readAgentName(deps.env),
      now: deps.now ? deps.now() : Date.now(),
    };
    const decision =
      kind === 'turn' ? decideTurnNote(payload, ctx) : decideDenialNote(payload, ctx);
    if ('skip' in decision) return 0;
    const baseUrl = deps.baseUrl ? deps.baseUrl() : resolveBaseUrl(deps.env, deps.discoveryPort);
    if (!baseUrl) return 0;
    await postNote(baseUrl, decision.post, deps.fetch ?? fetch);
  } catch {
    // fail open
  }
  return 0;
}
