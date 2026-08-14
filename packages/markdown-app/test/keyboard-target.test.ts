import { describe, expect, it } from 'vitest';
import { eventPath, typingInPath } from '../src/keyboard-target.ts';
import { errorCodeOf, recognitionErrorMessage } from '../src/voice-capture.ts';

describe('typingInPath', () => {
  // The bug this exists for: a keydown inside the feedback widget's shadow
  // root reaches a document listener with `target` = the HOST element, so the
  // old `target.closest('input, textarea')` guard matched nothing and the
  // board's hotkeys fired while Bryan typed his feedback. Everything here
  // goes through composedPath, which is the only view that sees the input.
  function shadowInput(): { host: HTMLElement; input: HTMLInputElement } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    root.append(input);
    return { host, input };
  }

  it('blocks a keydown typed inside an embedded component, host retargeting and all', () => {
    const { host, input } = shadowInput();
    // Positive control: the OLD guard's view of this event is the host, and
    // the host is not an input — i.e. this really is the shape that escaped.
    expect(host.closest('input, textarea, select, [contenteditable]')).toBeNull();
    expect(typingInPath([input, host, document])).toBe(true);
  });

  // The shadow-root guard on its own, with no input anywhere in the path —
  // otherwise the case above passes on the `closest('input')` branch and the
  // guard that generalises to any embedded component is never exercised. The
  // widget has plenty of non-input controls whose keys are still its own.
  it('blocks a keydown on a NON-input element inside a shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    shadow.append(button);
    expect(button.closest('input, textarea, select, [contenteditable]')).toBeNull();
    expect(typingInPath([button, host, document])).toBe(true);
  });

  it('blocks a keydown in a plain light-DOM input, textarea or contenteditable', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', '');
    const inner = document.createElement('span');
    ce.append(inner);
    document.body.append(input, textarea, ce);
    expect(typingInPath([input, document])).toBe(true);
    expect(typingInPath([textarea, document])).toBe(true);
    expect(typingInPath([inner, ce, document])).toBe(true);
  });

  it('lets a keydown on the board itself through', () => {
    const row = document.createElement('div');
    row.className = 'hub-task-row';
    document.body.append(row);
    expect(typingInPath([row, document.body, document])).toBe(false);
    // An empty path (a synthesized event with no target) must not wedge the
    // hotkeys off — the failure mode of over-blocking is a dead keyboard.
    expect(typingInPath([])).toBe(false);
    expect(typingInPath([document])).toBe(false);
  });
});

describe('eventPath', () => {
  it('prefers composedPath, which is the only view that sees through a shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    shadow.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, composed: true }));

    let seen: readonly (EventTarget | undefined)[] = [];
    const onKey = (ev: Event) => {
      seen = eventPath(ev);
    };
    document.addEventListener('keydown', onKey);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, composed: true }));
    document.removeEventListener('keydown', onKey);

    // The bug, stated as an assertion: at the document listener the event's
    // own `target` is the HOST, so anything reading `ev.target` is looking at
    // the wrong element. eventPath must hand back the input regardless.
    expect(seen[0]).toBe(input);
    expect(typingInPath(seen)).toBe(true);
  });
});

describe('recognition errors are named, not swallowed', () => {
  it('reads the error code off the event, and only a real string counts', () => {
    expect(errorCodeOf({ error: 'not-allowed' })).toBe('not-allowed');
    expect(errorCodeOf({})).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
    expect(errorCodeOf({ error: '' })).toBeNull();
  });

  it('explains a mic blocked by an insecure context instead of blaming silence', () => {
    // This is the case behind "voice is just broken": Chrome gates the mic on
    // a secure context, the hubs are plain http at a hostname, and the old
    // handler turned the refusal into an empty transcript.
    const msg = recognitionErrorMessage('not-allowed');
    expect(msg).toContain('https');
    expect(msg).not.toBe("Didn't catch anything.");
    expect(recognitionErrorMessage('service-not-allowed')).toBe(msg);
    // A genuinely silent hold still reads as silence.
    expect(recognitionErrorMessage('no-speech')).toBe("Didn't catch anything.");
    // An unrecognised code still names itself rather than vanishing.
    expect(recognitionErrorMessage('weird-new-code')).toContain('weird-new-code');
  });
});
