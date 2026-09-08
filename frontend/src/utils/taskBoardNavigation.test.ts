// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { captureTaskBoardOrigin, restoreTaskBoardOrigin } from './taskBoardNavigation';

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = '';
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 });
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() });
});

describe('Task board navigation restoration', () => {
  test('captures board scroll and originating card before pushing Task details', () => {
    document.body.innerHTML = '<div class="tasks-page-board-inner"></div>';
    const board = document.querySelector('.tasks-page-board-inner') as HTMLElement;
    board.scrollLeft = 360;

    captureTaskBoardOrigin('8ede2a98-de8f-4cfb-9e74-5891d545d6d9');

    expect(JSON.parse(sessionStorage.getItem('relayhall-task-board-origin') || '{}')).toEqual({
      taskId: '8ede2a98-de8f-4cfb-9e74-5891d545d6d9',
      boardScrollLeft: 360,
      windowScrollY: 240,
    });
  });

  test('restores scroll and focuses the originating named opener once', () => {
    sessionStorage.setItem('relayhall-task-board-origin', JSON.stringify({
      taskId: '8ede2a98-de8f-4cfb-9e74-5891d545d6d9', boardScrollLeft: 360, windowScrollY: 240,
    }));
    document.body.innerHTML = `
      <div class="tasks-page-board-inner"></div>
      <button class="task-card-open-button" data-task-id="8ede2a98-de8f-4cfb-9e74-5891d545d6d9">Open</button>`;
    const opener = document.querySelector('button') as HTMLButtonElement;
    const focus = vi.spyOn(opener, 'focus');

    expect(restoreTaskBoardOrigin()).toBe(true);
    expect((document.querySelector('.tasks-page-board-inner') as HTMLElement).scrollLeft).toBe(360);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 240, behavior: 'auto' });
    expect(focus).toHaveBeenCalled();
    expect(sessionStorage.getItem('relayhall-task-board-origin')).toBeNull();
    expect(restoreTaskBoardOrigin()).toBe(false);
  });
});

// Review 7fc68646 B2 — the routed return must restore the MAP, not only the
// board. restoreTaskBoardOrigin required both `.tasks-page-board-inner` and
// `.task-card-open-button[data-task-id]`; the Map has neither, so a Map return
// restored nothing AND left the one-shot origin unconsumed for a later visit
// to match.

const TASK = '8466bafe-12bd-4ee2-bcc4-c9609b528c8f';

describe('routed return restores whichever surface the Task was opened from', () => {
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '';
  });

  test('a Map opener regains focus and the one-shot origin is consumed', () => {
    captureTaskBoardOrigin(TASK, '/tasks?view=map&statuses=todo');
    document.body.innerHTML =
      `<button class="task-card-map-open" data-task-id="${TASK}"></button>`;

    expect(restoreTaskBoardOrigin()).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.task-card-map-open'));
    expect(sessionStorage.getItem('relayhall-task-board-origin')).toBeNull();
  });

  // The three tests below are PRESERVATION PINS, green on the reviewed bytes
  // too: the board path already worked, and a failed match already left the
  // record alone. They exist so that making the helper view-aware cannot
  // quietly regress board return, resurrect a consumed origin, or let a stale
  // origin from an earlier visit take focus on an unrelated Task.
  test('the board opener still wins when both surfaces are present', () => {
    captureTaskBoardOrigin(TASK, '/tasks');
    document.body.innerHTML =
      `<div class="tasks-page-board-inner"></div>` +
      `<button class="task-card-open-button" data-task-id="${TASK}"></button>` +
      `<button class="task-card-map-open" data-task-id="${TASK}"></button>`;

    expect(restoreTaskBoardOrigin()).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.task-card-open-button'));
  });

  test('no matching opener leaves the origin intact, so the retry can still work', () => {
    captureTaskBoardOrigin(TASK, '/tasks?view=map');
    document.body.innerHTML = '<div class="tasks-page-board-inner"></div>';

    expect(restoreTaskBoardOrigin()).toBe(false);
    expect(sessionStorage.getItem('relayhall-task-board-origin')).not.toBeNull();
  });

  test('an origin for a DIFFERENT task never steals focus', () => {
    captureTaskBoardOrigin(TASK, '/tasks?view=map');
    document.body.innerHTML =
      '<button class="task-card-map-open" data-task-id="ffffffff-ffff-4fff-8fff-ffffffffffff"></button>';

    expect(restoreTaskBoardOrigin()).toBe(false);
  });
});
