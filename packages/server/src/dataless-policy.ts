/**
 * Letting this process download an online-only cloud file.
 *
 * macOS calls a file whose bytes live only in the provider's cloud
 * "dataless". Opening one normally blocks while the provider fetches it, but
 * whether the fetch is even ATTEMPTED is a property of the PROCESS, not the
 * file: `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES` decides, and children
 * inherit it. With it off, `open` on an evicted file fails immediately with
 * EDEADLK instead of downloading anything, which is what prod's launchd job
 * was doing to bound Dropbox docs.
 *
 * Measured rather than assumed, and only this much: a plain Bun process
 * started from a developer shell on this machine reads back 1 (OFF) before
 * the call below. So OFF is not something launchd does TO the server — it is
 * what a process gets unless it asks otherwise, which is what this asks. How
 * that default is arrived at, and whether any environment here starts ON, is
 * not established; do not let this comment grow a claim that it is.
 *
 * Bryan's call (2026-09-04) is that the server should do the download. A doc
 * bound to a file the owner has evicted to the cloud should come back with
 * its contents, not park empty, and the cost of fetching it is now bounded on
 * both sides: the deadline in `slow-fs.ts` means the main thread walks away
 * after three seconds, and the quarantine means the path is not asked again
 * for a minute. Before those existed this policy would have been reckless —
 * a synchronous read of an evicted file is exactly the wedge that restarted
 * the server twenty-one times.
 *
 * Turning it ON is therefore a decision about which failure the owner
 * prefers: a doc that takes a moment to open the first time after its file
 * was evicted, or a doc that cannot read its own file at all.
 */

/** `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES` — sys/resource.h. */
const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES = 3;
/** `IOPOL_SCOPE_PROCESS` — this process and everything it spawns. */
const IOPOL_SCOPE_PROCESS = 0;
/** `IOPOL_MATERIALIZE_DATALESS_FILES_ON`. (OFF is 1, DEFAULT is 0.) */
const IOPOL_MATERIALIZE_DATALESS_FILES_ON = 2;

export type DatalessPolicyResult =
  | { applied: true; before: number; after: number }
  | { applied: false; reason: 'not-darwin' | 'unavailable'; error?: string };

/**
 * Ask the kernel to materialize dataless files for this process.
 *
 * Called once at boot, BEFORE anything can read a bound file — the policy
 * only governs opens that happen after it is set. Non-darwin skips silently
 * (no such policy exists), and a failure is logged rather than thrown: a
 * server that will not start because it could not change an I/O preference is
 * a worse outcome than one that runs with the preference it already had.
 */
export async function enableDatalessMaterialization(): Promise<DatalessPolicyResult> {
  if (process.platform !== 'darwin') return { applied: false, reason: 'not-darwin' };
  try {
    // Imported here rather than at the top of the file so that no other
    // platform, and no test runner that is not Bun, ever loads `bun:ffi` to
    // reach a function that returns two lines above.
    const { dlopen, FFIType } = await import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      setiopolicy_np: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      getiopolicy_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    const read = (): number =>
      lib.symbols.getiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS);
    const before = read();
    const rc = lib.symbols.setiopolicy_np(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS,
      IOPOL_MATERIALIZE_DATALESS_FILES_ON,
    );
    // Report what the kernel says it is now, not what we asked for: a
    // non-zero return means the call was refused, and reading back is the
    // only way to know the difference between that and a silent no-op.
    const after = read();
    console.log(`[fs] dataless-materialize policy=${before}->${after}`);
    if (rc !== 0) {
      console.error(`[fs] setiopolicy_np returned ${rc}; dataless files may not materialize`);
    }
    return { applied: true, before, after };
  } catch (err) {
    console.error('[fs] could not set the dataless-materialize policy:', err);
    return {
      applied: false,
      reason: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * What the kernel currently reports, or `undefined` off darwin / when the
 * symbol cannot be reached. Exists so a caller — and the test — can assert
 * the policy that is actually in force rather than the one we asked for.
 */
export async function datalessMaterializationPolicy(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { dlopen, FFIType } = await import('bun:ffi');
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      getiopolicy_np: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    return lib.symbols.getiopolicy_np(
      IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
      IOPOL_SCOPE_PROCESS,
    );
  } catch {
    return undefined;
  }
}
