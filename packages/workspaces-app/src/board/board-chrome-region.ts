/**
 * The chrome around the two panes: who is here, what is drifting, who YOU
 * are, and whether the settings panel is open.
 *
 * One responsibility — the top-right cluster and the panel behind its
 * button — and the thing that makes it one is the alarm. A drift notice in a
 * CLOSED panel is an alarm nobody sees, so the same function that writes the
 * notices decides whether the settings button wears its dot. Split into a
 * presence file and a settings file, that rule would have to be re-derived on
 * whichever side did not own it, and the `coverage` exemption (it renders
 * permanently by design, so an always-on dot is one nobody reads) would be a
 * comment in one file about a condition in another.
 *
 * The presence strip renders in TWO places from ONE loader, which is the
 * second reason: who is here goes in the top-right cluster and the drift
 * notices go inside the panel, and both are signal writes made in the same
 * breath from the same awareness read.
 *
 * `BoardChromeDeps` is the whole list of what this region may reach. It cannot
 * see the board's rows at all — presence is a fact about connections, not
 * about tasks.
 */
import type { FeedbackClient, User } from '@feedback/core';
import type { BootLocation } from '../boot-env.ts';
import type { BoardState } from './board-actions.ts';
import {
  type DriftNotice,
  type PresencePerson,
  clientDriftNotice,
  initialsOf,
  pluginDriftNotice,
  presenceChips,
} from './board-presence-model.ts';
import { defaultSigninHref, wireMeMenu } from './me-menu.ts';
import { driftData, presenceData } from './presence-island.tsx';

/** Everything the chrome needs from `bootBoard`, and nothing else. */
export interface BoardChromeDeps {
  /** The board's one projection: the agent list, the two releases and which
   *  chip is being followed. LIVE. */
  state: BoardState;
  /** Who the board thinks you are — the chip's initials and its tooltip. */
  user: Pick<User, 'name' | 'color'>;
  /** `getElementById`, already narrowed — `bootBoard`'s own `el`. */
  el(id: string): HTMLElement;
  /** The board doc's awareness feed: every tab connected to this workspace. */
  awareness: FeedbackClient['awareness'];
  /** The address bar the boot was handed. The me-menu reads it for the
   *  sign-in link's `next`, and reloads through it after a sign-out or a
   *  rename — this module is inside the boot, so it takes the injected one
   *  rather than reaching past it for the global. */
  location: Pick<BootLocation, 'pathname' | 'search' | 'reload'>;
}

/** What `bootBoard` keeps: the three renders, plus the awareness read the live
 *  wiring drives directly. */
export interface BoardChromeRegion {
  peopleFromAwareness(): PresencePerson[];
  renderPresenceRegion(): void;
  renderMe(): void;
  renderSettingsPanel(): void;
}

export function createBoardChromeRegion(deps: BoardChromeDeps): BoardChromeRegion {
  const { state, user, el, awareness, location } = deps;

  function peopleFromAwareness(): PresencePerson[] {
    const people: PresencePerson[] = [];
    awareness.getStates().forEach((aw, clientId) => {
      const s = aw as {
        user?: { id?: string; name?: string };
        surface?: string;
        docId?: string;
        lastActive?: number;
      };
      // A nameless entry draws no chip at all. Left exactly as it was — it is
      // a separate question from this migration, and worth its own ticket.
      if (!s?.user?.name) return;
      people.push({
        clientId,
        // Absent from a board tab still running a bundle that predates this
        // line. `presenceIdentity` falls back to that tab's own connection
        // there, so it keeps its own row and folds with nobody.
        userId: s.user.id,
        name: s.user.name,
        surface: s.surface ?? 'board',
        docId: s.docId,
        lastActive: s.lastActive ?? Date.now(),
        self: clientId === awareness.clientID,
      });
    });
    return people;
  }

  /**
   * The presence strip renders in TWO places: who is here goes in the
   * top-right cluster, and the drift notices go in the settings panel. Two
   * islands, one loader — this function is the whole vanilla half of the
   * bridge, and it is a pair of signal writes.
   *
   * A notice in a closed panel is an alarm nobody sees, so the settings button
   * carries a dot whenever something in there is asking for attention. The
   * `coverage` notice deliberately does not arm it: it renders permanently by
   * design, and an always-on dot is one nobody reads.
   */
  function renderPresenceRegion(): void {
    // Two signal writes, not two render calls: the islands mounted above own
    // the DOM from here on, and they re-render themselves keyed on the
    // participant — so a repaint that changes one person leaves everybody
    // else's circle as the identical node, mid-press and all.
    presenceData.value = {
      chips: presenceChips(peopleFromAwareness(), state.agents, Date.now()),
      followedKey: state.followedKey,
    };
    const notices = [
      pluginDriftNotice(state.pluginRelease),
      clientDriftNotice(state.clientRelease, Date.now()),
    ];
    driftData.value = notices;
    renderSettingsAlarm(notices);
  }

  /** What in the settings panel is asking to be looked at. */
  function renderSettingsAlarm(notices: Array<DriftNotice | null>): void {
    const armed = notices.some((n) => n !== null && n.kind !== 'coverage');
    el('board-settings-alarm').classList.toggle('hidden', !armed);
    // Both attributes, because the dot itself is `aria-hidden`: a reader who
    // never sees it would otherwise be told "Workspace settings" while the
    // button is visibly asking to be opened. `title` alone is announced
    // weakly or not at all depending on the reader.
    const label = armed ? 'Workspace settings — needs a look' : 'Workspace settings';
    el('board-settings').setAttribute('title', label);
    el('board-settings').setAttribute('aria-label', label);
  }

  /**
   * Who the board thinks you are. `ensureUserIdentity` has always decided
   * this — it is what stamps every comment and what "My Tasks" matches on —
   * and until now nothing rendered it, so a reader with the wrong name saved
   * found out by seeing their own comment signed by somebody else.
   */
  function renderMe(): void {
    const me = el('board-me');
    me.textContent = initialsOf(user.name);
    me.setAttribute('title', `You: ${user.name}`);
    me.setAttribute('aria-label', `You: ${user.name}`);
    if (user.color) me.style.background = user.color;
  }
  // The chip's menu — sign in / sign out. Wired once (buildShell above was
  // the last write of this subtree); renderMe only repaints the chip face.
  wireMeMenu({
    button: el('board-me'),
    menu: el('board-me-menu'),
    localName: user.name,
    signinHref: defaultSigninHref(location.pathname, location.search),
    // A reload after either, so no surface is left rendering the old session
    // or the old name.
    onSignedOut: () => location.reload(),
    onRenamed: () => location.reload(),
  });

  function renderSettingsPanel(): void {
    el('board-settings-panel').classList.toggle('hidden', !state.settingsOpen);
    el('board-settings').setAttribute('aria-expanded', String(state.settingsOpen));
  }

  return { peopleFromAwareness, renderPresenceRegion, renderMe, renderSettingsPanel };
}
