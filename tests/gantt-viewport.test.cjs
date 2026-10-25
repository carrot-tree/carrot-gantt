/* Calendar-anchored viewport regressions; no real vault or DOM access. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, projectNote, project, task } = require('./gantt-test-harness.cjs');

const day = (value) => new Date(`${value}T00:00:00`);
const daysBetween = (start, end) => Math.round((end.valueOf() - start.valueOf()) / 86400000);
const pane = (options = {}) => ({ isConnected: true, scrollLeft: 0, scrollTop: 0, clientWidth: 600, scrollWidth: 10000, ...options });

test('searching away a distant historical project keeps the same visible calendar date', () => {
    const h = harness({ notes: [projectNote('Old'), projectNote('Current')] });
    h.view.board = { projects: [
        project('Old', [task('Old task', { start: '2010-01-01', end: '2010-01-01' })], { start: '2010-01-01', end: '2010-01-01' }),
        project('Current', [task('Current task', { start: '2026-10-23', end: '2026-10-23' })], { start: '2026-10-23', end: '2026-10-23' })
    ] };
    const oldRange = h.view.computeRange(), width = 34;
    h.view.timelinePane = pane({ scrollLeft: daysBetween(oldRange.start, day('2026-10-23')) * width - 300, scrollTop: 150 });
    h.view.renderedTimelineRange = { start: oldRange.start, cellWidth: width };
    const snapshot = h.view.captureTimelineViewport();
    assert.equal(snapshot.anchorDay, '2026-10-23');
    h.view.projectQuery = 'Current';
    const nextRange = h.view.computeRange();
    h.view.timelinePane = pane({ scrollWidth: nextRange.days * width });
    h.view.restoreTimelineViewport(snapshot, nextRange, width);
    const expected = daysBetween(nextRange.start, day('2026-10-23')) * width - 300;
    assert.equal(h.view.timelinePane.scrollLeft, expected);
    assert.equal(h.view.timelinePane.scrollTop, 150);
    assert.ok(h.view.timelinePane.scrollLeft < h.view.timelinePane.scrollWidth - 600);
});

test('expanding historical results keeps the center date when the range starts earlier', () => {
    const h = harness();
    h.view.timelinePane = pane({ scrollLeft: 22.25 * 34 - 300 });
    h.view.renderedTimelineRange = { start: day('2026-10-01'), cellWidth: 34 };
    const snapshot = h.view.captureTimelineViewport();
    const range = { start: day('2010-01-01') };
    h.view.timelinePane = pane({ scrollWidth: 300000 });
    h.view.restoreTimelineViewport(snapshot, range, 34);
    assert.equal(snapshot.anchorDay, '2026-10-23');
    assert.equal(h.view.timelinePane.scrollLeft, (daysBetween(range.start, day('2026-10-23')) + 0.25) * 34 - 300);
});

test('responsive width changes preserve the date and fraction at the new viewport center', () => {
    const h = harness();
    h.view.timelinePane = pane({ scrollLeft: 600, clientWidth: 500 });
    h.view.renderedTimelineRange = { start: day('2026-10-01'), cellWidth: 34 };
    const snapshot = h.view.captureTimelineViewport();
    h.view.timelinePane = pane({ clientWidth: 320 });
    h.view.restoreTimelineViewport(snapshot, { start: day('2026-10-01') }, 20);
    assert.equal(h.view.timelinePane.scrollLeft, 25 * 20 - 160);
});

test('returning from zero results centers today instead of reviving a stale pixel offset', () => {
    const h = harness();
    h.view.timelinePane = null;
    h.view.renderedTimelineRange = null;
    assert.equal(h.view.captureTimelineViewport(), null);
    h.view.timelinePane = pane();
    h.view.restoreTimelineViewport(null, { start: day('2026-10-01') }, 34);
    assert.equal(h.view.timelinePane.scrollLeft, 22 * 34 - 300);
    assert.equal(h.view.timelinePane.scrollTop, 0);
});

test('calendar anchoring clamps dates outside the new range to its reachable edges', () => {
    const h = harness();
    h.view.timelinePane = pane({ scrollWidth: 1000 });
    const range = { start: day('2026-10-01') };
    h.view.restoreTimelineViewport({ anchorDay: '2000-01-01', anchorFraction: 0 }, range, 34);
    assert.equal(h.view.timelinePane.scrollLeft, 0);
    h.view.restoreTimelineViewport({ anchorDay: '2030-01-01', anchorFraction: 0 }, range, 34);
    assert.equal(h.view.timelinePane.scrollLeft, 400);
});

test('a stale animation-frame callback cannot scroll a replacement timeline', () => {
    const h = harness();
    const detached = pane({ scrollLeft: 999 });
    const replacement = pane({ scrollLeft: 123 });
    h.view.timelinePane = replacement;
    h.view.restoreTimelineViewport(null, { start: day('2026-10-01') }, 34, detached);
    assert.equal(replacement.scrollLeft, 123);
    assert.equal(detached.scrollLeft, 999);
});

test('initial migration from a view without a recorded range retains its existing scroll', () => {
    const h = harness();
    h.view.timelinePane = pane({ scrollLeft: 200, scrollTop: 75 });
    const snapshot = h.view.captureTimelineViewport();
    h.view.timelinePane = pane();
    h.view.restoreTimelineViewport(snapshot, { start: day('2026-10-01') }, 34);
    assert.equal(h.view.timelinePane.scrollLeft, 200);
    assert.equal(h.view.timelinePane.scrollTop, 75);
});
