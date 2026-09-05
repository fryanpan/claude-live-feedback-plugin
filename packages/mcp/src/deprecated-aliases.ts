/**
 * The names four tools answered to before the product's own words won.
 *
 * A board is *attached* to, a mockup is an *attachment*, a comment is *spun
 * off* into a task, and a finished board is *archived* — those are the words
 * the UI, the docs and the skills use, and four MCP verbs used different ones
 * (`bind_folder`, `bind_mock`, `promote_to_task`, `retire_workspace`). The
 * rename is in `tool-schemas.ts`; this file is the other half of it.
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
};

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
