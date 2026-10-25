/* Run: node --test qa/gantt-identity.test.cjs. Fictional in-memory notes only. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, projectNote, taskNote, titles } = require('./gantt-test-harness.cjs');

test('runtime task identity excludes status-bearing reference notes from progress and completion', async () => {
    const h = harness({ notes: [projectNote('Alpha'),
        taskNote('Real', ['Alpha'], { tags: ['task'], status: 'done' }),
        { path: 'Research/Reference.md', fm: { title: 'Reference', status: 'reading', projects: ['[[Projects/Alpha]]'] } }
    ], taskNotes: { taskIdentificationMethod: 'tag', taskTag: 'task' } });
    h.app.plugins.plugins.tasknotes.cacheManager = {
        isValidFile: () => true,
        isTaskFile: (fm) => Array.isArray(fm.tags) && fm.tags.includes('task'),
        getCachedTaskInfoSync: () => null
    };
    const board = await h.view.loadTaskNotesBoard();
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    assert.deepEqual(titles(alpha.allTasks), ['Real']);
    assert.equal(alpha.progress, 100);
    assert.equal(h.view.projectReadyToComplete(alpha), true);
    assert.equal(h.writes.length, 0);
});

test('a real task with missing or blank mapped status uses the TaskNotes default', async () => {
    const h = harness({ notes: [projectNote('Alpha'),
        { path: 'Tasks/Missing.md', fm: { title: 'Missing', tags: ['task'], projects: ['[[Projects/Alpha]]'] } },
        { path: 'Tasks/Blank.md', fm: { title: 'Blank', tags: ['task'], state: ' ', projects: ['[[Projects/Alpha]]'] } }
    ], taskNotes: { taskIdentificationMethod: 'tag', taskTag: 'task', defaultTaskStatus: 'doing', fieldMapping: { status: 'state' } } });
    const board = await h.view.loadTaskNotesBoard();
    assert.deepEqual(titles(board.tasks).sort(), ['Blank', 'Missing']);
    assert.ok(board.tasks.every((task) => task.status === 'doing' && !task.done));
    assert.equal(h.writes.length, 0);
});

test('runtime identity decisions take precedence over fallback identification settings', async () => {
    const h = harness({ notes: [projectNote('Alpha'), taskNote('Runtime', ['Alpha'], { recognized: true }),
        taskNote('Old tag', ['Alpha'], { tags: ['task'] })], taskNotes: { taskIdentificationMethod: 'tag', taskTag: 'task' } });
    h.app.plugins.plugins.tasknotes.cacheManager = { isTaskFile: (fm) => fm.recognized === true };
    const board = await h.view.loadTaskNotesBoard();
    assert.deepEqual(titles(board.tasks), ['Runtime']);
});

test('runtime excluded folders stay excluded even when notes have identifying tags', async () => {
    const h = harness({ notes: [projectNote('Alpha'), taskNote('Include', ['Alpha'], { tags: ['task'] }),
        { path: 'Excluded/Omit.md', fm: { title: 'Omit', tags: ['task'], status: 'open', projects: ['[[Projects/Alpha]]'] } }
    ], taskNotes: { taskIdentificationMethod: 'tag', taskTag: 'task' } });
    h.app.plugins.plugins.tasknotes.cacheManager = {
        isTaskFile: (fm) => Array.isArray(fm.tags) && fm.tags.includes('task'),
        isValidFile: (path) => !path.startsWith('Excluded/')
    };
    assert.deepEqual(titles((await h.view.loadTaskNotesBoard()).tasks), ['Include']);
});

test('tag fallback respects hierarchical tags and configured exclusion folder boundaries', async () => {
    const tagged = (path, tag) => ({ path, fm: { title: path, status: 'open', tags: [tag], projects: ['[[Projects/Alpha]]'] } });
    const h = harness({ notes: [projectNote('Alpha'), tagged('Tasks/Include.md', '#TASK/weekly'),
        tagged('Tasks/False prefix.md', 'taskish'), tagged('Excluded/Hidden.md', 'task'),
        tagged('ExcludedElsewhere/Keep.md', 'task')], taskNotes: {
        taskIdentificationMethod: 'tag', taskTag: 'task', excludedFolders: 'Excluded, Other'
    } });
    const board = await h.view.loadTaskNotesBoard();
    assert.deepEqual(titles(board.tasks).sort(), ['ExcludedElsewhere/Keep.md', 'Tasks/Include.md']);
});

test('property identification supports boolean values and arrays without treating every status as a task', async () => {
    const marked = (name, kind) => ({ path: `Tasks/${name}.md`, fm: { title: name, kind, status: 'done', projects: ['[[Projects/Alpha]]'] } });
    const h = harness({ notes: [projectNote('Alpha'), marked('Boolean', true), marked('List', ['note', true]),
        marked('No', false), marked('Unrelated', 'note')], taskNotes: {
        taskIdentificationMethod: 'property', taskPropertyName: 'kind', taskPropertyValue: 'true'
    } });
    assert.deepEqual(titles((await h.view.loadTaskNotesBoard()).tasks).sort(), ['Boolean', 'List']);
});

test('ordinary project notes remain visible without becoming tasks', async () => {
    const h = harness({ notes: [projectNote('Empty', { status: 'research' })],
        taskNotes: { taskIdentificationMethod: 'tag', taskTag: 'task' } });
    const board = await h.view.loadTaskNotesBoard();
    assert.deepEqual(titles(board.projects), ['Empty']);
    assert.equal(board.tasks.length, 0);
    assert.equal(h.view.isTaskNotesTaskFile(h.files.get('Projects/Empty.md')), false);
});

function sameTitleFixture(extra = {}) {
    return harness({ notes: [
        { path: 'Work/Release.md', fm: { title: 'Release', carrotProject: true } },
        { path: 'Personal/Release.md', fm: { title: 'Release', carrotProject: true } }
    ], settings: { projectSortMode: 'manual', projects: [
        { id: 'work-id', key: 'file:Work/Release.md', title: 'Release', notePath: 'Work/Release.md', color: '#aabbcc', notes: 'Work only' }
    ], ...extra } });
}

test('same-title projects retain separate identity, decoration, and manual drag order', async () => {
    const h = sameTitleFixture();
    h.view.board = await h.view.loadTaskNotesBoard();
    const [work, personal] = h.view.board.projects;
    assert.notEqual(work.id, personal.id);
    assert.equal(work.notes, 'Work only');
    assert.equal(personal.notes, '');
    assert.notEqual(work.color, personal.color);
    await h.view.moveProjectOrder(personal.id, work.id, true);
    assert.deepEqual(Array.from(h.plugin.settings.projects, (p) => p.notePath), ['Personal/Release.md', 'Work/Release.md']);
    assert.equal(h.writes.length, 0);
});

test('existing duplicate stored IDs are isolated by note identity before dragging', async () => {
    const h = sameTitleFixture({ projects: [
        { id: 'duplicate', key: 'file:Work/Release.md', title: 'Release', notePath: 'Work/Release.md' },
        { id: 'duplicate', key: 'file:Personal/Release.md', title: 'Release', notePath: 'Personal/Release.md' }
    ] });
    const board = await h.view.loadTaskNotesBoard();
    assert.equal(new Set(Array.from(board.projects, (p) => p.id)).size, 2);
});

test('saved file keys work even without a redundant notePath field', async () => {
    const h = sameTitleFixture({ projects: [
        { id: 'personal-id', key: 'file:Personal/Release.md', title: 'Release', notes: 'Personal only' }
    ] });
    const board = await h.view.loadTaskNotesBoard();
    const personal = board.projects.find((p) => p.key === 'file:Personal/Release.md');
    assert.equal(personal.id, 'personal-id');
    assert.equal(personal.notes, 'Personal only');
    assert.equal(board.projects.find((p) => p.key === 'file:Work/Release.md').notes, '');
});

test('saving a visible order retains hidden same-title projects identified by other paths', async () => {
    const h = sameTitleFixture({ projects: [
        { id: 'work-id', key: 'file:Work/Release.md', title: 'Release', notePath: 'Work/Release.md', notes: 'Hidden work' },
        { id: 'personal-id', key: 'file:Personal/Release.md', title: 'Release', notePath: 'Personal/Release.md', notes: 'Visible personal' }
    ] });
    const board = await h.view.loadTaskNotesBoard();
    await h.view.persistProjectOrder(board.projects.filter((p) => p.notePath === 'Personal/Release.md'));
    assert.equal(h.plugin.settings.projects.length, 2);
    assert.equal(h.plugin.settings.projects.find((p) => p.notePath === 'Work/Release.md').notes, 'Hidden work');
});

test('ambiguous legacy title-only settings are preserved instead of assigned to either note', async () => {
    const h = sameTitleFixture({ projects: [{ id: 'legacy-id', title: 'Release', notes: 'Legacy undecided' }] });
    const board = await h.view.loadTaskNotesBoard();
    assert.equal(board.projects.length, 3);
    for (const p of board.projects.filter((p) => p.notePath)) assert.equal(p.notes, '');
    assert.equal(board.projects.find((p) => p.id === 'legacy-id').notes, 'Legacy undecided');
    await h.view.persistProjectOrder(board.projects.filter((p) => p.notePath));
    assert.ok(h.plugin.settings.projects.some((p) => p.id === 'legacy-id'));
});

test('unique legacy title-only settings still migrate without duplicates or lost notes', async () => {
    const h = harness({ notes: [projectNote('Alpha')], settings: { projects: [{ id: 'legacy-id', title: 'Alpha', notes: 'Keep me' }] } });
    const board = await h.view.loadTaskNotesBoard();
    assert.equal(board.projects.length, 1);
    assert.equal(board.projects[0].key, 'file:Projects/Alpha.md');
    assert.equal(board.projects[0].notes, 'Keep me');
    await h.view.persistProjectOrder(board.projects);
    assert.equal(h.plugin.settings.projects.length, 1);
    assert.equal(h.plugin.settings.projects[0].id, 'legacy-id');
});
