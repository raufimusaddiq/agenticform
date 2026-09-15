import { chromium } from 'playwright';

const base = process.env.JOURNEY_BASE_URL || 'http://127.0.0.1:18095';
const token = process.env.JOURNEY_ADMIN_TOKEN || 'journey-admin-token-0123456789abcdef';
const results = [];

function check(name, condition) {
  results.push({ name, pass: Boolean(condition) });
  if (!condition) throw new Error('journey step failed: ' + name);
}

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  check('login screen shows with token form', await page.getByText('Control plane access').isVisible());

  await page.locator('input[type=password]').fill('definitely-wrong-token-value');
  await page.getByRole('button', { name: /unlock control plane/i }).click();
  await page.getByText('Invalid admin token or control plane is unavailable.').waitFor({ timeout: 10000 });
  check('invalid token rejected with visible error', true);

  await page.locator('input[type=password]').fill(token);
  await page.getByRole('button', { name: /unlock control plane/i }).click();
  const connection = page.locator('.connection-status').first();
  await connection.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('.connection-status');
    return el && el.textContent.toLowerCase().includes('connected')
      && !el.textContent.toLowerCase().includes('reconnecting');
  }, { timeout: 20000 });
  const statusText = (await connection.innerText()).toLowerCase();
  check('login succeeds and connection status is visible', true);
  check('connection shows CONNECTED', statusText.includes('connected'));

  // Client-side routing: the Tasks view is reachable without a full page load.
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.waitForURL(/\/tasks$/, { timeout: 10000 });
  check('tasks view reachable by client routing',
        await page.getByRole('heading', { name: 'Tasks', level: 1 }).isVisible());

  // Keyboard: a modal opens and Escape closes it.
  await page.getByRole('button', { name: 'New task' }).last().click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  check('modal opens with dialog semantics', true);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10000 });
  check('Escape closes the modal', true);

  // Stale-state labeling: when the control plane becomes unreachable the UI must
  // not keep presenting cached data as current.
  await page.route('**/api/**', route => route.abort());
  await page.waitForFunction(() => {
    const el = document.querySelector('.connection-status');
    return el && !el.textContent.toLowerCase().includes('connected');
  }, { timeout: 20000 });
  const staleText = (await page.locator('.connection-status').first().innerText()).toLowerCase();
  check('unreachable control plane stops showing CONNECTED', !staleText.includes('connected'));
  check('stale state is explicitly labeled', staleText.includes('stale'));
  await page.unroute('**/api/**');

  // Expired session: clear credentials, the next API round-trip must return the
  // user to the login screen rather than showing stale data as current.
  await page.evaluate(() => sessionStorage.removeItem('agenticform.adminToken'));
  await page.reload({ waitUntil: 'networkidle' });
  check('expired session returns to login', await page.getByText('Control plane access').isVisible());

  console.log(JSON.stringify({ results, allPassed: results.every(r => r.pass) }));
} finally {
  await browser.close();
}
