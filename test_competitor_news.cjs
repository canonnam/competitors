const test = require('node:test');
const assert = require('node:assert/strict');
const {syncStatus, safeUrl} = require('./assets/competitor-news.js');
const now = Date.parse('2026-09-08T10:00:00+09:00');
const fresh = {updated_at: '2026-09-08T09:00:00+09:00', sync: {enabled: true, stale: false, errors: [], next_run: '2026-09-09T09:00:00+09:00'}};

test('daily badge shows waiting, disabled, failed and overdue collection accurately', () => {
  assert.equal(syncStatus(fresh, now).warning, false);
  assert.equal(syncStatus({...fresh, updated_at: null}, now).label, '첫 수집 대기');
  for (const sync of [{...fresh.sync, enabled: false}, {...fresh.sync, errors: ['케어닥']}, {...fresh.sync, stale: true}]) {
    assert.equal(syncStatus({...fresh, sync}, now).warning, true);
  }
  assert.equal(syncStatus(fresh, Date.parse(fresh.sync.next_run)).warning, true);
  assert.equal(syncStatus(null, now).warning, true);
});

test('article links reject executable schemes and embedded credentials', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,bad', '//evil.example', 'https://user:secret@example.org', 'not a URL']) {
    assert.equal(safeUrl(value), '');
  }
  assert.equal(safeUrl('https://news.google.com/rss/articles/123'), 'https://news.google.com/rss/articles/123');
  assert.equal(safeUrl('https://www.carefor.co.kr/cs/view_notice.php?calmgno=46856'), 'https://www.carefor.co.kr/cs/view_notice.php?calmgno=46856');
});
