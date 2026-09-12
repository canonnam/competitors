// Export the same repository-owned statistics data used by the public card.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/statistics-data.js'), 'utf8').replace(/\r\n/g, '\n');
const data = require(path.join(root, 'assets/statistics-data.js'));
if (!data.documents?.length || !data.bookmarks?.length) throw Error('Invalid statistics catalog');
const output = JSON.stringify({sourceHash: crypto.createHash('sha256').update(source).digest('hex'), ...data}, null, 2) + '\n';
const target = path.join(root, 'data/statistics_knowledge.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw Error('Regenerate statistics knowledge');
} else {
  fs.writeFileSync(target, output);
  console.log(`Exported ${data.documents.length} statistics documents and ${data.bookmarks.length} bookmarks`);
}
