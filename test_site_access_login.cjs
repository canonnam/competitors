const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function screen(response) {
  const fields = {
    'map-access-form': { addEventListener(_name, submit) { this.submit = submit; } },
    'map-access-submit': { disabled: false },
    'map-access-password': { value: 'synthetic-password', focus() { this.focused = true; } },
    'map-access-error': { hidden: true, dataset: {} },
  };
  const requests = [];
  const location = { href: 'https://example.test/payroll-insurance.html?month=2026-09#detail',
    reload() { this.reloaded = (this.reloaded || 0) + 1; } };
  const context = { document: { getElementById(id) { return fields[id]; } },
    location, AbortController, setTimeout, clearTimeout,
    async fetch(url, options) { requests.push({ url, options }); return response; } };
  vm.runInNewContext(fs.readFileSync('assets/facility-map-login.js', 'utf8'), context);
  return { fields, location, requests,
    submit() { return fields['map-access-form'].submit({ preventDefault() {} }); } };
}

test('successful site login refreshes the exact shared address and clears the password field', async () => {
  const ui = screen({ ok: true, async json() { return { unlocked: true }; } });
  const requestedURL = ui.location.href;
  await ui.submit();
  assert.equal(ui.location.reloaded, 1);
  assert.equal(ui.location.href, requestedURL);
  assert.equal(ui.fields['map-access-password'].value, '');
  assert.equal(ui.fields['map-access-submit'].disabled, false);
  assert.equal(ui.requests[0].url, '/api/site-access/session');
  assert.equal(ui.requests[0].options.credentials, 'same-origin');
  assert.equal(ui.requests[0].options.cache, 'no-store');
  assert.equal(JSON.parse(ui.requests[0].options.body).password, 'synthetic-password');
});

test('wrong password stays on the locked screen with a readable error and focus', async () => {
  const ui = screen({ ok: false, async json() { return { error: '비밀번호가 올바르지 않습니다.' }; } });
  await ui.submit();
  assert.equal(ui.location.reloaded, undefined);
  assert.equal(ui.fields['map-access-password'].value, '');
  assert.equal(ui.fields['map-access-password'].focused, true);
  assert.equal(ui.fields['map-access-submit'].disabled, false);
  assert.equal(ui.fields['map-access-error'].hidden, false);
  assert.equal(ui.fields['map-access-error'].dataset.status, 'error');
  assert.equal(ui.fields['map-access-error'].textContent, '비밀번호가 올바르지 않습니다.');
});
