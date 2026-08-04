import { describe, expect, it } from 'vitest';
import { resolveAgentAuthor } from '../src/author.ts';

describe('resolveAgentAuthor', () => {
  it('defaults to the shared Agent identity with nothing configured', () => {
    const a = resolveAgentAuthor({});
    expect(a).toEqual({ name: 'Agent', color: '#e36f1e', id: 'known-agent', kind: 'known' });
  });

  it('FEEDBACK_AUTHOR=agent keeps the shared Agent identity (plugin default)', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AUTHOR: 'agent' });
    expect(a.id).toBe('known-agent');
  });

  it('FEEDBACK_AGENT_NAME synthesizes a distinct per-agent identity', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AUTHOR: 'agent', FEEDBACK_AGENT_NAME: 'Quick Build' });
    expect(a.name).toBe('Quick Build');
    expect(a.id).toBe('agent-quick-build');
    expect(a.kind).toBe('known');
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('FEEDBACK_AGENT_NAME beats FEEDBACK_AUTHOR (the plugin pins the latter)', () => {
    const a = resolveAgentAuthor({
      FEEDBACK_AUTHOR: 'bryan',
      FEEDBACK_AGENT_NAME: 'Weekly Review',
    });
    expect(a.name).toBe('Weekly Review');
  });

  it('the same name always maps to the same id and color', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AGENT_NAME: 'Quick Build' });
    const b = resolveAgentAuthor({ FEEDBACK_AGENT_NAME: 'Quick Build' });
    expect(b).toEqual(a);
  });

  it('an agent name matching a known user resolves to that known identity', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AGENT_NAME: 'Agent' });
    expect(a.id).toBe('known-agent');
  });

  it('whitespace-only FEEDBACK_AGENT_NAME falls through to FEEDBACK_AUTHOR', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AUTHOR: 'agent', FEEDBACK_AGENT_NAME: '   ' });
    expect(a.id).toBe('known-agent');
  });

  it('unknown FEEDBACK_AUTHOR values synthesize an identity too (no more silent Agent collapse)', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AUTHOR: 'Blog Assistant' });
    expect(a.name).toBe('Blog Assistant');
    expect(a.id).toBe('agent-blog-assistant');
  });

  it('names with no alphanumerics still get distinct non-empty ids', () => {
    const a = resolveAgentAuthor({ FEEDBACK_AGENT_NAME: '!!!' });
    const b = resolveAgentAuthor({ FEEDBACK_AGENT_NAME: '---' });
    expect(a.id).not.toBe('agent-');
    expect(b.id).not.toBe('agent-');
    expect(a.id).not.toBe(b.id);
  });
});
