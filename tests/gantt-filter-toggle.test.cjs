/* Exercise actual browser event handlers with fictional in-memory projects. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, MockElement, project } = require('./gantt-test-harness.cjs');
class Element extends MockElement {
    constructor(tag, parent) { super(tag, parent); this.dataset = {}; this.listeners = {}; }
    createEl(tag) { const child = new Element(tag, this); this.children.push(child); return child; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    async dispatch(name, event = {}) { await Promise.all((this.listeners[name] || []).map(fn => fn(event))); }
}
function setup() {
    const h = harness();
    const rows = [project('Example')];
    h.draw = () => {
        const root = new Element('div');
        h.view.renderProjectBrowser(root, rows);
        return root;
    };
    h.button = (root, value) => root.findByClass('hg-project-filter').find(e => e.dataset.filter === value);
    return h;
}
for (const filter of ['active', 'overdue', 'ready', 'completed', 'archived']) {
    test(`${filter}: second click returns to all, keeps the query, and updates pressed state`, async () => {
        const h = setup(); h.view.projectQuery = 'Example';
        let root = h.draw(); await h.button(root, filter).dispatch('click');
        assert.equal(h.view.projectFilter, filter);
        root = h.draw(); assert.equal(h.button(root, filter).attributes['aria-pressed'], 'true');
        await h.button(root, filter).dispatch('click');
        assert.equal(h.view.projectFilter, 'all'); assert.equal(h.view.projectQuery, 'Example');
        root = h.draw(); assert.equal(h.button(root, 'all').attributes['aria-pressed'], 'true');
        assert.equal(h.button(root, filter).attributes['aria-pressed'], 'false');
        assert.equal(root.findByClass('hg-project-clear').length, 0);
        assert.deepEqual(h.writes, []); assert.deepEqual(h.saves, []);
    });
}
test('switching filters selects the new one; all remains all on repeated clicks', async () => {
    const h = setup();
    for (const value of ['active', 'completed', 'all', 'all']) {
        await h.button(h.draw(), value).dispatch('click');
        assert.equal(h.view.projectFilter, value);
    }
});
test('Escape clears only search and cancels an outstanding debounce', async () => {
    const h = setup(); h.view.projectFilter = 'completed';
    const root = h.draw(), input = root.findByClass('hg-project-search-input')[0];
    input.value = 'Example'; await input.dispatch('input', { isComposing: false });
    let prevented = false;
    await input.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(input.value, '');
    assert.equal(h.view.projectQuery, ''); assert.equal(h.view.projectFilter, 'completed');
    const rendered = h.view.renderCount;
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(h.view.renderCount, rendered);
    assert.deepEqual(h.writes, []); assert.deepEqual(h.saves, []);
});
test('Escape during IME composition does not clear the input or filter', async () => {
    const h = setup(); h.view.projectQuery = '中文'; h.view.projectFilter = 'active';
    const input = h.draw().findByClass('hg-project-search-input')[0];
    await input.dispatch('keydown', { key: 'Escape', isComposing: true, preventDefault() { assert.fail('IME Escape intercepted'); } });
    assert.equal(h.view.projectQuery, '中文'); assert.equal(h.view.projectFilter, 'active');
});
test('native search input clearing keeps the status filter and adds no clear button', async () => {
    const h = setup(); h.view.projectQuery = 'Example'; h.view.projectFilter = 'overdue';
    let root = h.draw(); const input = root.findByClass('hg-project-search-input')[0];
    assert.equal(input.type, 'search'); input.value = '';
    await input.dispatch('input', { isComposing: false });
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(h.view.projectQuery, ''); assert.equal(h.view.projectFilter, 'overdue');
    root = h.draw(); assert.equal(root.findByClass('hg-project-search-row')[0].children.some(e => e.tagName === 'button'), false);
});
