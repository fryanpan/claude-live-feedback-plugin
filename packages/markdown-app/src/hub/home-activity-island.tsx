/**
 * The Home "Recent activity" pane, as a Preact island beside the review
 * queue — what is happening to the work, grouped BY TASK, never by agent
 * (Bryan, 2026-08-29: "I don't care who's doing the work, I care about the
 * work"). Sits under "For Your Review" and above "What's New?".
 *
 * Same bridge the review island rides: the vanilla loader owns the fetch and
 * writes the projected tasks it already holds into `homeActivityData`; the
 * island derives the groups (`homeActivity`, the pure model) and renders
 * them. No fetches, no subscriptions of its own; a background event's signal
 * write still waits for the reader's finger through the repaint-guard.
 *
 * One action only, and it is not on this island yet: commenting on a phrase
 * of a note line or the title. The lines are plain text — not buttons — so
 * a selection can land on them; the header row is the only tap, and it
 * opens the task. No hover hints, no comment box, no counters.
 *
 * Groups are keyed on the task id, so a signal write that changes one task's
 * lines leaves every other group's DOM node IDENTICAL — the property the
 * comment anchors (next) will lean on.
 */
import { signal } from '@preact/signals';
import { render } from 'preact';
import {
  type ActivityGroup,
  type ActivityInput,
  type ActivityNote,
  homeActivity,
} from './activity-model.ts';

export interface ActivityHandlers {
  /** The header row's one tap: open this task, the way a queue row does. */
  onOpenTask: (taskId: string) => void;
}

/** The one write target the vanilla side has: the projection as it stands.
 *  The island does the grouping, so the loader never learns the pane's
 *  rules and a rule change never touches hub-app. */
export const homeActivityData = signal<ActivityInput>({ tasks: [], goals: [], now: 0 });

/** The one line the pane shows when nothing has moved in a day. Names the
 *  plugin version whose hooks post the notes, because until an agent restarts
 *  on it the pane is empty for a reason the reader can act on. */
export const ACTIVITY_EMPTY =
  'Nothing yet — agents post a line per turn once they restart on 0.1.124.';

function NoteLine(props: { note: ActivityNote }) {
  const { note } = props;
  return (
    <div class={`hub-activity-note hub-activity-note-${note.kind}`}>
      <span class="acti-text">{note.text}</span>
      {' · '}
      <span class="acti-age">{note.age}</span>
      {note.agent !== undefined && note.agent !== '' && (
        <span>
          {' · '}
          <span class="acti-agent">{note.agent}</span>
        </span>
      )}
    </div>
  );
}

function Group(props: { group: ActivityGroup; handlers: ActivityHandlers }) {
  const { group, handlers } = props;
  const open = (): void => handlers.onOpenTask(group.taskId);
  return (
    <div class="acti-group" data-task-id={group.taskId}>
      {/* The queue's row anatomy — hairline, 44px floor, hover — as the group
          header. A div acting as a button rather than a <button>, because a
          button's text cannot be selected, and selecting a phrase of the
          title is how it gets commented on. */}
      {/* biome-ignore lint/a11y/useSemanticElements: the title must stay selectable text, which a <button> forbids; the div carries the role, the tab stop and the keys a button has. */}
      <div
        role="button"
        tabIndex={0}
        class="hub-review-row acti-head"
        title={`Open task: ${group.title}`}
        onClick={open}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            open();
          }
        }}
      >
        <span class={`acti-mark acti-mark-${group.status}`} aria-hidden="true" />
        <span class="hub-review-row-title acti-title-text">{group.title}</span>
        {group.flag && (
          <span class={`hub-badge hub-badge-${group.flag.replace('-', '')}`}>{group.flag}</span>
        )}
      </div>
      <div class="acti-notes">
        {group.notes.map((n) => (
          <NoteLine key={`${n.at}:${n.kind}:${n.text}`} note={n} />
        ))}
        {group.more > 0 && <div class="acti-more">{`+${group.more} more`}</div>}
      </div>
    </div>
  );
}

function HomeActivity(props: { handlers: ActivityHandlers }) {
  const groups = homeActivity(homeActivityData.value);
  return (
    <section class="hub-activity-card">
      <div class="hub-home-review-head">
        <h2 class="hub-home-heading">Recent activity</h2>
      </div>
      {groups.length === 0 && <p class="hub-home-quiet">{ACTIVITY_EMPTY}</p>}
      {groups.length > 0 && (
        <div class="acti-list">
          {groups.map((g) => (
            <Group key={g.taskId} group={g} handlers={props.handlers} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Mounts the pane into a wrapper it appends to `host` (`#hub-home-activity`);
 * returns the disposer. The island contract, as the review pane has it: the
 * wrapper — not the host — is Preact's container, disposal is render(null,
 * el), and no vanilla code may replaceChildren/innerHTML a container holding
 * the live island. Handlers are bound once at mount.
 */
export function mountHomeActivityIsland(host: HTMLElement, handlers: ActivityHandlers): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'home-activity');
  host.appendChild(el);
  render(<HomeActivity handlers={handlers} />, el);
  return () => {
    render(null, el);
    el.remove();
  };
}
