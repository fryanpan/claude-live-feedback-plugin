/**
 * The words this server sends to a model, kept somewhere the owner can change
 * them.
 *
 * `notes-prompt-store.ts` did this for ONE prompt and its header said a
 * settings page would come later and write the same file. The page is here,
 * and it covers seven prompts rather than one — so the file beside the corpus
 * became a JSON record keyed by prompt id, and the notetaking instructions
 * moved into it (see `migrateLegacyNotesPrompt` below).
 *
 * `<dataDir>/prompts.json`. Beside the data rather than in the repo, because
 * what the note-taker is told is this deployment's setting and not this
 * project's source. Four properties are carried over from the store it
 * replaces, and each one was learned rather than chosen:
 *
 * READ PER CALL, NEVER CACHED AT BOOT. Editing the words and watching the
 * next note change is the whole loop this exists for, and a restart in the
 * middle of a meeting to pick up a wording change is not a loop anybody runs.
 * The cost is one small synchronous read against a model call.
 *
 * AN EMPTY VALUE MEANS THE DEFAULT, not an empty prompt. A note-taker sent no
 * instructions at all writes something, and what it writes would be blamed on
 * the model rather than on the blank field that caused it.
 *
 * NEVER THROWS. A corrupt or unreadable file is reported once and every
 * prompt falls back to its default, because notes that stop mid-meeting are a
 * worse failure than notes that read the way they did last week.
 *
 * RESTORE-DEFAULT IS A SOFT DELETE. It moves the current words into
 * `previous` and clears `value`; it never destroys what was written. That is
 * the project-wide rule, and it matters more here than usual — these words
 * are hand-tuned against real meetings and there is no other copy of them.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTES_PROMPT_FILENAME, readNotesPromptFile } from './notes-prompt-store.ts';
import { PROMPT_CATALOG, type PromptId, promptDefinition } from './prompt-catalog.ts';

/** `<dataDir>/prompts.json` — the whole override surface. */
export const PROMPTS_FILENAME = 'prompts.json';

/**
 * The longest prompt this server will store.
 *
 * 4,000 was the ceiling the two board-scoped prompt fields shipped with, and
 * a cap that refuses the shipped default it is protecting is a field nobody
 * can use.
 *
 * Measured against the shipped defaults on 2026-09-06, longest first:
 * the notetaking instructions 5,807 characters, meeting capture 4,594,
 * thread summary 3,274, voice router 1,640, effort estimate 1,432, waiting
 * on you 658, review criteria 656. TWO of them are over the 4,000 this
 * product used to enforce, and one of those is the notetaking instructions —
 * the prompt this page exists to make editable.
 *
 * 16,000 is the longest shipped prompt with room to roughly treble it, which
 * is the room a person rewriting one actually needs — a prompt gets longer
 * as rules are added to it, not shorter. Raised here and imported by
 * `routes/workspace-settings.ts` rather than written twice.
 *
 * Still a ceiling rather than none: every call sends the whole thing, and
 * prompt length is this subsystem's one real cost lever.
 */
export const PROMPT_MAX_CHARS = 16_000;

/** One prompt's record on disk. `value` absent means "the default". */
export interface StoredPrompt {
  value?: string;
  updatedAt?: number;
  updatedBy?: { id: string; name: string };
  /** Every set of words this prompt has held and lost, newest last. Written
   *  by a restore-to-default and by an overwrite: nothing here is ever
   *  destroyed, only superseded. */
  previous?: Array<{ value: string; replacedAt: number }>;
}

/** The file's shape. `version` is here so a later change can read this one. */
export interface PromptsFile {
  version: 1;
  prompts: Record<string, StoredPrompt>;
}

/** What the settings page shows for one prompt. */
export interface PromptView {
  /** The words in force — the override, or the shipped default. */
  value: string;
  /** True while nobody has written their own: the field is showing the
   *  shipped words, and saying so is the whole marker on the row. */
  isDefault: boolean;
}

export type PromptWriteResult =
  | { ok: true }
  | { ok: false; error: 'unknown-prompt' | 'read-only' | 'too-long' | 'empty' | 'write-failed' };

export interface PromptStore {
  /** Where the overrides live. Printed in the boot log. */
  readonly path: string;
  /** The words to send with this call. Never throws. */
  read(id: PromptId): string;
  /** The words plus whether they are the shipped ones. */
  view(id: PromptId): PromptView;
  /** The ids somebody has written their own words for. */
  editedIds(): Set<string>;
  /** Save. `null` restores the default, keeping the old words in `previous`. */
  write(id: PromptId, value: string | null, by?: { id: string; name: string }): PromptWriteResult;
}

/** An empty file, used whenever the real one cannot be read or parsed. */
function emptyFile(): PromptsFile {
  return { version: 1, prompts: {} };
}

/**
 * Parse what is on disk into a shape the rest of this module can trust.
 *
 * Anything unexpected collapses to "no override", one prompt at a time: a
 * record whose `value` is a number leaves that prompt on its default and
 * leaves the other six alone. A whole-file failure is what the caller's
 * try/catch turns into `emptyFile()`.
 */
export function parsePromptsFile(raw: string): PromptsFile {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') return emptyFile();
  const prompts = (parsed as { prompts?: unknown }).prompts;
  if (!prompts || typeof prompts !== 'object') return emptyFile();
  const out: Record<string, StoredPrompt> = {};
  for (const [id, rec] of Object.entries(prompts as Record<string, unknown>)) {
    if (!rec || typeof rec !== 'object') continue;
    const r = rec as StoredPrompt;
    const previous = Array.isArray(r.previous)
      ? r.previous.filter(
          (p): p is { value: string; replacedAt: number } =>
            Boolean(p) && typeof p === 'object' && typeof p.value === 'string',
        )
      : undefined;
    out[id] = {
      ...(typeof r.value === 'string' ? { value: r.value } : {}),
      ...(typeof r.updatedAt === 'number' ? { updatedAt: r.updatedAt } : {}),
      ...(r.updatedBy && typeof r.updatedBy === 'object' ? { updatedBy: r.updatedBy } : {}),
      ...(previous && previous.length > 0 ? { previous } : {}),
    };
  }
  return { version: 1, prompts: out };
}

/**
 * The override in force for one prompt, or null.
 *
 * Blank is null on purpose: deleting the words and blanking them are the same
 * gesture and get the same answer, which is the default.
 */
export function overrideOf(file: PromptsFile, id: string): string | null {
  const value = file.prompts[id]?.value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

export function createPromptStore(opts: { dataDir: string }): PromptStore {
  const path = join(opts.dataDir, PROMPTS_FILENAME);
  // What was announced last, so a stable failure is said once rather than per
  // call, and a change to it is said again.
  let announced: string | null = null;
  const announce = (message: string | null): void => {
    if (announced === message) return;
    announced = message;
    if (message) console.log(message);
  };
  /** Has the one-shot migration off `notes-prompt.md` been attempted? */
  let migrated = false;

  function load(): PromptsFile {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      // ENOENT is the ordinary case — nothing overridden — and says nothing.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        announce(`[prompts] cannot read ${path}; every prompt uses its default`);
      } else {
        announce(null);
      }
      return emptyFile();
    }
    try {
      const file = parsePromptsFile(raw);
      announce(null);
      return file;
    } catch {
      announce(`[prompts] ${path} is not valid JSON; every prompt uses its default`);
      return emptyFile();
    }
  }

  /**
   * Write the whole file, atomically.
   *
   * Temp-then-rename because the reader is every model call on this server: a
   * partially-written file is a tick that sends half a prompt, and the reader
   * has no way to tell that from a prompt somebody shortened.
   */
  function save(file: PromptsFile): boolean {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      renameSync(tmp, path);
      return true;
    } catch (err) {
      console.error(`[prompts] could not write ${path}: ${String(err)}`);
      return false;
    }
  }

  /**
   * Bring `<dataDir>/notes-prompt.md` forward, once.
   *
   * The notetaking instructions had their own file before this store existed,
   * and a deployment that edited it must not silently go back to the shipped
   * words the day the settings page ships. So the file's content becomes the
   * stored `meeting-notes` value the first time this store is touched, and
   * the file is never read again.
   *
   * The file is LEFT ON DISK and said so in the log. It is what the operator
   * wrote, and this store does not delete what it did not create — the same
   * soft-delete rule the restore button follows.
   */
  function migrateLegacyNotesPrompt(file: PromptsFile): PromptsFile {
    if (migrated) return file;
    migrated = true;
    if (Object.hasOwn(file.prompts, 'meeting-notes')) return file;
    const legacy = readNotesPromptFile(opts.dataDir);
    if (legacy === null) return file;
    const next: PromptsFile = {
      version: 1,
      prompts: { ...file.prompts, 'meeting-notes': { value: legacy, updatedAt: Date.now() } },
    };
    if (!save(next)) return file;
    console.log(
      `[prompts] moved ${join(opts.dataDir, NOTES_PROMPT_FILENAME)} into ${path}; ` +
        'that file is no longer read and has been left where it is',
    );
    return next;
  }

  function current(): PromptsFile {
    return migrateLegacyNotesPrompt(load());
  }

  return {
    path,
    read(id: PromptId): string {
      const def = promptDefinition(id);
      if (!def) return '';
      return overrideOf(current(), id) ?? def.default;
    },
    view(id: PromptId): PromptView {
      const def = promptDefinition(id);
      if (!def) return { value: '', isDefault: true };
      const override = overrideOf(current(), id);
      return { value: override ?? def.default, isDefault: override === null };
    },
    editedIds(): Set<string> {
      const file = current();
      const out = new Set<string>();
      for (const def of PROMPT_CATALOG) {
        if (overrideOf(file, def.id) !== null) out.add(def.id);
      }
      return out;
    },
    write(id, value, by): PromptWriteResult {
      const def = promptDefinition(id);
      if (!def || def.scope !== 'server') return { ok: false, error: 'unknown-prompt' };
      if (!def.editable) return { ok: false, error: 'read-only' };
      if (typeof value === 'string') {
        // An empty box is a slip far more often than a request to send no
        // instructions at all, and "the default" already has its own button.
        if (value.trim() === '') return { ok: false, error: 'empty' };
        if (value.length > PROMPT_MAX_CHARS) return { ok: false, error: 'too-long' };
      }
      const file = current();
      const record = file.prompts[id] ?? {};
      const previous = [...(record.previous ?? [])];
      // Never destroy what was written. Both a restore and an overwrite push
      // the words being replaced onto the history.
      if (
        typeof record.value === 'string' &&
        record.value.trim() !== '' &&
        record.value !== value
      ) {
        previous.push({ value: record.value, replacedAt: Date.now() });
      }
      const next: StoredPrompt = {
        ...(value === null ? {} : { value }),
        updatedAt: Date.now(),
        ...(by ? { updatedBy: { id: by.id, name: by.name } } : {}),
        ...(previous.length > 0 ? { previous } : {}),
      };
      const written: PromptsFile = {
        version: 1,
        prompts: { ...file.prompts, [id]: next },
      };
      return save(written) ? { ok: true } : { ok: false, error: 'write-failed' };
    },
  };
}
