/*
 * Run: node --test qa/gantt-v1.1.0.test.cjs
 * In-memory fictional notes only. This harness never opens or writes a real vault.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = new Date('2026-10-23T04:00:00.000Z').valueOf();
class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
}
class TFile {
    constructor(filePath, created = NOW) {
        this.path = filePath;
        this.basename = path.posix.basename(filePath, '.md');
        this.extension = 'md';
        this.stat = { ctime: created, mtime: created };
    }
}
class ItemView { constructor(leaf) { this.app = leaf.app; } }
class EmptyClass {}
class MockElement {
    constructor(tag = 'div', parent = null) { this.tagName = tag; this.parentElement = parent; this.children = []; this.attributes = {}; this.className = ''; this.textContent = ''; }
    createEl(tag) { const child = new MockElement(tag, this); this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    toggleClass(name, enabled) {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(' ');
    }
    findByClass(name) {
        return [this, ...this.children.flatMap((child) => child.findByClass(name))]
            .filter((element) => element.className.split(/\s+/).includes(name));
    }
}
const notices = [];
const obsidian = {
    Plugin: EmptyClass, ItemView, TFile, Modal: EmptyClass,
    FuzzySuggestModal: EmptyClass, PluginSettingTab: EmptyClass,
    Setting: EmptyClass, Menu: EmptyClass, setIcon() {},
    Notice: class { constructor(message) { notices.push(message); } },
    parseYaml() { throw new Error('Unexpected YAML parsing in in-memory test'); }
};
const moduleMock = { exports: {} };
const pluginPath = path.resolve(__dirname, '../main.js');
const context = vm.createContext({
    module: moduleMock, exports: moduleMock.exports,
    require(name) { assert.equal(name, 'obsidian'); return obsidian; },
    console, Date: FrozenDate, setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout, confirm: () => true }
});
vm.runInContext(fs.readFileSync(pluginPath, 'utf8') +
    '\nmodule.exports.__test = { GanttView, DEFAULT_GANTT_SETTINGS };', context,
    { filename: pluginPath });
const { GanttView, DEFAULT_GANTT_SETTINGS } = moduleMock.exports.__test;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ids = (values) => Array.from(values, (value) => value.id);
const titles = (values) => Array.from(values, (value) => value.title);
const keyFor = (name) => `file:Projects/${name}.md`;

function harness({ notes = [], settings = {}, taskNotes = {} } = {}) {
    const files = new Map();
    const metadata = new Map();
    const writes = [];
    const saves = [];
    for (const note of notes) {
        const file = new TFile(note.path, note.created);
        files.set(file.path, file);
        metadata.set(file.path, clone(note.fm || {}));
    }
    const app = {
        plugins: { enabledPlugins: new Set(['tasknotes']), plugins: {
            tasknotes: { settings: {
                customStatuses: [
                    { value: 'open', isCompleted: false, order: 0 },
                    { value: 'doing', isCompleted: false, order: 1 },
                    { value: 'done', isCompleted: true, order: 2 }
                ], ...taskNotes
            } },
            'carrot-home': { settings: {} }
        } },
        vault: {
            getMarkdownFiles: () => [...files.values()],
            getAbstractFileByPath: (name) => files.get(name) || null,
            cachedRead: async (file) => `# ${file.basename}\n\nFictional fixture.\n`,
            adapter: { read: async () => { throw new Error('No disk access in mock vault'); } }
        },
        metadataCache: {
            getFileCache: (file) => ({ frontmatter: metadata.get(file.path) }),
            getFirstLinkpathDest(target) {
                const normalized = String(target).replace(/\.md$/i, '');
                return [...files.values()].find((file) =>
                    file.path.replace(/\.md$/i, '') === normalized || file.basename === normalized) || null;
            }
        },
        fileManager: {
            generateMarkdownLink: (file) => `[[${file.path.replace(/\.md$/, '')}]]`,
            async processFrontMatter(file, callback) {
                const next = clone(metadata.get(file.path) || {});
                callback(next);
                metadata.set(file.path, next);
                writes.push({ path: file.path, fm: clone(next) });
            }
        },
        workspace: { getLeavesOfType: () => [], trigger() {} }
    };
    const plugin = {
        app,
        settings: { ...clone(DEFAULT_GANTT_SETTINGS), ...clone(settings) },
        async saveSettings() { saves.push(clone(this.settings)); },
        refreshCarrotHome() {},
        async refreshAllViews() {}
    };
    const view = new GanttView({ app }, plugin);
    view.renderCount = 0;
    view.render = async () => { view.renderCount++; };
    view.withPageScrollPreserved = async (callback) => callback();
    return { app, plugin, view, files, metadata, writes, saves };
}

function projectNote(name, fm = {}) {
    return { path: `Projects/${name}.md`, fm: { title: name, carrotProject: true, ...fm } };
}
function taskNote(name, projectNames, fm = {}) {
    return { path: `Tasks/${name}.md`, fm: {
        title: name, status: 'open', projects: projectNames.map((name) => `[[Projects/${name}]]`), ...fm
    } };
}
function project(name, tasks = [], extras = {}) {
    return { id: name, key: keyFor(name), title: name, notePath: `Projects/${name}.md`,
        color: '#8ec723', tasks, allTasks: tasks.slice(), ...extras };
}
function task(id, extras = {}) {
    return { id, title: id, done: false, progress: 0, start: '', end: '', dueDate: '', ...extras };
}
function fixtureNotes() {
    return [
        projectNote('Alpha'), projectNote('Beta'),
        taskNote('Open', ['Alpha'], { status: 'open', scheduled: '2026-10-25', due: '2026-10-30' }),
        taskNote('Done', ['Alpha'], { status: 'done', scheduled: '2026-10-01', due: '2026-10-02' }),
        taskNote('Shared', ['Alpha', 'Beta'], { status: 'doing', due: '2026-10-26' }),
        taskNote('Unassigned', [], { scheduled: '1999-01-01', due: '2040-01-01' })
    ];
}

test('hiding completed tasks preserves project progress and full date span', async () => {
    const h = harness({ notes: fixtureNotes(), settings: { showCompletedTasks: false } });
    const board = await h.view.loadTaskNotesBoard();
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    assert.deepEqual(titles(alpha.tasks).sort(), ['Open', 'Shared']);
    assert.deepEqual(titles(alpha.allTasks).sort(), ['Done', 'Open', 'Shared']);
    assert.equal(alpha.progress, 33);
    assert.equal(alpha.start, '2026-10-01');
    assert.equal(alpha.end, '2026-10-30');
    assert.equal(h.view.projectReadyToComplete(alpha), false);
    assert.equal(board.projects.find((item) => item.title === 'Beta').allTasks.length, 1);
    assert.ok(!board.tasks.some((item) => item.title === 'Unassigned'));
    assert.equal(h.writes.length, 0);
});

test('external deletion of a hidden completed child refreshes project statistics', async () => {
    const h = harness({ notes: [
        projectNote('Alpha'), taskNote('Open', ['Alpha']), taskNote('Done', ['Alpha'], { status: 'done' })
    ], settings: { showCompletedTasks: false } });
    h.view.board = await h.view.loadTaskNotesBoard();
    assert.deepEqual(titles(h.view.board.tasks), ['Open']);
    assert.equal(h.view.board.projects[0].allTasks.length, 2);
    assert.equal(h.view.board.projects[0].progress, 50);
    let refreshes = 0;
    h.view.scheduleRender = () => { refreshes++; };
    const deleted = h.files.get('Tasks/Done.md');
    h.files.delete(deleted.path);
    h.metadata.delete(deleted.path);
    await h.view.handleVaultDelete(deleted);
    assert.equal(refreshes, 1);
    const refreshed = await h.view.loadTaskNotesBoard();
    assert.equal(refreshed.projects[0].allTasks.length, 1);
    assert.equal(refreshed.projects[0].progress, 0);
});

for (const [label, config] of [
    ['completion', { showCompleted: false, count: 100 }],
    ['text', { showCompleted: true, count: 100, taskFilter: { text: 'Open' } }],
    ['limit', { showCompleted: true, count: 1 }],
    ['hidden Kanban columns', { layout: 'kanban', kanbanHidden: ['done', 'doing'] }]
]) {
    test(`Dashboard ${label} filters do not change the full project denominator`, async () => {
        const h = harness({ notes: fixtureNotes() });
        const board = await h.view.loadTaskNotesBoard(config);
        const alpha = board.projects.find((item) => item.title === 'Alpha');
        assert.equal(alpha.allTasks.length, 3);
        assert.equal(alpha.progress, 33);
        assert.ok(alpha.tasks.length < alpha.allTasks.length);
        assert.equal(h.view.projectReadyToComplete(alpha), false);
    });
}

test('an all-done project remains visible and ready to complete when every task is hidden', async () => {
    const h = harness({ notes: [projectNote('Finished'), taskNote('Only task', ['Finished'], { status: 'done' })],
        settings: { showCompletedTasks: false } });
    const board = await h.view.loadTaskNotesBoard();
    const finished = board.projects.find((item) => item.title === 'Finished');
    assert.equal(finished.tasks.length, 0);
    assert.equal(finished.allTasks.length, 1);
    assert.equal(finished.progress, 100);
    assert.equal(h.view.projectReadyToComplete(finished), true);
    assert.equal(h.view.projectCompleted(finished), false);
    assert.equal(h.view.projectGroup(finished), 'active');
});

test('empty projects are not automatically ready to complete', () => {
    const h = harness({ notes: [projectNote('Empty')] });
    assert.equal(h.view.projectReadyToComplete(project('Empty')), false);
});

test('folder scope and a scoped repository cannot hide related tasks from progress', async () => {
    const outside = taskNote('Outside done', ['Alpha'], { status: 'done' });
    outside.path = 'Elsewhere/Outside done.md';
    const h = harness({ notes: [projectNote('Alpha'), taskNote('Inside open', ['Alpha']), outside] });
    h.app.plugins.plugins['carrot-home'].taskRepository = {
        entries: () => [{ file: h.files.get('Tasks/Inside open.md'), frontmatter: h.metadata.get('Tasks/Inside open.md') }],
        readText: async () => '# Fictional task\n'
    };
    const board = await h.view.loadTaskNotesBoard({ folderScope: 'whitelist', folders: ['Tasks'], showCompleted: true, count: 100 });
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    assert.deepEqual(titles(alpha.tasks), ['Inside open']);
    assert.equal(alpha.allTasks.length, 2);
    assert.equal(alpha.progress, 50);
});

test('TaskNotes custom completed statuses remain authoritative over dashboard filter preferences', async () => {
    const h = harness({ notes: [
        projectNote('Alpha'), taskNote('Accepted', ['Alpha'], { status: 'accepted' }), taskNote('Draft', ['Alpha'])
    ], taskNotes: { customStatuses: [
        { value: 'open', isCompleted: false }, { value: 'accepted', isCompleted: true }
    ] } });
    const board = await h.view.loadTaskNotesBoard({ showCompleted: true, count: 100, taskNotesDoneStatuses: ['done'] });
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    assert.equal(alpha.progress, 50);
    assert.equal(alpha.allTasks.find((item) => item.title === 'Accepted').done, true);
});

test('implicit all-done project survives completed-task hiding without a project marker', async () => {
    const h = harness({ notes: [
        { path: 'Projects/Implicit.md', fm: { title: 'Implicit' } },
        taskNote('Done', ['Implicit'], { status: 'done' })
    ], settings: { showCompletedTasks: false } });
    const board = await h.view.loadTaskNotesBoard();
    const implicit = board.projects.find((item) => item.title === 'Implicit');
    assert.ok(implicit);
    assert.equal(implicit.tasks.length, 0);
    assert.equal(implicit.progress, 100);
    assert.equal(h.view.projectReadyToComplete(implicit), true);
});

for (const [label, status, settings, config] of [
    ['Dashboard text filter with unfinished work', 'open', {}, { showCompleted: true, count: 100, taskFilter: { text: 'does-not-match-any-task' } }],
    ['Dashboard hidden Kanban column with unfinished work', 'open', {}, { layout: 'kanban', kanbanHidden: ['open'] }],
    ['hidden completed tasks', 'done', { showCompletedTasks: false }, null]
]) {
    test(`archived implicit project remains in its archive group after ${label}`, async () => {
        const h = harness({ notes: [
            { path: 'Projects/Implicit archive.md', fm: { title: 'Implicit archive', tags: ['archived'] } },
            taskNote('Only child', ['Implicit archive'], { status })
        ], settings });
        assert.equal(h.plugin.settings.projects.length, 0);
        const board = await h.view.loadTaskNotesBoard(config);
        const archived = board.projects.find((item) => item.title === 'Implicit archive');
        assert.ok(archived, 'Archive membership must survive display filters without a marker or saved project registration');
        assert.equal(archived.tasks.length, 0);
        assert.equal(archived.allTasks.length, 1);
        assert.equal(h.view.projectGroup(archived), 'archived');
        assert.equal(h.writes.length, 0);
    });
}

test('archived projects never expand the everyday timeline, even when expanded', () => {
    const h = harness({ notes: [projectNote('Active'), projectNote('Archive', { tags: ['archived'] })] });
    const active = project('Active', [task('Current', { start: '2026-10-25', end: '2026-10-25' })]);
    const archive = project('Archive', [task('Old', { start: '1999-01-01', end: '2040-01-01' })]);
    h.view.board = { projects: [active] };
    const baseline = h.view.computeRange();
    h.view.board.projects.push(archive);
    for (const expanded of [false, true]) {
        h.plugin.settings.archivedProjectsExpanded = expanded;
        const actual = h.view.computeRange();
        assert.equal(actual.start.valueOf(), baseline.start.valueOf());
        assert.equal(actual.end.valueOf(), baseline.end.valueOf());
    }
});

test('an active far-future task still expands the timeline', () => {
    const h = harness({ notes: [projectNote('Active')] });
    h.view.board = { projects: [project('Active', [task('Future', { start: '2030-01-01', end: '2030-01-02' })])] };
    assert.ok(h.view.computeRange().end > new Date('2030-01-02'));
});

test('collapsed completed section excludes historical dates until explicitly expanded', () => {
    const h = harness({ notes: [projectNote('Done', { project_status: 'completed' })] });
    const done = project('Done', [task('Old', { start: '1999-01-01', end: '1999-01-02', done: true, progress: 100 })]);
    h.view.board = { projects: [] };
    const baseline = h.view.computeRange();
    h.view.board.projects.push(done);
    h.plugin.settings.completedProjectsExpanded = false;
    assert.equal(h.view.computeRange().start.valueOf(), baseline.start.valueOf());
    h.plugin.settings.completedProjectsExpanded = true;
    assert.ok(h.view.computeRange().start < new Date('1999-01-01'));
});

test('project sorting respects status groups and only pins within active projects', () => {
    const h = harness({ notes: [
        projectNote('Zeta'), projectNote('Alpha'), projectNote('Pinned'),
        projectNote('Complete', { project_status: 'completed' }), projectNote('Archive', { tags: ['archived'] })
    ], settings: { projectSortMode: 'name', projectViewState: {
        [keyFor('Pinned')]: { pinned: true }, [keyFor('Archive')]: { pinned: true }
    } } });
    const original = ['Archive', 'Zeta', 'Complete', 'Alpha', 'Pinned'].map((name) => project(name));
    assert.deepEqual(ids(h.view.sortProjects(original)), ['Pinned', 'Alpha', 'Zeta', 'Complete', 'Archive']);
    assert.deepEqual(ids(original), ['Archive', 'Zeta', 'Complete', 'Alpha', 'Pinned']);
});

test('urgent order ignores completed deadlines and puts undated projects last', () => {
    const h = harness({ settings: { projectSortMode: 'urgent' } });
    const values = [
        project('Undated'),
        project('Future', [task('Soon', { dueDate: '2026-10-25', due: '2026-10-25' })]),
        project('DoneOld', [task('Done', { dueDate: '2001-01-01', due: '2001-01-01', done: true, progress: 100 })]),
        project('Overdue', [task('Late', { dueDate: '2026-10-20', due: '2026-10-20' })])
    ];
    assert.deepEqual(ids(h.view.sortProjects(values)), ['Overdue', 'Future', 'Undated', 'DoneOld']);
});

test('deadline sort uses the project delivery date, falling back to its latest child deadline', () => {
    const h = harness({ notes: [projectNote('Explicit', { due: '2026-11-01' }), projectNote('Derived'), projectNote('NoDate')],
        settings: { projectSortMode: 'due' } });
    const values = [project('NoDate'), project('Derived', [
        task('Early', { due: '2026-10-24' }), task('Last', { due: '2026-11-02' })
    ]), project('Explicit', [task('Child later', { due: '2026-12-01' })])];
    assert.deepEqual(ids(h.view.sortProjects(values)), ['Explicit', 'Derived', 'NoDate']);
});

test('start sort uses the project schedule, then full project span, with missing dates last', () => {
    const h = harness({ notes: [projectNote('Explicit', { scheduled: '2026-10-21' }), projectNote('Derived'), projectNote('NoDate')],
        settings: { projectSortMode: 'start' } });
    const values = [project('NoDate'), project('Explicit', [], { start: '2026-12-01' }), project('Derived', [], { start: '2026-10-20' })];
    assert.deepEqual(ids(h.view.sortProjects(values)), ['Derived', 'Explicit', 'NoDate']);
});

test('recently-created order prefers metadata creation date and falls back to file creation', () => {
    const h = harness({ notes: [
        { ...projectNote('Metadata', { dateCreated: '2026-10-22' }), created: new Date('2001-01-01').valueOf() },
        { ...projectNote('FileDate'), created: new Date('2026-10-21').valueOf() },
        { ...projectNote('Old'), created: new Date('2025-01-01').valueOf() }
    ], settings: { projectSortMode: 'created' } });
    assert.deepEqual(ids(h.view.sortProjects(['Old', 'FileDate', 'Metadata'].map((name) => project(name)))), ['Metadata', 'FileDate', 'Old']);
});

test('automatic sorting preserves the saved manual order across switching modes', () => {
    const values = ['Zeta', 'Alpha', 'Middle'].map((name) => project(name));
    const h = harness({ settings: { projects: values.map((item) => clone(item)), projectSortMode: 'name' } });
    const snapshot = clone(h.plugin.settings.projects);
    assert.deepEqual(ids(h.view.sortProjects(values)), ['Alpha', 'Middle', 'Zeta']);
    assert.deepEqual(h.plugin.settings.projects, snapshot);
    h.plugin.settings.projectSortMode = 'manual';
    assert.deepEqual(ids(h.view.sortProjects(values)), ['Zeta', 'Alpha', 'Middle']);
});

test('manual moves stay inside status and pin groups and retain hidden saved projects', async () => {
    const notes = ['A', 'B', 'Pinned', 'Done', 'Hidden'].map((name) => projectNote(name,
        name === 'Done' ? { project_status: 'completed' } : {}));
    const h = harness({ notes, settings: {
        projectSortMode: 'manual', projectViewState: { [keyFor('Pinned')]: { pinned: true } },
        projects: ['A', 'Pinned', 'Done', 'B', 'Hidden'].map((name) => project(name))
    } });
    h.view.board = { projects: ['A', 'Pinned', 'Done', 'B'].map((name) => project(name)) };
    for (const target of ['Pinned', 'Done']) await h.view.moveProjectOrder('A', target, true);
    assert.deepEqual(ids(h.view.board.projects), ['A', 'Pinned', 'Done', 'B']);
    await h.view.moveProjectOrder('B', 'A', true);
    const order = ids(h.plugin.settings.projects);
    assert.ok(order.indexOf('B') < order.indexOf('A'));
    assert.ok(order.includes('Hidden'));
    const before = clone(h.plugin.settings.projects);
    h.plugin.settings.projectSortMode = 'name';
    await h.view.moveProjectOrder('A', 'B', true);
    assert.deepEqual(clone(h.plugin.settings.projects), before);
});

test('keyboard movement uses neighboring rows within the same manual group', async () => {
    const h = harness({ notes: [projectNote('A'), projectNote('B'), projectNote('Pinned'), projectNote('Done', { project_status: 'completed' })],
        settings: { projectSortMode: 'manual', projectViewState: { [keyFor('Pinned')]: { pinned: true } } } });
    h.view.board = { projects: ['A', 'Pinned', 'Done', 'B'].map((name) => project(name)) };
    await h.view.moveProjectBy(h.view.board.projects[0], 1);
    assert.deepEqual(ids(h.view.sortProjects(h.view.board.projects)), ['Pinned', 'B', 'A', 'Done']);
});

test('pin and collapse state survives save/reload without modifying project or task notes', async () => {
    const h = harness({ notes: [projectNote('Alpha')] });
    const alpha = project('Alpha');
    await h.view.setProjectViewState(alpha, { pinned: true, collapsed: true });
    assert.ok(h.saves.length);
    const restored = harness({ notes: [projectNote('Alpha')], settings: h.saves.at(-1) });
    assert.equal(restored.view.projectPinned(alpha), true);
    assert.equal(restored.view.projectCollapsed(alpha), true);
    assert.equal(h.writes.length, 0);
    await h.view.setProjectViewState(alpha, { pinned: false });
    assert.equal(h.view.projectPinned(alpha), false);
    assert.equal(h.view.projectCollapsed(alpha), true);
});

test('failed display-state persistence rolls back without reporting successful state', async () => {
    const h = harness({ settings: { projectViewState: { [keyFor('Alpha')]: { collapsed: true, pinned: false } } } });
    const before = clone(h.plugin.settings.projectViewState);
    h.plugin.saveSettings = async () => { throw new Error('Simulated disk failure'); };
    const saved = await h.view.setProjectViewState(project('Alpha'), { pinned: true });
    assert.equal(saved, false);
    assert.deepEqual(h.plugin.settings.projectViewState, before);
    assert.equal(h.writes.length, 0);
});

test('completion writes only the project note; reopening and archive precedence persist', async () => {
    const h = harness({ notes: [projectNote('Alpha'), taskNote('Child', ['Alpha'], { status: 'done' })] });
    const board = await h.view.loadTaskNotesBoard();
    h.view.board = board;
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    await h.view.setProjectCompleted(alpha, true);
    assert.deepEqual(Array.from(new Set(h.writes.map((item) => item.path))), ['Projects/Alpha.md']);
    assert.equal(h.view.projectGroup(alpha), 'completed');
    const restored = harness({ notes: [...h.files.values()].map((file) => ({ path: file.path, fm: h.metadata.get(file.path) })) });
    assert.equal(restored.view.projectCompleted(alpha), true);
    await h.view.setProjectCompleted(alpha, false);
    assert.equal(h.view.projectGroup(alpha), 'active');
    h.metadata.get('Projects/Alpha.md').tags = ['archived'];
    assert.equal(h.view.projectGroup(alpha), 'archived');
    assert.equal(h.metadata.get('Tasks/Child.md').status, 'done');
});

test('TaskNotes project completion uses its mapped status field and custom completed value', async () => {
    const h = harness({ notes: [
        projectNote('Alpha', { state: 'todo' }),
        taskNote('Child', ['Alpha'], { state: 'accepted' })
    ], taskNotes: { fieldMapping: { status: 'state' }, customStatuses: [
        { value: 'todo', isCompleted: false }, { value: 'accepted', isCompleted: true }
    ] } });
    const board = await h.view.loadTaskNotesBoard();
    h.view.board = board;
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    await h.view.setProjectCompleted(alpha, true);
    assert.equal(h.metadata.get('Projects/Alpha.md').state, 'accepted');
    assert.equal(h.view.projectCompleted(alpha), true);
    assert.deepEqual(Array.from(new Set(h.writes.map((item) => item.path))), ['Projects/Alpha.md']);
    await h.view.setProjectCompleted(alpha, false);
    assert.equal(h.metadata.get('Projects/Alpha.md').state, 'todo');
});

for (const [label, current, completed, statuses] of [
    ['completion without any configured completed status', 'open', true, [{ value: 'open', isCompleted: false }]],
    ['reopening without any configured unfinished status', 'accepted', false, [{ value: 'accepted', isCompleted: true }]]
]) {
    test(`TaskNotes project refuses ${label}`, async () => {
        // No children: an unrelated incomplete-child guard must not mask the status validation.
        const h = harness({ notes: [projectNote('Alpha', { state: current })],
            taskNotes: { fieldMapping: { status: 'state' }, customStatuses: statuses } });
        const board = await h.view.loadTaskNotesBoard();
        h.view.board = board;
        const alpha = board.projects.find((item) => item.title === 'Alpha');
        const before = clone(h.metadata.get('Projects/Alpha.md'));
        const changed = await h.view.setProjectCompleted(alpha, completed);
        assert.equal(changed, false);
        assert.deepEqual(h.metadata.get('Projects/Alpha.md'), before);
        assert.equal(h.writes.length, 0);
        assert.equal(h.view.projectCompleted(alpha), !completed);
    });
}

test('project settings lists all associated tasks even when display filters hide them', async () => {
    const h = harness({ notes: fixtureNotes(), settings: { showCompletedTasks: false } });
    const board = await h.view.loadTaskNotesBoard({ showCompleted: false, count: 1 });
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    assert.equal(alpha.tasks.length, 1);
    const popover = new MockElement();
    h.view.makeProjectTaskList(popover, alpha);
    assert.deepEqual(popover.findByClass('hg-project-task-title').map((element) => element.textContent).sort(), ['Done', 'Open', 'Shared']);
    assert.equal(popover.findByClass('hg-project-task-count')[0].textContent, '3 项');
});

test('incomplete children block project completion even when display filters hide them', async () => {
    const h = harness({ notes: [projectNote('Alpha'), taskNote('Open', ['Alpha']), taskNote('Done', ['Alpha'], { status: 'done' })] });
    const board = await h.view.loadTaskNotesBoard({ showCompleted: true, count: 100, taskFilter: { text: 'Done' } });
    h.view.board = board;
    const alpha = board.projects.find((item) => item.title === 'Alpha');
    assert.deepEqual(titles(alpha.tasks), ['Done']);
    await h.view.setProjectCompleted(alpha, true);
    assert.equal(h.view.projectCompleted(alpha), false);
    assert.equal(h.writes.length, 0);
});
