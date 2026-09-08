const assert = require('node:assert/strict');
const fs = require('node:fs');
const data = require('./assets/statistics-data.js');
const {readSaved, filterItems} = require('./assets/statistics.js');
const manifest = JSON.parse(fs.readFileSync('data/statistics_sources.json', 'utf8'));

// Corrupt/stale browser storage must not break the page or introduce unknown IDs.
assert.deepEqual([...readSaved('not json')], []);
assert.deepEqual([...readSaved('{"length":100}')], []);
assert.deepEqual([...readSaved('["choosing-a-home","choosing-a-home","deleted",null,4]')], ['choosing-a-home']);
assert.equal(filterItems({savedOnly:true,saved:new Set()}).length, 0);
assert.deepEqual(filterItems({savedOnly:true,saved:new Set(['family-priorities']),topic:'돌봄·품질'}).map(x=>x.id), ['family-priorities']);
assert.equal(filterItems({savedOnly:true,saved:new Set(['family-priorities']),topic:'입소·수요'}).length, 0);
assert.deepEqual(filterItems({query:'  물리적   환경  '}).map(x=>x.id), ['choosing-a-home']);
assert.deepEqual(filterItems({query:'ＩＣＴ'}).map(x=>x.id), ['digital-care']);
assert.equal(filterItems({query:'없는통계검색어'}).length, 0);
assert.equal(filterItems({documentId:'housing'}).length, 2);
assert.equal(filterItems({view:'documents',query:'2023'}).length, 1);
assert.equal(filterItems({view:'documents',topic:'인력·운영'}).length, 2);

// Every displayed source and crop has reproducible provenance and valid dimensions.
assert.equal(new Set(data.documents.map(x=>x.id)).size,data.documents.length);
assert.equal(new Set(data.bookmarks.map(x=>x.id)).size,data.bookmarks.length);
for (const doc of data.documents) {
  const source = manifest.documents.find(x=>x.id===doc.id);
  assert.ok(source);
  assert.equal(source.downloadUrl,doc.downloadUrl);
  assert.equal(source.pdfPages,doc.pdfPages);
  assert.match(source.sha256,/^[a-f0-9]{64}$/);
  for (const url of [doc.downloadUrl,doc.sourceUrl]) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol,'https:');
    assert.ok(['www.kihasa.re.kr','repository.kihasa.re.kr'].includes(parsed.hostname));
  }
  assert.ok(doc.year <= Number(doc.published.slice(0,4)));
}
for (const item of data.bookmarks) {
  const source = manifest.documents.find(x=>x.id===item.documentId);
  const capture = source.captures.find(x=>x.id===item.id);
  assert.ok(data.topics.includes(item.topic));
  assert.ok(item.pdfPage >= 1 && item.pdfPage <= source.pdfPages);
  assert.equal(capture.pdfPage,item.pdfPage);
  assert.equal(capture.printedPage,item.printedPage);
  assert.equal(capture.figure,item.figure);
  assert.deepEqual(capture.capture,item.capture);
  assert.equal(capture.image,item.image);
  const png = fs.readFileSync('.'+item.image);
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),item.capture[2]-item.capture[0]);
  assert.equal(png.readUInt32BE(20),item.capture[3]-item.capture[1]);
  for (const field of ['insight','action','caveat','alt']) assert.ok(item[field].length>20);
}
console.log(`Statistics: filters, saved state and provenance verified (${data.documents.length} documents, ${data.bookmarks.length} captures).`);
