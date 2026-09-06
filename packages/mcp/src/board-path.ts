/**
 * The board a tool call is addressed under, and the path prefix built from it.
 *
 * Every resource this server owns is addressed as
 * `/workspaces/<workspaceId>/<collection>/<id>`, so the board is not context a
 * tool can carry implicitly — it is part of the address, and a call that does
 * not name one has not named a resource. `workspaceId` is therefore a
 * REQUIRED argument on every tool that takes a bare id, and this is the one
 * place that requirement is enforced.
 *
 * One module rather than a copy per tool family: the three families all build
 * the same prefix, and three spellings of one rule is how the rule starts
 * differing in its error message and then in what it accepts.
 *
 * It THROWS rather than answering an error result, because the CallTool
 * dispatcher turns a thrown Error into exactly that result (see
 * `call-tool.ts`). That keeps this one call at each of the ~90 sites instead
 * of a branch at each of them.
 */

import { DEPRECATED_TOOL_ALIASES } from './deprecated-aliases.ts';

/** The board id this call named, or a refusal that says what is missing. */
export function boardIdOf(toolName: string, args: Record<string, unknown>): string {
  const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
  if (workspaceId === '') {
    // The CURRENT name, even when the caller used a deprecated alias. A
    // renamed tool reaches the same arm with the same arguments and must give
    // the same reply (tool-wiring.test.ts asserts exactly that), and the name
    // a reader should go look up is the one still in the tool list. The
    // rename itself is already announced once per session by the alias warner.
    const now = DEPRECATED_TOOL_ALIASES[toolName] ?? toolName;
    throw new Error(
      `${now} needs a workspaceId — every resource is addressed under the board that owns it. Pass the board id create_workspace returned; get_workspace lists what you are attached to.`,
    );
  }
  return workspaceId;
}

/** `/workspaces/<id>`, ready to have a collection appended. */
export function boardPathOf(toolName: string, args: Record<string, unknown>): string {
  return `/workspaces/${encodeURIComponent(boardIdOf(toolName, args))}`;
}
