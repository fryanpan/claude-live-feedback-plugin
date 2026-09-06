/**
 * Editing the words in a doc: whole-doc rewrites, find-and-replace, the
 * anchored edits a comment thread drives, suggestions, and block insert and
 * delete.
 *
 * Split out of `doc-store.ts`, which keeps the doc lifecycle these operate on.
 * Almost every verb here is a thin, deliberate wrapper: resolve the doc,
 * hand the `Y.Doc` to `prose` or `suggestOps`, return what it says. The
 * value of gathering them is that the wrapping is the SAME each time —
 * a missing doc is one answer, not eleven — and that is easier to hold
 * true in one file than scattered through six thousand lines of lifecycle.
 *
 * What it needs from the store is four things, named in `DocEditPersistence`
 * rather than reached for through a `this` that also owns eviction, file
 * watchers and the websocket fan-out.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Thread, contentKind, prose, suggestOps } from '@feedback/core';
import * as Y from 'yjs';
import type { LiveDoc } from './doc-store.ts';

/** Backups kept per doc by `backupReplacedContent` before rotation. */
const REPLACE_BACKUP_CAP = 20;

/** What a doc-edit verb may reach in the store, and nothing else. */
export interface DocEditPersistence {
  /** Where backups are written. Read at call time: the store builds this
   *  seam in a field initialiser, before its own config is assigned. */
  dataDir(): string;
  /** The hydrated doc behind a docId or alias, or nothing. */
  doc(docId: string): LiveDoc | undefined;
  thread(docId: string, threadId: string): Thread | null;
  /** Bump the doc's sequence and broadcast one suggestion event. */
  announceSuggestion(
    doc: LiveDoc,
    event: 'suggestion.created' | 'suggestion.accepted' | 'suggestion.rejected',
    sid: string,
    summary: suggestOps.SuggestionSummary | undefined,
  ): void;
}

/** The editing verbs. One per `DocStore`; its only state is the backup counter,
 *  which nothing outside a backup has ever read. */
export class DocEditOps {
  private backupSeq = 0;

  constructor(private readonly p: DocEditPersistence) {}

  /**
   * Snapshot the markdown a whole-doc rewrite is about to replace into
   * `<dataDir>/backups/<docId>/<ts>-<seq>.md`, rotating to a cap. Runs on
   * EVERY accepted set_doc_content — including a confirmed overwrite — so
   * "the guard was bypassed" is never the same event as "the words are
   * gone". Backups are transient files: rotation hard-deletes the oldest.
   * Never throws; the rewrite proceeds either way.
   */
  private backupReplacedContent(docId: string, content: string): string | null {
    try {
      const safeId = docId.replace(/[^A-Za-z0-9._-]/g, '_');
      const dir = join(this.p.dataDir(), 'backups', safeId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const seq = String(this.backupSeq++).padStart(6, '0');
      const file = join(dir, `${Date.now()}-${seq}.md`);
      writeFileSync(file, content);
      const entries = readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      for (const stale of entries.slice(0, Math.max(0, entries.length - REPLACE_BACKUP_CAP))) {
        rmSync(join(dir, stale), { force: true });
      }
      return file;
    } catch (err) {
      console.error(`[doc-store] set_doc_content backup failed for ${docId}:`, err);
      return null;
    }
  }

  setDocContent(
    docId: string,
    markdown: string,
  ): { ok: true } | { ok: false; error: 'not-found' | 'unsupported' | 'empty' | 'parse-failed' } {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    // Flat docs (code / diff) are read-only review surfaces; their content
    // comes from disk or a pinned commit, never from an agent payload.
    if (contentKind(doc.meta.type) !== 'prose') return { ok: false, error: 'unsupported' };
    if (!markdown.trim()) return { ok: false, error: 'empty' };
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(markdown);
    } catch {
      return { ok: false, error: 'parse-failed' };
    }
    if (blocks.length === 0) return { ok: false, error: 'empty' };
    const fragment = prose.getProseFragment(doc.ydoc);
    // Backup-on-replace: whatever the doc holds right now survives this
    // rewrite on disk, whoever wrote it and whatever the caller believed.
    this.backupReplacedContent(docId, prose.serializeFragmentToMarkdown(fragment));
    // A doc-side edit origin (NOT 'file-watch'): the write-back observer must
    // see this and flush it to disk like any other agent edit.
    doc.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, markdown);
    }, 'agent-set-content');
    prose.normalizeHeadingLevels(doc.ydoc);
    return { ok: true };
  }

  /**
   * Replace `find` with `replace` inside the doc. Optional context
   * string around the match disambiguates repeated phrases; pass
   * `occurrence` to pick by index when you know the match count.
   */
  findAndReplace(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      /** Replace EVERY occurrence in one transaction. See prose.findAndReplace. */
      replaceAll?: boolean;
      parseInlineMarks?: boolean;
    },
  ): prose.ReplaceResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.findAndReplace(doc.ydoc, opts);
  }

  /**
   * Rewrite the range a text-range thread is anchored to. The thread
   * anchor is authoritative — we never recompute offsets on the
   * client. When the anchor is orphaned (user deleted the text) the
   * caller gets `anchor-orphaned` back and should either re-anchor or
   * fall back to `findAndReplace`.
   */
  rewriteThreadRegion(
    docId: string,
    threadId: string,
    replacement: string,
    opts?: { parseInlineMarks?: boolean },
  ): prose.AnchoredEditResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.rewriteRange(doc.ydoc, {
      startRel: thread.anchor.startRel,
      endRel: thread.anchor.endRel,
      replacement,
      parseInlineMarks: opts?.parseInlineMarks === true,
    });
  }

  /**
   * Agent anchors — the agent can mint its own named pointers into the
   * doc for batch edits. Stored separately from comment threads.
   */
  createAgentAnchor(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      label?: string;
    },
  ): prose.CreateAnchorResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.createAgentAnchor(doc.ydoc, opts);
  }

  editAtAgentAnchor(
    docId: string,
    anchorId: string,
    op: { kind: 'replace'; text: string } | { kind: 'insert_after'; text: string },
  ): prose.AnchoredEditResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const anchor = prose.readAgentAnchor(doc.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-not-found' };
    if (op.kind === 'replace') {
      return prose.rewriteRange(doc.ydoc, {
        startRel: anchor.startRel,
        endRel: anchor.endRel,
        replacement: op.text,
      });
    }
    return prose.insertAfterRange(doc.ydoc, { endRel: anchor.endRel, text: op.text });
  }

  deleteAgentAnchor(docId: string, anchorId: string): boolean {
    const doc = this.p.doc(docId);
    if (!doc) return false;
    return prose.deleteAgentAnchor(doc.ydoc, anchorId);
  }

  // =========================================================================
  // Suggested edits (redline-suggestions phase 2). Thin wrappers over the
  // core suggest-ops: suggestions ARE marks in the prose fragment, so every
  // operation rescans at execution time — no registry to keep in sync, and a
  // sid that raced away (double-accept, external rewrite) reports not-found.
  // All mutations run under the same 'agent' transaction origin the other
  // agent edit tools use: the write-back observer flushes results to disk;
  // a browser UndoManager never tracks them.
  // =========================================================================

  /** All pending proposals on the doc, in doc order. Empty for unknown docs
   *  and for flat (code/diff) docs, whose prose fragment has no content. */
  listSuggestions(docId: string): suggestOps.SuggestionSummary[] {
    const doc = this.p.doc(docId);
    if (!doc) return [];
    return suggestOps.listSuggestions(doc.ydoc);
  }

  /**
   * The suggestion-creation primitive: same find/context/occurrence matching
   * as findAndReplace, but the replacement is written AS A PROPOSAL — the
   * matched text marked suggestDelete, the new text inserted with
   * suggestInsert, one shared sid, author from the caller. The doc's
   * accepted state (and therefore disk) is unchanged until accepted.
   */
  createSuggestion(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
    },
  ):
    | { ok: true; suggestionId: string }
    | {
        ok: false;
        // `match-in-pending-suggestion`: the find only matched text that is
        // itself an unaccepted proposal — anchoring here would make this
        // proposal vanish when the other one is rejected.
        error: 'not-found' | 'no-match' | 'ambiguous' | 'match-in-pending-suggestion';
        candidates?: Array<{ docOffset: number; preview: string }>;
      } {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const res = suggestOps.suggestReplace(doc.ydoc, opts);
    if (!res.ok) return res;
    this.p.announceSuggestion(
      doc,
      'suggestion.created',
      res.sid,
      suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === res.sid),
    );
    return { ok: true, suggestionId: res.sid };
  }

  /**
   * The `rewrite_thread_region` twin of `createSuggestion`: propose the
   * rewrite of a thread's anchored range instead of applying it directly.
   * Same anchor resolution as `rewriteThreadRegion` — `anchor-orphaned` if
   * the user deleted the anchored text, `cross-block` if the range somehow
   * spans two blocks (shouldn't happen for a single-thread anchor, but
   * mirrors `rewriteRange`'s own restriction).
   */
  createSuggestionForThread(
    docId: string,
    threadId: string,
    opts: {
      replacement: string;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
      ts?: number;
    },
  ):
    | { ok: true; suggestionId: string }
    | { ok: false; error: 'anchor-not-found' | 'anchor-orphaned' | 'cross-block' } {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    const res = suggestOps.suggestRewriteRange(doc.ydoc, {
      startRel: thread.anchor.startRel,
      endRel: thread.anchor.endRel,
      replacement: opts.replacement,
      parseInlineMarks: opts.parseInlineMarks === true,
      author: opts.author,
      ts: opts.ts,
    });
    if (!res.ok) return res;
    this.p.announceSuggestion(
      doc,
      'suggestion.created',
      res.sid,
      suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === res.sid),
    );
    return { ok: true, suggestionId: res.sid };
  }

  /** Accept a proposal: it becomes real content and flows to disk via the
   *  normal debounced write-back. Missing sid (or doc) → not-found — also
   *  the correct answer to the double-accept race. */
  acceptSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const before = suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === sid);
    const res = suggestOps.acceptSuggestion(doc.ydoc, sid);
    if (res.ok) this.p.announceSuggestion(doc, 'suggestion.accepted', sid, before);
    return res;
  }

  /** Reject a proposal: restores exactly the pre-suggestion text. */
  rejectSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const before = suggestOps.listSuggestions(doc.ydoc).find((s) => s.sid === sid);
    const res = suggestOps.rejectSuggestion(doc.ydoc, sid);
    if (res.ok) this.p.announceSuggestion(doc, 'suggestion.rejected', sid, before);
    return res;
  }

  /** Accept or reject every pending proposal (optionally one author's). */
  resolveAllSuggestions(
    docId: string,
    opts: { action: 'accept' | 'reject'; authorId?: string },
  ): { ok: true; resolved: number; sids: string[] } | { ok: false; error: 'not-found' } {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'not-found' };
    const before = new Map(suggestOps.listSuggestions(doc.ydoc).map((s) => [s.sid, s]));
    const res = suggestOps.resolveAllSuggestions(doc.ydoc, opts);
    const event = opts.action === 'accept' ? 'suggestion.accepted' : 'suggestion.rejected';
    for (const sid of res.sids) {
      this.p.announceSuggestion(doc, event, sid, before.get(sid));
    }
    return res;
  }

  /**
   * Parse markdown into block elements and insert them as siblings
   * immediately after the block that contains the agent anchor.
   * Use this for adding new headings / paragraphs / lists / tables —
   * `edit_at_anchor` with `insert_after` does a character-stream
   * insert which keeps the new text inside the anchor's block,
   * producing literal `## Heading` text instead of a heading element.
   */
  insertBlocksAtAnchor(
    docId: string,
    anchorId: string,
    markdown: string,
    opts?: { placement?: prose.BlockPlacement },
  ): prose.AnchoredEditResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const anchor = prose.readAgentAnchor(doc.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-not-found' };
    return prose.insertBlocksAfterAnchor(doc.ydoc, {
      anchorRel: anchor.endRel,
      markdown,
      placement: opts?.placement,
    });
  }

  /** Append text at the END position of a thread's anchored range. */
  insertAfterThread(docId: string, threadId: string, text: string): prose.AnchoredEditResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.insertAfterRange(doc.ydoc, { endRel: thread.anchor.endRel, text });
  }

  /**
   * Parse markdown into block elements and insert them immediately
   * after the block that contains the thread's anchor. Use this for
   * "add a section below this comment" — the anchor picks the
   * location, the markdown describes the new blocks.
   */
  insertBlocksAfterThread(
    docId: string,
    threadId: string,
    markdown: string,
    opts?: { placement?: prose.BlockPlacement },
  ): prose.AnchoredEditResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-not-found' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.insertBlocksAfterAnchor(doc.ydoc, {
      anchorRel: thread.anchor.endRel,
      markdown,
      placement: opts?.placement,
    });
  }

  /**
   * Delete the single block containing a thread's anchored range. Use
   * for "remove the paragraph this comment points at." Empty-string
   * find_and_replace cannot do this — it removes text but leaves the
   * empty block element behind.
   */
  deleteBlockAtThread(docId: string, threadId: string): prose.DeleteBlockResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-orphaned' };
    const thread = this.p.thread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-orphaned' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.deleteBlockAtAnchor(doc.ydoc, { anchorRel: thread.anchor.startRel });
  }

  /** Same, keyed on an agent anchor. */
  deleteBlockAtAgentAnchor(docId: string, anchorId: string): prose.DeleteBlockResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'anchor-orphaned' };
    const anchor = prose.readAgentAnchor(doc.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-orphaned' };
    return prose.deleteBlockAtAnchor(doc.ydoc, { anchorRel: anchor.startRel });
  }

  /** Delete every top-level block from start match through end match.
   *  Block-inclusive — partial match still deletes the whole block. */
  deleteBlocksInRange(
    docId: string,
    opts: {
      startFind: string;
      endFind: string;
      contextBefore?: string;
      contextAfter?: string;
      startOccurrence?: number;
      endOccurrence?: number;
    },
  ): prose.DeleteBlocksInRangeResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.deleteBlocksInRange(doc.ydoc, opts);
  }

  /** Delete a heading block + everything until the next heading at ≤ level. */
  deleteSection(
    docId: string,
    opts: { heading: string; level?: number; occurrence?: number },
  ): prose.DeleteSectionResult {
    const doc = this.p.doc(docId);
    if (!doc) return { ok: false, error: 'no-match' };
    return prose.deleteSection(doc.ydoc, opts);
  }

  /**
   * Sweep every text-range thread in a doc and best-effort re-anchor
   * the ones whose Y.RelativePosition no longer resolves. Idempotent —
   * safe to call on every significant doc change.
   */
  autoReanchor(docId: string): { checked: number; reanchored: number; stillOrphan: number } | null {
    const doc = this.p.doc(docId);
    if (!doc) return null;
    return prose.autoReanchorDoc(doc.ydoc);
  }
}
