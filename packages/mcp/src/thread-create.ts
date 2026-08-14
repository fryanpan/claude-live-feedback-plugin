/**
 * Where a `create_thread` call goes.
 *
 * Two endpoints, and the choice between them is the whole decision: with a
 * `find` string the thread anchors to that text; without one it is about the
 * document itself. The second case exists because a hub task's discussion is
 * about the task, and a fresh task's description is empty — there is nothing
 * in it to find.
 */

export interface ThreadCreateInput {
  docId: string;
  /** Text to anchor to. Omit to open a thread on the subject. */
  find?: string;
  contextBefore?: string;
  contextAfter?: string;
  occurrence?: number;
  text: string;
}

export interface ThreadCreateRequest {
  path: string;
  body: Record<string, unknown>;
}

export function threadCreateRequest(
  input: ThreadCreateInput,
  author: unknown,
): ThreadCreateRequest {
  const doc = encodeURIComponent(input.docId);
  // Deliberately `=== undefined` rather than falsy: omitting `find` is a
  // choice, computing an empty one is an accident. An empty string keeps
  // going to by_find, which answers 400, instead of silently becoming a
  // comment on the whole document.
  if (input.find === undefined) {
    return {
      path: `/api/docs/${doc}/threads`,
      body: { author, text: input.text, anchor: { kind: 'subject' } },
    };
  }
  return {
    path: `/api/docs/${doc}/threads/by_find`,
    body: {
      author,
      text: input.text,
      find: input.find,
      ...(input.contextBefore !== undefined ? { contextBefore: input.contextBefore } : {}),
      ...(input.contextAfter !== undefined ? { contextAfter: input.contextAfter } : {}),
      ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
    },
  };
}
