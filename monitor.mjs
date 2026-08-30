import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';

const TARGET_URL =
  process.env.TARGET_URL ||
  'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/';

const NTFY_SERVER =
  (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const STATE_FILE = process.env.STATE_FILE || 'state.json';

const CHECKS_PER_RUN =
  Math.max(1, Number(process.env.CHECKS_PER_RUN || 5));

const INTERVAL_SECONDS =
  Math.max(30, Number(process.env.INTERVAL_SECONDS || 60));

const CHROME_PATH =
  process.env.CHROME_PATH || '/usr/bin/google-chrome';


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function normalize(text = '') {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function sha256(text) {
  return crypto
    .createHash('sha256')
    .update(text)
    .digest('hex');
}


function loadState() {
  try {
    return JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );
  } catch {
    return {};
  }
}


function saveState(snapshot) {
  const state = {
    version: 2,
    updated_at: new Date().toISOString(),
    hash: sha256(snapshot),
    snapshot,
  };

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2) + '\n'
  );
}


async function sendNtfy(title, message, tags = ['house']) {
  if (!NTFY_TOPIC) {
    console.log(`[ntfy disabled] ${title}`);
    console.log(message);
    return;
  }

  const response = await fetch(NTFY_SERVER, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
    },

    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message,
      priority: 4,
      tags,
      click: TARGET_URL,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `ntfy HTTP ${response.status}: ${await response.text()}`
    );
  }
}


async function sendSnapshot(title, snapshot, tags) {
  const MAX_CHARS = 2800;

  const lines = snapshot.split('\n');

  const chunks = [];
  let current = '';

  for (const line of lines) {
    const candidate =
      current
        ? `${current}\n${line}`
        : line;

    if (
      candidate.length > MAX_CHARS &&
      current
    ) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  for (let i = 0; i < chunks.length; i++) {
    const suffix =
      chunks.length > 1
        ? ` (${i + 1}/${chunks.length})`
        : '';

    await sendNtfy(
      `${title}${suffix}`,
      chunks[i],
      tags
    );
  }
}


function cleanSnapshot(text) {
  const lines = normalize(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const ignored = new Set([
    'Log in',
    'Login',
    'Menu',
    'Search',
    'Søg',
    'Soeg',
  ]);

  return lines
    .filter(line => !ignored.has(line))
    .join('\n');
}


async function getHousingSnapshot(page) {
  await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  console.log(
    'Waiting for DAB housing data...'
  );

  await page.waitForTimeout(10000);

  let text =
    await page
      .locator('main')
      .innerText({
        timeout: 10000,
      })
      .catch(() => '');


  if (!text) {
    text =
      await page
        .locator('body')
        .innerText({
          timeout: 10000,
        })
        .catch(() => '');
  }


  let snapshot =
    cleanSnapshot(text);


  const hasRent =
    /(?:Rent|Husleje)\s*:/i
      .test(snapshot);

  const hasDeposit =
    /(?:Deposit|Depositum)\s*:/i
      .test(snapshot);

  const hasPeriod =
    /(?:Rental period|Lejeperiode)\s*:/i
      .test(snapshot);


  if (
    !hasRent ||
    (!hasDeposit && !hasPeriod)
  ) {
    console.log(
      '\nRendered page text:\n'
    );

    console.log(
      snapshot.slice(0, 7000)
    );

    throw new Error(
      'DAB housing listings were not found. State was NOT changed.'
    );
  }


  /*
   * Remove most of the static text above
   * the actual housing listings.
   *
   * Keep a few lines before the first Rent/Husleje
   * so the first apartment address is not lost.
   */

  const marker =
    snapshot.search(
      /(?:Rent|Husleje)\s*:/i
    );


  if (marker > 0) {
    const before =
      snapshot.slice(0, marker);

    const lines =
      before.split('\n');

    const keepFrom =
      Math.max(
        0,
        lines.length - 4
      );

    snapshot =
      [
        ...lines.slice(keepFrom),
        snapshot.slice(marker),
      ].join('\n');
  }


  return normalize(snapshot);
}


async function compareAndNotify(snapshot) {
  const previous =
    loadState();

  const currentHash =
    sha256(snapshot);


  /*
   * FIRST SUCCESSFUL RUN
   *
   * Save current housing list and
   * send the whole list to your phone.
   */

  if (
    !previous.version ||
    !previous.hash ||
    !previous.snapshot
  ) {
    saveState(snapshot);

    await sendSnapshot(
      '🏠 DAB CURRENT LISTINGS',
      snapshot,
      [
        'house',
        'white_check_mark',
      ]
    );

    console.log(
      'Current listings saved and sent to ntfy.'
    );

    return;
  }


  /*
   * NOTHING CHANGED
   */

  if (
    previous.hash === currentHash
  ) {
    console.log(
      'No housing changes detected.'
    );

    return;
  }


  /*
   * SOMETHING CHANGED
   *
   * Save new version and send
   * the COMPLETE current housing list.
   */

  saveState(snapshot);

  await sendSnapshot(
    '🔄 DAB LISTINGS UPDATED',
    snapshot,
    [
      'house',
      'arrows_counterclockwise',
    ]
  );

  console.log(
    'Housing list changed. Updated list sent to ntfy.'
  );
}


async function main() {
  if (
    !fs.existsSync(CHROME_PATH)
  ) {
    throw new Error(
      `Chrome not found at ${CHROME_PATH}`
    );
  }


  const browser =
    await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,

      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });


  const context =
    await browser.newContext({
      locale: 'en-GB',

      viewport: {
        width: 1280,
        height: 1200,
      },

      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    });


  /*
   * Images/fonts/videos are unnecessary.
   */

  await context.route(
    '**/*',

    async route => {
      const type =
        route.request()
          .resourceType();

      if (
        [
          'image',
          'font',
          'media',
        ].includes(type)
      ) {
        return route.abort();
      }

      return route.continue();
    }
  );


  const page =
    await context.newPage();


  try {
    for (
      let i = 0;
      i < CHECKS_PER_RUN;
      i++
    ) {

      const started =
        Date.now();


      console.log(
        `\nCheck ${i + 1}/${CHECKS_PER_RUN}`
      );


      const snapshot =
        await getHousingSnapshot(page);


      console.log(
        `Captured ${snapshot.length} characters of housing information.`
      );


      await compareAndNotify(
        snapshot
      );


      if (
        i <
        CHECKS_PER_RUN - 1
      ) {

        const elapsed =
          Date.now() -
          started;


        const wait =
          Math.max(
            1000,
            INTERVAL_SECONDS *
              1000 -
              elapsed
          );


        await sleep(wait);
      }
    }

  } finally {
    await browser.close();
  }
}


main().catch(error => {
  console.error(
    '\nMONITOR ERROR:',
    error?.stack || error
  );

  process.exitCode = 1;
});
