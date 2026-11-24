/**
 * Fix-#2: After a supervisor restart, the page re-posts /api/mr {inMR:true} to the new bridge.
 *
 * The page detects a bridge restart by comparing instance event ids. When the id changes while
 * scene.immersive is true, the page immediately re-posts /api/mr so the new bridge registers
 * this page as an MR page and re-fits the terminal window.
 */
import { expect, test } from '@playwright/test';
import { OWNER_SHAPE } from '../bench/bench.js';
import { emulateQuest, enterMixedReality, pair, rig, type Rig } from './fixture.js';

test.use({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });

let r: Rig;
test.afterEach(async () => { await r?.stop(); });

test('Fix-#2: page re-posts /api/mr {inMR:true} when the bridge restarts while in mixed reality', async ({ page }) => {
  test.setTimeout(60_000);
  r = await rig(OWNER_SHAPE);
  await emulateQuest(page);
  await pair(page, r);
  await enterMixedReality(page);

  // Capture /api/mr POST bodies while in MR.
  const mrPosts: unknown[] = [];
  await page.route('**/api/mr', async route => {
    const body = route.request().postDataJSON();
    mrPosts.push(body);
    await route.continue();
  });

  // Simulate a bridge restart by injecting a new instance event with a different id.
  // The page must re-post /api/mr {inMR: true} in response.
  await page.evaluate(() => {
    (window.viewTest as { simulateInstance(id: string, pageId: string): void })
      .simulateInstance('new-bridge-id-after-restart', 'new-page-id');
  });

  // Allow time for the fetch to fire.
  await page.waitForTimeout(500);

  // A re-registration post with inMR=true must have been made.
  const rePost = mrPosts.find(b => typeof b === 'object' && b !== null && (b as Record<string, unknown>).inMR === true);
  expect(rePost, `page must re-post /api/mr {inMR:true} on bridge restart; posts: ${JSON.stringify(mrPosts)}`).toBeTruthy();
});
