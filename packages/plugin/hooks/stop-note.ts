#!/usr/bin/env bun
/**
 * Stop hook for the claude-workspaces plugin.
 *
 * Posts the turn's closing message — reduced to ONE stripped line — to
 * `POST /api/agent-notes`, where the server pins it to the agent's current
 * task so the board's activity pane can say what each agent did lately.
 *
 * Never blocks the turn: no agent name, no message, a stop hook already
 * active, a missing server, a thrown fetch — every path exits 0 with no
 * output. The POST is capped at 1.5s. Logic lives in `lib/agent-notes.ts`.
 */
import { hookMain } from './lib/hook-main.ts';

void hookMain('turn');
