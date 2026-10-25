/* Run: node --test qa/gantt-v1.2.0.test.cjs
 * All notes and settings are fictional and remain in memory.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, projectNote, taskNote, project, task, ids, titles, keyFor, clone } = require('./gantt-test-harness.cjs');

function filterFixture() {
    const h = harness({ notes: [
        projectNote('Active'), projectNote('Overdue'), projectNote('Ready'), projectNote('Empty'),
        projectNote('Complete', { project_status: 'completed' }), projectNote('Archive', { tags: ['archived'] })
    ] });
    const rows = [
        project('Active', [task('Future', { due: '2026-10-26' })]),
        project('Overdue', [task('Late', { due: '2026-10-22' })]),
        project('Ready', [task('Done', { done: true, progress: 100 })]),
        project('Empty'),
        project('Complete', [task('Complete child', { done: true, progress: 100 })]),
        project('Archive', [task('Unfinished archive child', { due: '2020-01-01' })])
    ];
    h.view.board = { mode: 'tasknotes', projects: rows, tasks: rows.flatMap((row) => row.tasks) };
    return { ...h, rows };
}

function renameFixtureFile(h, oldPath, newPath) {
    const file = h.files.get(oldPath);
    const fm = h.metadata.get(oldPath);
    h.files.delete(oldPath);
    h.metadata.delete(oldPath);
    file.path = newPath;
    file.basename = newPath.split('/').at(-1).replace(/\.md$/, '');
    h.files.set(newPath, file);
    h.metadata.set(newPath, fm);
    return file;
}

test('all-project filter returns a fresh list without changing project order or associated tasks', () => {
    const { view, rows, plugin } = filterFixture();
    const before = clone(rows);
    const saved = clone(plugin.settings);
    const result = view.filterProjects(rows, 'all', '');
    assert.notEqual(result, rows);
    assert.deepEqual(ids(result), ids(rows));
    assert.deepEqual(clone(rows), before);
    assert.deepEqual(plugin.settings, saved);
});

test('project search normalizes Unicode and case, and ANDs terms across title, path, and hidden task titles', () => {
    const h = harness();
    const hidden = task('Review', { title: '字幕 REVIEW', done: true });
    const alpha = project('Alpha', [task('Visible')], {
        title: 'ＡＬＰＨＡ  视频', notePath: 'Projects/Client-Z/Alpha.md',
        allTasks: [task('Visible'), hidden]
    });
    const beta = project('Beta', [task('Other')], { title: 'ＢＥＴＡ 视频' });
    const rows = [beta, alpha];
    assert.deepEqual(ids(h.view.filterProjects(rows, 'all', '  alpha\tＲＥＶＩＥＷ  ')), ['Alpha']);
    assert.deepEqual(ids(h.view.filterProjects(rows, 'all', 'CLIENT-z 字幕')), ['Alpha']);
    assert.deepEqual(ids(h.view.filterProjects(rows, 'all', 'alpha beta')), []);
    assert.deepEqual(ids(h.view.filterProjects(rows, 'all', '　\t ')), ['Beta', 'Alpha']);
    assert.deepEqual(titles(alpha.tasks), ['Visible']);
    assert.equal(alpha.allTasks.length, 2);
});

test('searching a shared task finds both projects without duplicating or sorting results', () => {
    const h = harness();
    const shared = task('Shared', { title: '统一封面 Review' });
    const rows = [project('Zeta', [shared]), project('Alpha', [shared]), project('Unrelated')];
    assert.deepEqual(ids(h.view.filterProjects(rows, 'all', '封面 review')), ['Zeta', 'Alpha']);
});

for (const [filter, expected] of [
    ['all', ['Active', 'Overdue', 'Ready', 'Empty', 'Complete', 'Archive']],
    ['active', ['Active', 'Overdue', 'Ready', 'Empty']],
    ['overdue', ['Overdue']],
    ['ready', ['Ready']],
    ['completed', ['Complete']],
    ['archived', ['Archive']]
]) {
    test(`${filter} quick filter has the correct membership and count`, () => {
        const { view, rows } = filterFixture();
        const result = view.filterProjects(rows, filter, '');
        assert.deepEqual(ids(result), expected);
        assert.equal(result.length, expected.length);
    });
}

test('search and quick filter compose without changing the full project statistics', async () => {
    const h = harness({ notes: [
        projectNote('Campaign'), projectNote('Other'),
        taskNote('Open', ['Campaign'], { due: '2026-10-22' }),
        taskNote('Review', ['Campaign'], { status: 'done' }),
        taskNote('Other task', ['Other'])
    ], settings: { showCompletedTasks: false } });
    const board = await h.view.loadTaskNotesBoard();
    const original = clone(board.projects);
    h.view.projectQuery = 'review';
    h.view.projectFilter = 'overdue';
    const result = h.view.filterProjects(board.projects);
    assert.deepEqual(titles(result), ['Campaign']);
    assert.equal(result[0].progress, 50);
    assert.deepEqual(titles(result[0].tasks), ['Open']);
    assert.equal(result[0].allTasks.length, 2);
    assert.equal(h.view.filterProjects(board.projects, 'completed', 'review').length, 0);
    assert.deepEqual(clone(board.projects), original);
    assert.equal(h.writes.length, 0);
    assert.equal(h.saves.length, 0);
});

test('overdue uses unfinished deadlines or the project deadline, excluding today and historical groups', () => {
    const h = harness({ notes: [
        projectNote('OwnDeadline', { due: '2026-10-22' }),
        projectNote('Completed', { project_status: 'completed', due: '2020-01-01' }),
        projectNote('Archived', { tags: ['archived'], due: '2020-01-01' })
    ] });
    assert.equal(h.view.projectOverdue(project('OldChild', [task('Late', { due: '2026-10-22' })])), true);
    assert.equal(h.view.projectOverdue(project('OwnDeadline')), true);
    assert.equal(h.view.projectOverdue(project('Today', [task('Today', { due: '2026-10-23' })])), false);
    assert.equal(h.view.projectOverdue(project('Future', [task('Future', { due: '2026-10-24' })])), false);
    assert.equal(h.view.projectOverdue(project('NoDate', [task('Unscheduled')])), false);
    assert.equal(h.view.projectOverdue(project('OldDone', [task('Done', { due: '2020-01-01', done: true })])), false);
    assert.equal(h.view.projectOverdue(project('OldSchedule', [task('Started', { scheduled: '2020-01-01', start: '2020-01-01' })])), false);
    assert.equal(h.view.projectOverdue(project('Completed')), false);
    assert.equal(h.view.projectOverdue(project('Archived')), false);
});

test('matching historic groups expand temporarily and restore their saved collapsed state when search clears', () => {
    const h = harness({ settings: { completedProjectsExpanded: false, archivedProjectsExpanded: false } });
    h.view.projectQuery = '';
    h.view.projectFilter = 'all';
    assert.equal(h.view.isProjectGroupExpanded('completed'), false);
    assert.equal(h.view.isProjectGroupExpanded('archived'), false);
    h.view.projectFilter = 'completed';
    assert.equal(h.view.isProjectGroupExpanded('completed'), true);
    h.view.projectFilter = 'archived';
    assert.equal(h.view.isProjectGroupExpanded('archived'), true);
    h.view.projectFilter = 'all';
    h.view.projectQuery = 'old';
    assert.equal(h.view.isProjectGroupExpanded('completed'), true);
    assert.equal(h.view.isProjectGroupExpanded('archived'), true);
    h.view.projectQuery = ' \t　 ';
    assert.equal(h.view.isProjectGroupExpanded('completed'), false);
    assert.equal(h.view.isProjectGroupExpanded('archived'), false);
    assert.equal(h.plugin.settings.completedProjectsExpanded, false);
    assert.equal(h.plugin.settings.archivedProjectsExpanded, false);
    assert.equal(h.saves.length, 0);
});

test('temporary search expansion preserves previously expanded history preferences', () => {
    const h = harness({ settings: { completedProjectsExpanded: true, archivedProjectsExpanded: false } });
    h.view.projectFilter = 'all';
    h.view.projectQuery = 'query';
    assert.equal(h.view.isProjectGroupExpanded('completed'), true);
    assert.equal(h.view.isProjectGroupExpanded('archived'), true);
    h.view.projectQuery = '';
    assert.equal(h.view.isProjectGroupExpanded('completed'), true);
    assert.equal(h.view.isProjectGroupExpanded('archived'), false);
});

test('project rename preserves its manual rank, pin/collapse state and both forms of task order identity', async () => {
    const oldKey = keyFor('Alpha'), newKey = keyFor('Renamed'), otherKey = keyFor('Other');
    const h = harness({ notes: [projectNote('Before'), projectNote('Alpha'), projectNote('After')], settings: {
        projects: ['Before', 'Alpha', 'After'].map((name) => project(name)),
        projectViewState: { [oldKey]: { pinned: true, collapsed: true }, [otherKey]: { collapsed: false } },
        taskOrder: { [oldKey]: ['tasknotes:Tasks/Child.md'], [otherKey]: ['tasknotes:Projects/Alpha.md', 'tasknotes:Tasks/Other.md'] }
    } });
    h.view.scheduleRender = () => {};
    const file = renameFixtureFile(h, 'Projects/Alpha.md', 'Projects/Renamed.md');
    await h.view.migrateProjectViewState(file, 'Projects/Alpha.md');
    assert.deepEqual(ids(h.plugin.settings.projects), ['Before', 'Alpha', 'After']);
    assert.equal(h.plugin.settings.projects[1].key, newKey);
    assert.equal(h.plugin.settings.projects[1].notePath, 'Projects/Renamed.md');
    assert.deepEqual(clone(h.plugin.settings.projectViewState[newKey]), { pinned: true, collapsed: true });
    assert.equal(h.plugin.settings.projectViewState[oldKey], undefined);
    assert.deepEqual(clone(h.plugin.settings.taskOrder[newKey]), ['tasknotes:Tasks/Child.md']);
    assert.equal(h.plugin.settings.taskOrder[oldKey], undefined);
    assert.deepEqual(clone(h.plugin.settings.taskOrder[otherKey]), ['tasknotes:Projects/Renamed.md', 'tasknotes:Tasks/Other.md']);
    assert.equal(h.saves.length, 1);
    assert.deepEqual(h.saves[0], clone(h.plugin.settings));
    assert.equal(h.writes.length, 0);
});

test('renaming a child task updates saved task ids in every project while preserving their ranks', async () => {
    const h = harness({ notes: [taskNote('Old', ['Alpha', 'Beta'])], settings: { taskOrder: {
        [keyFor('Alpha')]: ['tasknotes:Tasks/Before.md', 'tasknotes:Tasks/Old.md'],
        [keyFor('Beta')]: ['tasknotes:Tasks/Old.md', 'tasknotes:Tasks/After.md']
    } } });
    h.view.scheduleRender = () => {};
    const file = renameFixtureFile(h, 'Tasks/Old.md', 'Tasks/New.md');
    await h.view.migrateProjectViewState(file, 'Tasks/Old.md');
    assert.deepEqual(clone(h.plugin.settings.taskOrder[keyFor('Alpha')]), ['tasknotes:Tasks/Before.md', 'tasknotes:Tasks/New.md']);
    assert.deepEqual(clone(h.plugin.settings.taskOrder[keyFor('Beta')]), ['tasknotes:Tasks/New.md', 'tasknotes:Tasks/After.md']);
    assert.equal(h.saves.length, 1);
});

test('failed rename persistence rolls all related settings back together', async () => {
    const oldKey = keyFor('Alpha');
    const h = harness({ notes: [projectNote('Alpha')], settings: {
        projects: [project('Alpha')], projectViewState: { [oldKey]: { pinned: true, collapsed: true } },
        taskOrder: { [oldKey]: ['tasknotes:Projects/Alpha.md', 'tasknotes:Tasks/Child.md'] }
    } });
    const before = clone(h.plugin.settings);
    h.view.scheduleRender = () => {};
    h.plugin.saveSettings = async () => { throw new Error('Simulated settings write failure'); };
    const file = renameFixtureFile(h, 'Projects/Alpha.md', 'Projects/Renamed.md');
    await h.view.migrateProjectViewState(file, 'Projects/Alpha.md').catch(() => {});
    assert.deepEqual(clone(h.plugin.settings), before);
    assert.equal(h.writes.length, 0);
});

test('the registered rename event migrates internal title changes without scheduling an early render', async () => {
    const oldPath = 'Projects/Alpha.md', newPath = 'Projects/Renamed.md';
    const oldKey = `file:${oldPath}`, newKey = `file:${newPath}`, otherKey = keyFor('Other');
    const h = harness({ notes: [projectNote('Alpha')], settings: {
        projects: [project('Alpha')],
        projectViewState: { [oldKey]: { pinned: true, collapsed: true } },
        taskOrder: { [oldKey]: ['tasknotes:Tasks/Child.md'], [otherKey]: [`tasknotes:${oldPath}`, 'tasknotes:Tasks/Other.md'] }
    } });
    const listeners = new Map();
    h.app.vault.on = (name, callback) => { listeners.set(name, callback); return { name }; };
    h.view.registerEvent = () => {};
    h.view.observeResponsiveMode = () => {};
    h.view.board = { mode: 'tasknotes', projects: [project('Alpha')], tasks: [] };
    let scheduled = 0;
    h.view.scheduleRender = () => { scheduled++; };
    await h.view.onOpen();
    assert.equal(typeof listeners.get('rename'), 'function');
    const renderedOnOpen = h.view.renderCount;
    h.view.beginInternalWrite(h.files.get(oldPath));
    const file = renameFixtureFile(h, oldPath, newPath);
    h.metadata.get(newPath).title = 'Renamed';
    assert.equal(h.view.isInternalWrite(file, oldPath), true);
    let allowSave;
    const saving = new Promise((resolve) => { allowSave = resolve; });
    h.plugin.saveSettings = async () => { await saving; h.saves.push(clone(h.plugin.settings)); };
    listeners.get('rename')(file, oldPath);
    assert.equal(scheduled, 0);
    assert.equal(h.view.renderCount, renderedOnOpen);
    allowSave();
    // The vault event callback intentionally returns void; drain its migration/finally chain.
    await new Promise(setImmediate);
    assert.equal(h.saves.length, 1);
    assert.equal(h.plugin.settings.projects[0].id, 'Alpha');
    assert.equal(h.plugin.settings.projects[0].key, newKey);
    assert.equal(h.plugin.settings.projects[0].notePath, newPath);
    assert.equal(h.plugin.settings.projects[0].title, 'Renamed');
    assert.deepEqual(clone(h.plugin.settings.projectViewState[newKey]), { pinned: true, collapsed: true });
    assert.equal(h.plugin.settings.projectViewState[oldKey], undefined);
    assert.deepEqual(clone(h.plugin.settings.taskOrder[newKey]), ['tasknotes:Tasks/Child.md']);
    assert.equal(h.plugin.settings.taskOrder[oldKey], undefined);
    assert.deepEqual(clone(h.plugin.settings.taskOrder[otherKey]), [`tasknotes:${newPath}`, 'tasknotes:Tasks/Other.md']);
    assert.equal(scheduled, 0);
    assert.equal(h.view.renderCount, renderedOnOpen);
});

test('completing an ordinary project preserves its unrelated status property', async () => {
    const taskNotes = { taskIdentificationMethod: 'tag', taskTag: 'task' };
    const h = harness({ notes: [
        projectNote('Reading project', { status: 'reading' }),
        taskNote('Finished child', ['Reading project'], { tags: ['task'], status: 'done' })
    ], taskNotes });
    h.view.board = await h.view.loadTaskNotesBoard();
    const ordinary = h.view.board.projects.find((item) => item.title === 'Reading project');
    assert.equal(h.view.isTaskNotesTaskFile(h.files.get(ordinary.notePath)), false);
    assert.equal(h.view.projectCompleted(ordinary), false);
    assert.equal(await h.view.setProjectCompleted(ordinary, true), true);
    const fm = h.metadata.get(ordinary.notePath);
    assert.equal(fm.status, 'reading');
    assert.equal(fm.project_status, 'completed');
    assert.equal(h.view.projectCompleted(ordinary), true);
    assert.deepEqual(h.writes.map((write) => write.path), [ordinary.notePath]);
    assert.equal(h.metadata.get('Tasks/Finished child.md').status, 'done');
});

test('completing a tagged TaskNotes project without a status creates the mapped TaskNotes fields', async () => {
    const taskNotes = {
        taskIdentificationMethod: 'tag', taskTag: 'task', defaultTaskStatus: 'todo',
        fieldMapping: { status: 'state', completedDate: 'finishedOn' },
        customStatuses: [{ value: 'todo', isCompleted: false }, { value: 'accepted', isCompleted: true }]
    };
    const h = harness({ notes: [
        projectNote('Tagged project', { tags: ['task'] }),
        { path: 'Tasks/Accepted child.md', fm: {
            title: 'Accepted child', tags: ['task'], state: 'accepted', projects: ['[[Projects/Tagged project]]']
        } }
    ], taskNotes });
    h.view.board = await h.view.loadTaskNotesBoard();
    const tagged = h.view.board.projects.find((item) => item.title === 'Tagged project');
    assert.equal(h.view.isTaskNotesTaskFile(h.files.get(tagged.notePath)), true);
    assert.equal(h.metadata.get(tagged.notePath).state, undefined);
    assert.equal(h.view.projectCompleted(tagged), false);
    assert.equal(await h.view.setProjectCompleted(tagged, true), true);
    const fm = h.metadata.get(tagged.notePath);
    assert.equal(fm.state, 'accepted');
    assert.equal(fm.finishedOn, '2026-10-23');
    assert.equal(fm.project_status, undefined);
    assert.equal(fm.status, undefined);
    assert.equal(h.view.projectCompleted(tagged), true);
    assert.deepEqual(h.writes.map((write) => write.path), [tagged.notePath]);
});

test('reopening a legacy ordinary done project stores its own lifecycle and stays active after reload', async () => {
    const taskNotes = { taskIdentificationMethod: 'tag', taskTag: 'task' };
    const h = harness({ notes: [projectNote('Legacy ordinary', { status: 'done' })], taskNotes });
    h.view.board = await h.view.loadTaskNotesBoard();
    const legacy = h.view.board.projects.find((item) => item.title === 'Legacy ordinary');
    assert.equal(h.view.isTaskNotesTaskFile(h.files.get(legacy.notePath)), false);
    assert.equal(h.view.projectCompleted(legacy), true);
    assert.equal(await h.view.setProjectCompleted(legacy, false), true);
    assert.equal(h.metadata.get(legacy.notePath).status, 'done');
    assert.equal(h.metadata.get(legacy.notePath).project_status, 'active');
    assert.equal(h.view.projectCompleted(legacy), false);
    assert.equal(h.view.projectGroup(legacy), 'active');
    const reloaded = harness({ notes: [...h.files.values()].map((file) => ({
        path: file.path, fm: h.metadata.get(file.path)
    })), taskNotes });
    const refreshed = (await reloaded.view.loadTaskNotesBoard()).projects.find((item) => item.title === 'Legacy ordinary');
    assert.equal(reloaded.view.projectCompleted(refreshed), false);
    assert.equal(reloaded.view.projectGroup(refreshed), 'active');
});
