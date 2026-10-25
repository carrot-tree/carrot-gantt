/* Full render concurrency regressions with an in-memory DOM and deferred loads. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class EmptyClass {}
class ItemView { constructor(leaf) { this.app = leaf.app; } }
class Element {
    constructor(parent = null) { this.parentElement = parent; this.children = []; this.isConnected = true; }
    createEl() { const child = new Element(this); this.children.push(child); return child; }
    empty() { for (const child of this.children) child.isConnected = false; this.children = []; }
    toggleClass() {}
    setAttribute() {}
    addEventListener() {}
    closest() { return null; }
    remove() { this.isConnected = false; }
}
const errors = [];
const moduleMock = { exports: {} };
const pluginPath = path.resolve(__dirname, '../main.js');
vm.runInNewContext(fs.readFileSync(pluginPath, 'utf8') +
    '\nmodule.exports.__test = { GanttView, DEFAULT_GANTT_SETTINGS };', {
    module: moduleMock, exports: moduleMock.exports,
    require(name) {
        assert.equal(name, 'obsidian');
        return { Plugin: EmptyClass, ItemView, TFile: EmptyClass, Menu: EmptyClass,
            Modal: EmptyClass, FuzzySuggestModal: EmptyClass, PluginSettingTab: EmptyClass,
            Setting: EmptyClass, Notice: EmptyClass, setIcon() {} };
    },
    console: { ...console, error: (...args) => errors.push(args) },
    setTimeout, clearTimeout, document: { activeElement: null }, window: { setTimeout, clearTimeout }
}, { filename: pluginPath });
const { GanttView, DEFAULT_GANTT_SETTINGS } = moduleMock.exports.__test;

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function board(name) {
    return { mode: 'tasknotes', projects: [{ id: name, title: name, tasks: [], allTasks: [] }], tasks: [] };
}
function harness() {
    const app = { vault: {}, plugins: { enabledPlugins: new Set(['tasknotes']) } };
    const plugin = { app, settings: JSON.parse(JSON.stringify(DEFAULT_GANTT_SETTINGS)) };
    const view = new GanttView({ app }, plugin);
    view.contentEl = new Element();
    view.isCompactDashboardMode = () => false;
    view.closePopover = () => {};
    view.clearCompactHomeEntry = () => {};
    view.attachTopbarToCarrotHomeHeader = () => {};
    view.projectGroup = () => 'active';
    const displayed = [];
    view.renderProjectBrowser = (root, projects) => {
        displayed.push({
            board: view.board,
            query: view.projectQuery || '',
            matches: Array.from(GanttView.prototype.filterProjects.call(view, projects), (project) => project.id)
        });
    };
    // Exercise the full render through committing the board and rendering the
    // search browser, then stop at its real no-results branch before layout work.
    view.filterProjects = () => [];
    view.board = board('Old');
    const loads = [];
    view.loadBoard = () => {
        const load = deferred();
        loads.push(load);
        return load.promise;
    };
    return { view, loads, displayed };
}

test('a quick search waits for a pending vault refresh instead of committing the old board', async () => {
    const h = harness();
    const full = h.view.render();
    h.view.projectQuery = 'Fresh';
    let finished = false;
    const search = h.view.render({ reuseBoard: true }).then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(h.loads.length, 1);
    assert.equal(h.displayed.length, 0);
    const fresh = board('Fresh');
    h.loads[0].resolve(fresh);
    await Promise.all([full, search]);
    assert.equal(h.view.board, fresh);
    assert.deepEqual(h.displayed.map((entry) => entry.matches), [['Fresh']]);
    assert.equal(h.view._pendingBoardLoad, null);
});

test('later full refresh starts its own load and older finally cannot clear it', async () => {
    const h = harness();
    const first = h.view.render();
    const latest = h.view.render();
    assert.equal(h.loads.length, 2);
    const pendingLatest = h.loads[1].promise;
    h.loads[0].resolve(board('Intermediate'));
    await first;
    assert.equal(h.view._pendingBoardLoad, pendingLatest);
    h.view.projectQuery = 'Latest';
    const search = h.view.render({ reuseBoard: true });
    assert.equal(h.loads.length, 2);
    const fresh = board('Latest');
    h.loads[1].resolve(fresh);
    await Promise.all([latest, search]);
    assert.equal(h.view.board, fresh);
    assert.deepEqual(h.displayed.map((entry) => entry.matches), [['Latest']]);
    assert.equal(h.view._pendingBoardLoad, null);
});

test('out-of-order old loads and their waiting searches cannot replace the newest data', async () => {
    const h = harness();
    const first = h.view.render();
    h.view.projectQuery = 'Intermediate';
    const earlySearch = h.view.render({ reuseBoard: true });
    const latest = h.view.render();
    h.view.projectQuery = 'Latest';
    const finalSearch = h.view.render({ reuseBoard: true });
    assert.equal(h.loads.length, 2);
    const fresh = board('Latest');
    h.loads[1].resolve(fresh);
    await Promise.all([latest, finalSearch]);
    h.loads[0].resolve(board('Intermediate'));
    await Promise.all([first, earlySearch]);
    assert.equal(h.view.board, fresh);
    assert.deepEqual(h.displayed.map((entry) => entry.matches), [['Latest']]);
    assert.equal(h.view._pendingBoardLoad, null);
});

test('an older failed load leaves the newer pending refresh available to quick filters', async () => {
    const h = harness();
    const first = h.view.render();
    const latest = h.view.render();
    h.loads[0].reject(new Error('older refresh failed'));
    await first;
    assert.equal(h.view._pendingBoardLoad, h.loads[1].promise);
    const quickFilter = h.view.render({ reuseBoard: true });
    const fresh = board('Recovered');
    h.loads[1].resolve(fresh);
    await Promise.all([latest, quickFilter]);
    assert.equal(h.view.board, fresh);
    assert.equal(h.displayed.length, 1);
    assert.equal(h.view._pendingBoardLoad, null);
});

test('without a pending refresh quick filters reuse the current board without I/O', async () => {
    const h = harness();
    const current = h.view.board;
    h.view.projectQuery = 'Old';
    await h.view.render({ reuseBoard: true });
    assert.equal(h.loads.length, 0);
    assert.equal(h.view.board, current);
    assert.deepEqual(h.displayed.map((entry) => entry.matches), [['Old']]);
});
