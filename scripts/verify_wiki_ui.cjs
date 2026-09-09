const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const origin = process.env.WIKI_TEST_URL || 'http://localhost:8317';
const output = path.resolve('.local/wiki-ui-qa');
fs.mkdirSync(output, {recursive: true});

(async () => {
  const browser = await chromium.launch({headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome'});
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, {waitUntil: 'networkidle'});
    const launcher = page.getByRole('button', {name: '장기요양 지식 질문하기', exact: true});
    await launcher.click();
    await page.waitForFunction(() => document.querySelector('.wiki-state').textContent.includes('서비스 자료'));
    await page.getByRole('button', {name: '더비다 안양점과 인천점의 최근 운영손익을 비교해주세요', exact: true}).click();
    await page.getByRole('button', {name: '질문 보내기', exact: true}).click();
    await page.locator('.wiki-message-assistant').waitFor({timeout: 90000});
    assert.ok(await page.locator('.wiki-source').count() > 0, 'Live answer must cite evidence');
    const answer = await page.locator('.wiki-message-assistant .wiki-text').innerText();
    console.log(JSON.stringify({liveAnswer: answer, citations: await page.locator('.wiki-source summary').allTextContents()}));
    await page.screenshot({path: path.join(output, 'desktop-answer.png')});
    await page.locator('.wiki-source summary').first().click();
    assert.equal(await page.locator('.wiki-source[open] pre').first().isVisible(), true);
    assert.equal(await page.locator('.wiki-source-link').first().getAttribute('href'), '/operating-costs.html');
    await page.locator('.wiki-source summary').first().click();

    for (const viewport of [{width:390,height:844}, {width:320,height:568}]) {
      await page.setViewportSize(viewport);
      const bounds = await page.locator('.wiki-panel').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.wiki-send').isVisible(), true);
      assert.equal(await page.locator('.wiki-composer textarea').isVisible(), true);
      const overlapping = await page.evaluate(() => {
        const composer = document.querySelector('.wiki-composer').getBoundingClientRect();
        const messages = document.querySelector('.wiki-messages').getBoundingClientRect();
        return messages.bottom > composer.top + 1;
      });
      assert.equal(overlapping, false, 'Composer must not overlap messages');
      await page.screenshot({path:path.join(output, `mobile-${viewport.width}.png`)});
    }
    await page.keyboard.press('Escape');
    assert.equal(await launcher.getAttribute('aria-expanded'), 'false');
    assert.equal(await launcher.evaluate(element => element === document.activeElement), true);
    await launcher.click();
    await page.getByRole('button', {name:'새 대화', exact:true}).click();

    let calls = 0;
    await page.route('**/api/chat', async route => {
      calls++;
      if (calls === 1) await route.fulfill({status:503,json:{error:'테스트: 잠시 후 다시 시도해주세요.'}});
      else await route.fulfill({json:{answer:'**답변 테스트**\n\n<img src=x onerror="window.injected=true">[위험](javascript:alert(1))\n\n- 확인된 내용입니다.',sources:[{number:1,title:'검증 자료',updated:'2026-09-09',excerpt:'<script>window.injected=true</script>',url:'javascript:alert(1)'},{number:2,title:'공개 자료',updated:'2026-09-09',excerpt:'검증',url:'https://example.com/news'}]}});
    });
    const input = page.getByRole('textbox', {name:'위키에 질문'});
    await input.fill('재시도 확인');
    await input.dispatchEvent('keydown', {key:'Enter',isComposing:true});
    assert.equal(calls, 0, 'Korean IME Enter must not send');
    await page.getByRole('button', {name:'질문 보내기',exact:true}).click();
    await page.locator('.wiki-error:not([hidden])').waitFor();
    assert.equal(await input.inputValue(), '재시도 확인');
    await page.getByRole('button', {name:'질문 보내기',exact:true}).click();
    await page.locator('.wiki-message-assistant').waitFor();
    assert.equal(await page.locator('.wiki-message-user').count(), 1, 'Retry must not duplicate user turn');
    assert.equal(await page.locator('.wiki-message-assistant .wiki-text img, .wiki-message-assistant .wiki-text a').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('.wiki-source-link').count(), 1, 'Unsafe source URLs must not render');
    await page.reload({waitUntil:'networkidle'});
    await launcher.click();
    assert.equal(await page.locator('.wiki-message-user').count(), 1, 'Tab conversation should survive reload');
    assert.equal(await page.locator('.wiki-source-link').count(), 1, 'Restored sources must also validate URLs');

    if (process.env.WIKI_TEST_ADMIN_TOKEN) {
      await page.setViewportSize({width:1280,height:900});
      await page.goto(origin + '/knowledge.html', {waitUntil:'networkidle'});
      await page.getByLabel('관리자 키', {exact:true}).fill(process.env.WIKI_TEST_ADMIN_TOKEN);
      await page.getByRole('button', {name:'연결',exact:true}).click();
      await page.locator('#knowledge-workspace:not([hidden])').waitFor();
      await page.screenshot({path:path.join(output,'admin-documents.png')});
      if (origin.startsWith('http://localhost')) {
        await page.locator('#document-files').setInputFiles({name:'qa-temporary-document.md',mimeType:'text/markdown',buffer:Buffer.from('# QA 임시 문서\n\n검증 후 삭제할 테스트 자료입니다.','utf8')});
        await page.getByRole('button',{name:'등록',exact:true}).click();
        await page.getByRole('button',{name:'QA 임시 문서 삭제'}).waitFor();
        page.once('dialog', dialog => dialog.accept());
        await page.getByRole('button',{name:'QA 임시 문서 삭제'}).click();
        await page.getByRole('button',{name:'QA 임시 문서 삭제'}).waitFor({state:'detached'});
      }
      await page.getByRole('button',{name:'잠금',exact:true}).click();
      assert.equal(await page.locator('#knowledge-workspace').isVisible(), false);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({verified:true, screenshots:output, checks:['live cited answer','desktop and mobile layout','source excerpts','IME','error retry','XSS sanitization','session restore','admin upload/delete']}));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
