const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
assert.equal(manifest.id, 'carrot-gantt');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(versions[manifest.version], manifest.minAppVersion);
if (process.argv[2]) assert.equal(process.argv[2], manifest.version, 'Release tag must match manifest.version');
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    assert.ok(fs.statSync(path.join(root, file)).size > 0, `${file} is missing or empty`);
}
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
assert.ok(!source.includes('__ganttTestAPI'), 'QA-only inspection must not ship');
assert.ok(!source.includes('/Users/'), 'Local user paths must not ship');
console.log(`BRAT release ${manifest.version}: version and three assets verified.`);
