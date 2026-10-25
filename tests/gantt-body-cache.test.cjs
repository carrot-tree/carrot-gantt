/*
 * Run: node --test qa/gantt-body-cache.test.cjs
 * In-memory fictional files only; no real vault is opened or modified.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class TFile {
    constructor(filePath, body = '', fm = {}) {
        this.path = filePath;
        this.basename = path.posix.basename(filePath, '.md');
        this.extension = 'md';
        this.stat = { ctime: 100, mtime: 100, size: Buffer.byteLength(body) };
        this.body = body;
        this.fm = fm;
    }
}
class ItemView { constructor(leaf) { this.app = leaf.app; } }
class EmptyClass {}
const obsidian = {
    Plugin: EmptyClass, ItemView, TFile, Modal: EmptyClass,
    FuzzySuggestModal: EmptyClass, PluginSettingTab: EmptyClass,
    Setting: EmptyClass, Menu: EmptyClass, Notice: EmptyClass, setIcon() {},
    parseYaml() { throw new Error('Unexpected filesystem/YAML access in fixture'); }
};
const moduleMock = { exports: {} };
const pluginPath = path.resolve(__dirname, '../main.js');
vm.runInNewContext(fs.readFileSync(pluginPath, 'utf8') +
    '\nmodule.exports.__test = { GanttView, DEFAULT_GANTT_SETTINGS };', {
    module: moduleMock, exports: moduleMock.exports,
    require(name) { assert.equal(name, 'obsidian'); return obsidian; },
    console, setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout }
}, { filename: pluginPath });
const { GanttView, DEFAULT_GANTT_SETTINGS } = moduleMock.exports.__test;

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function harness(initial = []) {
    const files = new Map(initial.map((file) => [file.path, file]));
    const reads = [];
    const app = {
        plugins: { plugins: {
            tasknotes: { settings: {
                customStatuses: [{ value: 'open', isCompleted: false }, { value: 'done', isCompleted: true }]
            } },
            'carrot-home': { settings: {} }
        } },
        vault: {
            getMarkdownFiles: () => [...files.values()],
            getAbstractFileByPath: (name) => files.get(name) || null,
            cachedRead: async (file) => { reads.push(file.path); return file.body; }
        },
        metadataCache: {
            getFileCache: (file) => ({ frontmatter: file.fm }),
            getFirstLinkpathDest: (target) => files.get(`${String(target).replace(/\.md$/, '')}.md`) || null
        },
        fileManager: { generateMarkdownLink: (file) => `[[${file.path.replace(/\.md$/, '')}]]` }
    };
    const plugin = { app, settings: JSON.parse(JSON.stringify(DEFAULT_GANTT_SETTINGS)) };
    const view = new GanttView({ app }, plugin);
    return { app, plugin, view, files, reads };
}

test('unchanged task text is read once and stores the same extracted description', async () => {
    const file = new TFile('Tasks/A.md', '---\nstatus: open\n---\n# Task title\n\nFirst description.\n');
    const h = harness([file]);
    assert.equal(await h.view.readTaskBodyCached(file), 'First description.');
    assert.equal(await h.view.readTaskBodyCached(file), 'First description.');
    assert.equal(h.reads.length, 1);
    assert.equal(h.view._taskBodyReads.size, 0);
});

test('mtime and size each invalidate text, while unreliable metadata bypasses the cache', async () => {
    const file = new TFile('Tasks/A.md', 'old');
    const h = harness([file]);
    await h.view.readTaskBodyCached(file);
    file.body = 'new'; file.stat.mtime++;
    assert.equal(await h.view.readTaskBodyCached(file), 'new');
    file.body = 'newer'; file.stat.size = Buffer.byteLength(file.body);
    assert.equal(await h.view.readTaskBodyCached(file), 'newer');
    assert.equal(h.reads.length, 3);
    delete file.stat.size;
    file.body = 'unversioned first';
    assert.equal(await h.view.readTaskBodyCached(file), file.body);
    file.body = 'unversioned second';
    assert.equal(await h.view.readTaskBodyCached(file), file.body);
    assert.equal(h.reads.length, 5);
});

test('overlapping reads share the repository request and failed reads can retry', async () => {
    const file = new TFile('Tasks/A.md', 'unused');
    const h = harness([file]);
    let calls = 0;
    const gate = deferred();
    const repository = { readText: () => { calls++; return gate.promise; } };
    const first = h.view.readTaskBodyCached(file, repository);
    const second = h.view.readTaskBodyCached(file, repository);
    assert.equal(calls, 1);
    gate.reject(new Error('temporary read failure'));
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every((result) => result.status === 'rejected'));
    assert.equal(h.view._taskBodyReads.size, 0);
    assert.equal(h.view._taskBodyCache.size, 0);
    repository.readText = async () => { calls++; return '# Header\nRecovered description'; };
    assert.equal(await h.view.readTaskBodyCached(file, repository), 'Recovered description');
    assert.equal(await h.view.readTaskBodyCached(file, repository), 'Recovered description');
    assert.equal(calls, 2);
    assert.equal(h.reads.length, 0);
});

test('a read overlapping an edit returns the fresh version and cannot overwrite it later', async () => {
    const file = new TFile('Tasks/A.md', 'old');
    const h = harness([file]);
    const gate = deferred();
    let calls = 0;
    const repository = { readText: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve(file.body); } };
    const oldRead = h.view.readTaskBodyCached(file, repository);
    file.body = 'new'; file.stat.mtime++;
    assert.equal(await h.view.readTaskBodyCached(file, repository), 'new');
    gate.resolve('old');
    assert.equal(await oldRead, 'new');
    assert.equal(await h.view.readTaskBodyCached(file, repository), 'new');
    assert.equal(calls, 2);
    assert.equal(h.view._taskBodyReads.size, 0);
});

test('an edit during a single pending read causes one fresh reread', async () => {
    const file = new TFile('Tasks/A.md', 'old');
    const h = harness([file]);
    const gate = deferred();
    let calls = 0;
    const repository = { readText: () => { calls++; return calls === 1 ? gate.promise : Promise.resolve(file.body); } };
    const pending = h.view.readTaskBodyCached(file, repository);
    file.body = 'new'; file.stat.mtime++;
    gate.resolve('old');
    assert.equal(await pending, 'new');
    assert.equal(calls, 2);
});

test('pruning releases deleted, renamed, and externally changed file descriptions', async () => {
    const gone = new TFile('Tasks/Gone.md', 'deleted');
    const renamed = new TFile('Tasks/Before.md', 'renamed');
    const changed = new TFile('Tasks/Changed.md', 'changed');
    const h = harness([gone, renamed, changed]);
    for (const file of [gone, renamed, changed]) await h.view.readTaskBodyCached(file);
    h.files.delete(gone.path);
    h.files.delete(renamed.path); renamed.path = 'Tasks/After.md'; h.files.set(renamed.path, renamed);
    changed.stat.mtime++;
    h.view.pruneTaskBodyCache(true);
    assert.equal(h.view._taskBodyCache.size, 0);
    assert.equal(h.view._taskBodyCacheChars, 0);
    assert.equal(await h.view.readTaskBodyCached(renamed), 'renamed');
    assert.ok(h.view._taskBodyCache.has('Tasks/After.md'));
});

test('1001-task redraws hit the cache; entry eviction retains recently accessed tasks', async () => {
    const notes = Array.from({ length: 2049 }, (_, i) => new TFile(`Tasks/${i}.md`, `Description ${i}`));
    const h = harness(notes);
    for (const file of notes.slice(0, 1001)) await h.view.readTaskBodyCached(file);
    for (const file of notes.slice(0, 1001)) await h.view.readTaskBodyCached(file);
    assert.equal(h.reads.length, 1001);
    for (const file of notes.slice(1001, 2048)) await h.view.readTaskBodyCached(file);
    await h.view.readTaskBodyCached(notes[0]);
    await h.view.readTaskBodyCached(notes[2048]);
    assert.equal(h.view._taskBodyCache.size, 2048);
    assert.ok(h.view._taskBodyCache.has(notes[0].path));
    assert.ok(!h.view._taskBodyCache.has(notes[1].path));
});

test('retained text has a character budget and exceptionally large notes are not cached', async () => {
    const notes = Array.from({ length: 33 }, (_, i) => new TFile(`Tasks/${i}.md`, 'a'.repeat(128000)));
    const giant = new TFile('Tasks/Large.md', 'b'.repeat(128 * 1024 + 1));
    const h = harness([...notes, giant]);
    for (const file of notes) await h.view.readTaskBodyCached(file);
    assert.ok(h.view._taskBodyCacheChars <= 4000000);
    assert.ok(h.view._taskBodyCache.size < notes.length);
    assert.equal(h.view._taskBodyCacheChars, [...h.view._taskBodyCache.values()].reduce((sum, entry) => sum + entry.body.length, 0));
    await h.view.readTaskBodyCached(giant);
    await h.view.readTaskBodyCached(giant);
    assert.ok(!h.view._taskBodyCache.has(giant.path));
    assert.equal(h.reads.filter((name) => name === giant.path).length, 2);
});

test('a late read cannot repopulate cache maps cleared when the view closes', async () => {
    const file = new TFile('Tasks/A.md', 'body');
    const h = harness([file]);
    const gate = deferred();
    const pending = h.view.readTaskBodyCached(file, { readText: () => gate.promise });
    h.view._taskBodyCache.clear(); h.view._taskBodyReads.clear();
    h.view._taskBodyCache = null; h.view._taskBodyReads = null;
    gate.resolve('body');
    assert.equal(await pending, 'body');
    assert.equal(h.view._taskBodyCache, null);
    assert.equal(h.view._taskBodyReads, null);
});

test('board reloads preserve visible notes while reading fresh edited descriptions', async () => {
    const project = new TFile('Projects/Alpha.md', '# Alpha', { carrotProject: true, title: 'Alpha' });
    const task = new TFile('Tasks/One.md', '# One\n\nOriginal description', {
        title: 'One', status: 'open', projects: ['[[Projects/Alpha]]']
    });
    const h = harness([project, task]);
    const first = await h.view.loadTaskNotesBoard();
    assert.equal(first.tasks[0].notes, 'Original description');
    const repeated = await h.view.loadTaskNotesBoard();
    assert.equal(repeated.tasks[0].notes, 'Original description');
    assert.equal(h.reads.filter((name) => name === task.path).length, 1);
    task.body = '# One\n\nEdited description';
    task.stat.mtime++; task.stat.size = Buffer.byteLength(task.body);
    const changed = await h.view.loadTaskNotesBoard();
    assert.equal(changed.tasks[0].notes, 'Edited description');
    assert.equal(h.reads.filter((name) => name === task.path).length, 2);
    assert.equal(changed.projects[0].allTasks[0].notes, 'Edited description');
});
