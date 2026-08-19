#!/usr/bin/env bun
/**
 * Example Linear integration: creates a Linear issue for each new comment
 * thread, and posts replies / status changes as Linear comments / state
 * transitions.
 *
 * This file is a reference, not a library. Copy it into your project and
 * adapt the LINEAR_* env vars + mapping logic.
 *
 * Required env:
 *   LINEAR_API_KEY     — personal or app API key
 *   LINEAR_TEAM_ID     — UUID of the target team
 *   LINEAR_PROJECT_ID  — optional project UUID to assign issues to
 */

// Types are inlined so this file can be copied into any project without
// depending on @feedback/core. The canonical shape lives in
// packages/core/src/types.ts.

interface Author {
  id: string;
  name: string;
  kind: 'known' | 'anon';
  color: string;
}
interface Comment {
  id: string;
  author: Author;
  text: string;
  ts: number;
}
interface Anchor {
  kind: 'text-range' | 'element' | 'orphan';
  snippet?: { text: string };
  original?: { snippet?: { text: string } };
}
interface Thread {
  id: string;
  status: 'open' | 'resolved';
  anchor: Anchor;
  createdBy: Author;
  comments: Comment[];
  commentCount: number;
  lastActivity: number;
}
interface WebhookPayload {
  event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened';
  docId: string;
  threadId: string;
  thread: Thread;
  doc: { docId: string; type: string; title?: string; sourceUrl?: string; createdAt: number };
  comment?: Comment;
  seq: number;
}

const LINEAR_URL = 'https://api.linear.app/graphql';

async function linear<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY not set');
  const res = await fetch(LINEAR_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: key,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`linear http ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`linear errors: ${JSON.stringify(body.errors)}`);
  if (!body.data) throw new Error('linear response missing data');
  return body.data;
}

// --- Storage: map threadId → Linear issueId (in-memory; use a DB in prod) ---
const map = new Map<string, string>();

function issueTitle(thread: Thread, docTitle: string | undefined): string {
  const first = thread.comments[0]?.text ?? '';
  const short = first.split('\n')[0]?.slice(0, 72) ?? 'New feedback';
  return `${short} — ${docTitle ?? thread.anchor.kind}`;
}

function issueBody(payload: WebhookPayload): string {
  const { thread, doc } = payload;
  const anchor =
    thread.anchor.kind === 'orphan'
      ? (thread.anchor.original?.snippet?.text ?? '')
      : (thread.anchor.snippet?.text ?? '');
  const comments = thread.comments
    .map((c: Comment) => `> **${c.author.name}** (${new Date(c.ts).toISOString()})\n> ${c.text}`)
    .join('\n\n');
  return `From Claude Workspaces on **${doc.type}** doc \`${doc.docId}\`\n\nAnchor: _${anchor}_\n\n${comments}`;
}

async function createIssue(payload: WebhookPayload): Promise<string> {
  const mutation = `mutation ($input: IssueCreateInput!) {
    issueCreate(input: $input) { issue { id identifier url } success }
  }`;
  const data = await linear<{
    issueCreate: { issue: { id: string; identifier: string; url: string }; success: boolean };
  }>(mutation, {
    input: {
      teamId: process.env.LINEAR_TEAM_ID,
      projectId: process.env.LINEAR_PROJECT_ID,
      title: issueTitle(payload.thread, payload.doc.title),
      description: issueBody(payload),
    },
  });
  return data.issueCreate.issue.id;
}

async function addIssueComment(issueId: string, body: string): Promise<void> {
  const mutation = `mutation ($input: CommentCreateInput!) {
    commentCreate(input: $input) { success }
  }`;
  await linear(mutation, { input: { issueId, body } });
}

async function handle(payload: WebhookPayload): Promise<void> {
  switch (payload.event) {
    case 'thread.created': {
      const id = await createIssue(payload);
      map.set(payload.threadId, id);
      break;
    }
    case 'thread.replied': {
      const id = map.get(payload.threadId);
      if (!id) return;
      const c = payload.comment;
      if (!c) return;
      await addIssueComment(id, `**${c.author.name}:** ${c.text}`);
      break;
    }
    case 'thread.resolved':
    case 'thread.reopened': {
      const id = map.get(payload.threadId);
      if (!id) return;
      const note =
        payload.event === 'thread.resolved' ? '✅ thread resolved' : '🔄 thread reopened';
      await addIssueComment(id, note);
      break;
    }
  }
}

const port = Number(process.env.PORT ?? 9100);

Bun.serve({
  port,
  async fetch(req) {
    if (req.method !== 'POST') return new Response('POST only', { status: 405 });
    const body = (await req.json()) as WebhookPayload;
    try {
      await handle(body);
      return new Response('ok');
    } catch (err) {
      console.error('[linear]', err);
      return new Response('internal error', { status: 500 });
    }
  },
});

console.log(`[linear-receiver] listening on http://localhost:${port}`);

export {};
