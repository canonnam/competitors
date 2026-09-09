const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Export the same trusted, repository-owned data used by the dashboard.
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/competitors-data.js'), 'utf8').replace(/\r\n/g, '\n');
const context = {window: {}};
vm.runInNewContext(source, context, {timeout: 2000});
const items = Object.entries(context.window.competitorData).map(([id, row]) => ({
  id, name: row.n, type: row.type, source: row.src, url: row.url,
  facts: row.facts, note: row.note, price50: row.price50,
}));
if (!items.length || items.some(row => !row.name || !row.price50?.checked)) throw new Error('Invalid competitor data');
const output = JSON.stringify({schemaVersion: 1, sourceHash: crypto.createHash('sha256').update(source).digest('hex'), items}, null, 2) + '\n';
const destination = path.join(root, 'data/competitor_knowledge.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== output) throw new Error('Regenerate competitor knowledge');
} else {
  fs.writeFileSync(destination, output);
  console.log(`Exported ${items.length} competitors`);
}
