#!/usr/bin/env bun
/**
 * PermissionDenied hook for the claude-workspaces plugin.
 *
 * When auto mode denies a tool call, posts the call's SHAPE — the first two
 * tokens of a Bash command (`git rm`), or just the tool name for anything
 * else; never a path, URL, token or argument — to `POST /api/agent-notes`,
 * so the activity pane can show what an agent kept being refused.
 *
 * The first time it fires on a machine it logs the payload's top-level key
 * NAMES (never values) to stderr, so the live shape is learned. Never blocks
 * the turn: every path exits 0. Logic lives in `lib/agent-notes.ts`.
 */
import { hookMain } from './lib/hook-main.ts';

void hookMain('denial');
