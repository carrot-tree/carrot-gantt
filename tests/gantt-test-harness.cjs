/*
 * Shared in-memory harness for Carrot Gantt regression tests.
 * In-memory fictional notes only. This harness never opens or writes a real vault.
 */
const assert = require('node:assert/strict');
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


module.exports = { harness, projectNote, taskNote, project, task, fixtureNotes, titles, ids, keyFor, TFile, MockElement, GanttView, DEFAULT_GANTT_SETTINGS, clone, NOW };
