/**
 * A per-mount lifecycle scope. Everything a single document's mount sets up —
 * event listeners, the Yjs client, the editor, observers — is tied to one
 * scope, so navigating to another file is `scope.dispose()`: no leaked
 * listeners, no lingering sockets, no double-bind on the next mount.
 *
 * Register DOM listeners with `scope.listen(target, type, handler)` and
 * imperative teardown (client.close(), editor.destroy()) with `onCleanup`.
 * `signal` is exposed for fetch/AbortController-aware libraries.
 */
export class MountScope {
  private readonly controller = new AbortController();
  private readonly cleanups: Array<() => void> = [];
  private _disposed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /**
   * Register a DOM event listener bound to this scope's lifetime. Passes the
   * scope signal (real browsers auto-remove on abort) AND records an explicit
   * removeEventListener cleanup — the test env (happy-dom 15) ignores
   * `{ signal }`, so the explicit removal is what makes teardown testable. In a
   * real browser the signal already removed it and the second remove is a
   * harmless no-op.
   */
  listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void {
    if (this._disposed) return;
    target.addEventListener(type, handler, { ...options, signal: this.signal });
    this.onCleanup(() => target.removeEventListener(type, handler, options));
  }

  onCleanup(fn: () => void): void {
    // A callback registered after dispose (e.g. a resolved fetch on a
    // navigated-away page) must run now, not linger forever.
    if (this._disposed) {
      runSafely(fn);
      return;
    }
    this.cleanups.push(fn);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // LIFO: last thing set up is first torn down.
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      runSafely(this.cleanups[i]);
    }
    this.cleanups.length = 0;
    this.controller.abort();
  }
}

function runSafely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // One bad teardown must not strand the rest — a leaked socket is worse
    // than a logged error.
    console.error('[mount-scope] cleanup threw', err);
  }
}
