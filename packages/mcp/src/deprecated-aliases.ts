/**
 * The names these tools answered to before the product's own words won.
 *
 * A board is *attached* to, a mockup is an *attachment*, a comment is *spun
 * off* into a task, and a finished board is *archived* — those are the words
 * the UI, the docs and the skills use, and four MCP verbs used different ones
 * (`bind_folder`, `bind_mock`, `promote_to_task`, `retire_workspace`). The
 * rename is in `tool-schemas.ts`; this file is the other half of it.
 *
 * The second wave is the word *review* itself, which carried two senses on
 * one surface: a review ITEM somebody answers, and a SET of docs, mockups,
 * previews and diffs filed on a board. The code and every user-visible string
 * settled the second sense on *attachment* / *attachment set* (see
 * `packages/core/src/attachment.ts` and the glossary), leaving seven verbs
 * that still said review where they meant a set of files. An agent reading
 * the tool list could not tell which sense a verb meant, which is the whole
 * cost of a word doing two jobs. So the set verbs took the noun the rest of
 * the product uses, and `create_review_doc` — which binds one markdown file —
 * became `attach_markdown`, beside `attach_mockup` and `attach_folder`.
 * (`attach_doc` was already taken, and means something else: it FILES an
 * existing doc onto a board.) The five `*_review_item` verbs and
 * `create_diff_review` keep the word: they mean the sense that survived.
 *
 * An alias is kept because a peer's plugin cache is not this repo: a session
 * running last week's bundle, or an agent working from memory or a stale
 * skill, still reaches for the old name, and answering "unknown tool" to it
 * costs somebody a turn to discover a rename they had no way to see. So the
 * old name keeps landing on the same arm for ONE release, and says so once.
 *
 * Once per PROCESS, not once per call. The warning is for the human reading
 * the MCP log after something looked odd; repeated on every call it is noise
 * that scrolls the rest of the log away, and a rename that fires a hundred
 * lines reads like a fault rather than a notice. It goes to stderr because
 * stdout is the JSON-RPC transport — a line written there corrupts the
 * protocol frame it lands in the middle of.
 *
 * `tool-wiring.test.ts` asserts each pair really is one fall-through arm, and
 * that the old name is not advertised in `tools/list`: one name for one thing
 * in the table an agent reads, both names accepted on the wire.
 */

/** Old name → the name it now shares its dispatch arm with. */
export const DEPRECATED_TOOL_ALIASES: Readonly<Record<string, string>> = {
  bind_folder: 'attach_folder',
  bind_mock: 'attach_mockup',
  promote_to_task: 'spin_off_task',
  retire_workspace: 'archive_workspace',
  // The roster read followed its route off `attachments`: an *attachment* is
  // a doc, mockup, preview or diff filed on a board, and this tool has always
  // listed the SESSIONS sitting at one.
  list_attachments: 'list_agents',
  // The `review` → `attachment set` wave. Four of these are set-scoped and
  // take a `setId`; `list_archived_attachments` answers for both grains,
  // whole sets and single docs, which is why it is not `…_attachment_sets`.
  create_review_doc: 'attach_markdown',
  delete_review: 'delete_attachment_set',
  archive_review: 'archive_attachment_set',
  unarchive_review: 'unarchive_attachment_set',
  list_archived_reviews: 'list_archived_attachments',
  refresh_review: 'refresh_attachment_set',
  set_review_groups: 'set_attachment_groups',
};

/*
 * `refresh_workspace` and `set_workspace_groups` — the names those two verbs
 * had two generations back — are deliberately NOT in the table, though their
 * arms in `tools/docs.ts` still answer them. Every key here is also swept out
 * of the prose by `deprecated-aliases.test.ts`, and a plan doc tells the
 * story of `set_goal_list` being renamed to avoid colliding with
 * `set_workspace_groups`. That sentence is about the NAME, so rewriting it
 * would make the record say something that did not happen. The sweep cannot
 * tell a name nobody should type again from a name a history has to spell,
 * so a name that only history still uses stays out of it.
 */

/** The one line, so the test and the log cannot drift apart. */
export function deprecationLine(alias: string, now: string): string {
  return `[mcp] ${alias} is the old name for ${now} — still answered this release, removed in the next. Call ${now}.`;
}

/**
 * A warner with its own "already said it" set.
 *
 * A factory rather than a bare function so a test can drive the once-only
 * behaviour without reaching into module state, and so the log sink is
 * injectable — `console.error` is the default because that is where every
 * other line `mcp.ts` writes goes.
 */
export function createAliasDeprecationWarner(
  log: (line: string) => void = (line) => console.error(line),
): (name: string) => void {
  const warned = new Set<string>();
  return (name: string): void => {
    const now = DEPRECATED_TOOL_ALIASES[name];
    if (now === undefined || warned.has(name)) return;
    warned.add(name);
    log(deprecationLine(name, now));
  };
}

/** The process-wide warner: "once per session" is once per MCP process. */
export const warnDeprecatedAlias = createAliasDeprecationWarner();
