/* Atomic write/undo regressions. JSON is used as a valid YAML subset; native QA
 * additionally exercises Obsidian's actual YAML parser and vault.process. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let now = new Date(2026, 10, 12, 23, 59, 59).valueOf();
class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
}
class Empty {}
class TFile { constructor(path) { this.path = path; this.stat = { mtime: 1, size: 1 }; } }
class ItemView { constructor(leaf) { this.app = leaf.app; } }
const notices = [], timers = [];
const moduleMock = { exports: {} };
const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
vm.runInNewContext(source + '\nmodule.exports.testAPI = { GanttView, taskNoteSnapshot, changedTaskFields };', {
    module: moduleMock, exports: moduleMock.exports, console, Date: ClockDate,
    setTimeout: (callback, ms) => { timers.push(ms); if (ms <= 50) queueMicrotask(callback); return timers.length; }, clearTimeout() {},
    window: { setTimeout: (_, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {} },
    document: {},
    require: () => ({ Plugin: Empty, ItemView, TFile, Menu: Empty, Modal: Empty,
        FuzzySuggestModal: Empty, PluginSettingTab: Empty, Setting: Empty,
        Notice: class { constructor(message) { notices.push(message); } }, setIcon() {},
        parseYaml: JSON.parse, stringifyYaml: value => JSON.stringify(value, null, 2) + '\n' })
});
const { GanttView, taskNoteSnapshot, changedTaskFields } = moduleMock.exports.testAPI;
const json = value => JSON.parse(JSON.stringify(value));
const text = (fm, body = '\n# Original heading\n\nBody  \n\n', newline = '\n') =>
    `---${newline}${JSON.stringify(fm)}${newline}---${newline}${body}`;
function harness(extra = {}, body, mapping = {}) {
    const file = new TFile('Tasks/Task.md');
    const original = { title: 'Task', status: 'open', scheduled: '2026-11-12T09:30:00+08:00', due: '2026-11-15', timeEstimate: 90, projects: ['[[Alpha]]'], nested: { untouched: [1, true, 'x'] }, ...extra };
    const files = new Map([[file.path, file]]);
    let content = text(original, body), writes = 0, beforeProcess;
    const app = {
        vault: {
            getAbstractFileByPath: path => files.get(path),
            read: async () => content,
            process: async (target, callback) => {
                assert.equal(target, file);
                if (beforeProcess) { const hook = beforeProcess; beforeProcess = null; hook(); }
                const next = callback(content);
                if (next !== content) { content = next; writes++; file.stat.mtime++; }
            }
        },
        metadataCache: { getFileCache: () => ({ frontmatter: taskNoteSnapshot(content).fm }) },
        plugins: { plugins: {}, enabledPlugins: new Set() }, workspace: { getLeavesOfType: () => [] }
    };
    const plugin = { settings: {}, refreshCarrotHome() {} };
    const view = new GanttView({ app }, plugin);
    view.board = { mode: 'tasknotes' };
    view.tn = { storeTitleInFilename: false, fieldMapping: mapping };
    view.render = async () => {};
    view.beginInternalWrite = () => ({ add() {}, release() {} });
    view.showDateUndo = record => { view.dateUndo = record; };
    view.tnStatusesCompleted = new Set(['done']);
    const fields = view.taskNotesFields();
    const task = { file, title: 'Task', sourceFrontmatter: json(original),
        scheduled: original[fields.scheduled] || '', due: original[fields.due] || '',
        scheduledDate: String(original[fields.scheduled] || '').slice(0, 10),
        dueDate: String(original[fields.due] || '').slice(0, 10),
        timeEstimate: original[fields.timeEstimate], status: 'open', done: false };
    return { app, view, task, file, files,
        get content() { return content; }, get writes() { return writes; },
        get snapshot() { return taskNoteSnapshot(content); },
        edit(fm, body) { const old = taskNoteSnapshot(content); content = text({ ...old.fm, ...fm }, body ?? old.body); },
        setContent(value) { content = value; }, inject(hook) { beforeProcess = hook; } };
}

test('date-only save preserves the complete body and unknown fields, including H1 and whitespace', async () => {
    const h = harness(); const before = h.snapshot;
    assert.equal(await h.view.updateTaskNotes(h.task, { scheduled: '2026-11-13' }), true);
    assert.equal(h.snapshot.body, before.body);
    assert.equal(h.snapshot.fm.scheduled, '2026-11-13T09:30:00+08:00');
    assert.equal(h.snapshot.fm.due, before.fm.due);
    assert.deepEqual(json(h.snapshot.fm.nested), json(before.fm.nested));
    assert.equal(h.writes, 1);
});
test('body editing preserves YAML bytes and does not trim headings or spaces', async () => {
    const h = harness(); const before = h.snapshot;
    const body = '\n# Kept heading\n\n  Deliberate spaces  \n\n';
    assert.equal(await h.view.updateTaskNotes(h.task, { notes: body }, { expectedBody: before.body }), true);
    assert.equal(h.snapshot.header, before.header);
    assert.equal(h.snapshot.body, body);
});
test('CRLF bodies retain their newline convention after textarea edits', async () => {
    const h = harness();
    h.setContent(text(h.snapshot.fm, '\r\n# Heading\r\n\r\nText\r\n', '\r\n'));
    const before = h.snapshot;
    assert.equal(await h.view.updateTaskNotes(h.task, { notes: '\n# Heading\n\nEdited\n' }, { expectedBody: before.body }), true);
    assert.equal(h.snapshot.body, '\r\n# Heading\r\n\r\nEdited\r\n');
    assert.equal(h.snapshot.header, before.header);
});
test('missing successful body snapshot blocks the whole combined save', async () => {
    const h = harness(); const before = h.content;
    assert.equal(await h.view.updateTaskNotes(h.task, { notes: '', due: '2026-11-16' }), false);
    assert.equal(h.content, before); assert.equal(h.writes, 0);
});
test('a body read failure rejects instead of supplying an empty editable body', async () => {
    const h = harness(); h.app.vault.read = async () => { throw Error('offline'); };
    await assert.rejects(h.view.readTaskNotesSnapshot(h.task), /offline/);
    assert.equal(h.writes, 0);
});
test('body edits racing with a combined save reject both changes atomically', async () => {
    const h = harness(); const before = h.snapshot;
    h.inject(() => h.edit({}, '# External body\n'));
    assert.equal(await h.view.updateTaskNotes(h.task, { due: '2026-11-16', notes: 'Draft' }, { expectedBody: before.body }), false);
    assert.equal(h.snapshot.body, '# External body\n');
    assert.equal(h.snapshot.fm.due, '2026-11-15'); assert.equal(h.writes, 0);
});
test('a changed requested property rejects a stale edit even without an mtime change', async () => {
    const h = harness(); h.inject(() => h.edit({ due: '2026-11-17' }));
    assert.equal(await h.view.updateTaskNotes(h.task, { due: '2026-11-16' }), false);
    assert.equal(h.snapshot.fm.due, '2026-11-17'); assert.equal(h.writes, 0);
});
test('unrelated properties and external body edits survive a date-only save', async () => {
    const h = harness(); h.inject(() => h.edit({ status: 'doing', external: ['keep'] }, '# New external body\n'));
    assert.equal(await h.view.updateTaskNotes(h.task, { due: '2026-11-16' }), true);
    assert.equal(h.snapshot.fm.status, 'doing');
    assert.deepEqual(json(h.snapshot.fm.external), ['keep']);
    assert.equal(h.snapshot.body, '# New external body\n');
});
test('date Undo preserves later body, status and unrelated property edits', async () => {
    const h = harness(); const before = h.snapshot;
    await h.view.updateTaskNotes(h.task, { scheduled: '2026-11-13', timeEstimate: 120 });
    h.edit({ status: 'doing', external: true }, '# Later draft\n');
    assert.equal(await h.view.undoTaskDates(), true);
    assert.equal(h.snapshot.fm.scheduled, before.fm.scheduled);
    assert.equal(h.snapshot.fm.timeEstimate, 90);
    assert.equal(h.snapshot.fm.status, 'doing'); assert.equal(h.snapshot.fm.external, true);
    assert.equal(h.snapshot.body, '# Later draft\n');
});
test('Undo refuses to overwrite any more recent change to its date fields', async () => {
    const h = harness(); await h.view.updateTaskNotes(h.task, { due: '2026-11-16' });
    h.edit({ due: '2026-11-19' }); const current = h.content;
    assert.equal(await h.view.undoTaskDates(), false); assert.equal(h.content, current);
});
test('Undo restores absence rather than materializing an empty or zero date field', async () => {
    const h = harness(); const fm = h.snapshot.fm; delete fm.scheduled; delete fm.timeEstimate;
    h.setContent(text(fm)); h.task.sourceFrontmatter = json(fm); h.task.scheduled = '';
    await h.view.updateTaskNotes(h.task, { scheduled: '2026-11-13', timeEstimate: 120 });
    assert.equal(await h.view.undoTaskDates(), true);
    assert.equal('scheduled' in h.snapshot.fm, false); assert.equal('timeEstimate' in h.snapshot.fm, false);
});
test('due edits and Undo preserve an existing time and timezone', async () => {
    const h = harness({ due: '2026-11-15T18:45:00+08:00' });
    await h.view.updateTaskNotes(h.task, { due: '2026-11-16' });
    assert.equal(h.snapshot.fm.due, '2026-11-16T18:45:00+08:00');
    assert.equal(await h.view.undoTaskDates(), true);
    assert.equal(h.snapshot.fm.due, '2026-11-15T18:45:00+08:00');
});
test('Undo follows the same file after a rename but refuses a replacement at the same path', async () => {
    const h = harness(); await h.view.updateTaskNotes(h.task, { due: '2026-11-16' });
    h.files.delete(h.file.path); h.file.path = 'Tasks/Renamed.md'; h.files.set(h.file.path, h.file);
    assert.equal(await h.view.undoTaskDates(), true);
    const other = harness(); await other.view.updateTaskNotes(other.task, { due: '2026-11-16' });
    other.files.set(other.file.path, new TFile(other.file.path));
    assert.equal(await other.view.undoTaskDates(), false);
});
test('a no-op edit writes nothing and offers no Undo', async () => {
    const h = harness();
    assert.equal(await h.view.updateTaskNotes(h.task, { due: '2026-11-15' }), true);
    assert.equal(h.writes, 0); assert.equal(h.view.dateUndo, undefined);
});
test('mapped date fields are guarded, saved and restored using their configured keys', async () => {
    const h = harness({ planned: '2026-11-12T08:00:00Z', deadline: '2026-11-15', minutes: 30 }, undefined,
        { scheduled: 'planned', due: 'deadline', timeEstimate: 'minutes', dateModified: 'modified' });
    await h.view.updateTaskNotes(h.task, { scheduled: '2026-11-13', timeEstimate: 60 });
    assert.equal(h.snapshot.fm.planned, '2026-11-13T08:00:00Z');
    assert.equal(h.snapshot.fm.minutes, 60); assert.ok(h.snapshot.fm.modified);
    assert.equal(h.snapshot.fm.scheduled, '2026-11-12T09:30:00+08:00');
    assert.equal(await h.view.undoTaskDates(), true); assert.equal(h.snapshot.fm.minutes, 30);
});
test('completion only changes status bookkeeping and preserves dates and body', async () => {
    const h = harness(); const before = h.snapshot;
    assert.equal(await h.view.updateTaskNotes(h.task, { done: true }), true);
    assert.equal(h.snapshot.fm.status, 'done'); assert.ok(h.snapshot.fm.completedDate);
    assert.equal(h.snapshot.fm.due, before.fm.due); assert.equal(h.snapshot.body, before.body);
});
test('status saves wait for delayed metadata before redrawing the task', async () => {
    const h = harness(); const initial = h.snapshot.fm; let reads = 0;
    h.app.metadataCache.getFileCache = () => ({ frontmatter: ++reads <= 2 ? initial : h.snapshot.fm });
    h.view.render = async () => { assert.equal(h.app.metadataCache.getFileCache().frontmatter.status, 'done'); };
    assert.equal(await h.view.updateTaskNotes(h.task, { done: true }), true);
    assert.ok(reads >= 3);
});
test('expired Undo and invalid YAML cannot cause writes', async () => {
    const h = harness(); await h.view.updateTaskNotes(h.task, { due: '2026-11-16' });
    h.view.dateUndo.expiresAt = now - 1;
    assert.equal(await h.view.undoTaskDates(), false);
    h.setContent('---\nmalformed header without closing delimiter\n'); const before = h.content;
    assert.equal(await h.view.updateTaskNotes(h.task, { due: '2026-11-16' }), false);
    assert.equal(h.content, before);
});
test('an unchanged form excludes notes, date, priority and project fields from the patch', () => {
    const initial = { title: 'A', notes: '\n# Heading\n', due: '', priority: 'none', projects: ['[[A]]'] };
    assert.equal(Object.keys(changedTaskFields(initial, json(initial))).length, 0);
    assert.deepEqual(json(changedTaskFields(initial, { ...initial, due: '2026-11-16' })), { due: '2026-11-16' });
});
test('refreshes defer while an editor has a draft or an active save', async () => {
    const h = harness();
    h.view.taskEditor = { isDirty: () => true, saving: false };
    await GanttView.prototype.render.call(h.view); assert.equal(h.view.renderAfterTaskEditor, true);
    h.view.renderAfterTaskEditor = false; h.view.taskEditor = { isDirty: () => false, saving: true };
    await GanttView.prototype.render.call(h.view); assert.equal(h.view.renderAfterTaskEditor, true);
});
test('midnight and wake checks refresh once when the local day changes and stop after close', () => {
    now = new Date(2026, 10, 12, 23, 59, 59).valueOf();
    const h = harness(); let refreshes = 0; const listeners = {};
    h.view.scheduleRender = () => { refreshes++; };
    h.view.registerDomEvent = (_, event, callback) => { listeners[event] = callback; };
    h.view.observeCalendarDate(); assert.equal(timers.at(-1), 1050);
    now += 2000; listeners.focus(); assert.equal(refreshes, 1);
    listeners.visibilitychange(); assert.equal(refreshes, 1);
    h.view.closed = true; now += 86400000; listeners.focus(); assert.equal(refreshes, 1);
});
test('overdue signals require a passed deadline and exclude today, completed and schedule-only tasks', () => {
    now = new Date(2026, 10, 12, 12).valueOf(); const h = harness();
    assert.equal(h.view.taskOverdue({ dueDate: '2026-11-11' }), true);
    assert.equal(h.view.taskOverdue({ dueDate: '2026-11-12' }), false);
    assert.equal(h.view.taskOverdue({ dueDate: '2026-11-11', done: true }), false);
    assert.equal(h.view.taskOverdue({ scheduledDate: '2020-01-01', end: '2020-01-01' }), false);
});
