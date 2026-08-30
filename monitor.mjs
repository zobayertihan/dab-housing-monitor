import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';

const TARGET_URL =
  process.env.TARGET_URL ||
  'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/';

const NTFY_SERVER =
  (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const STATE_FILE = 'state.json';

const CHECKS_PER_RUN =
  Math.max(1, Number(process.env.CHECKS_PER_RUN || 5));

const INTERVAL_SECONDS =
  Math.max(30, Number(process.env.INTERVAL_SECONDS || 60));

const CHROME_PATH =
  process.env.CHROME_PATH || '/usr/bin/google-chrome';


/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */

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


function hash(value) {
  return crypto
    .createHash('sha256')
    .update(value)
    .digest('hex');
}


/* -------------------------------------------------------
   State
------------------------------------------------------- */

function loadState() {
  try {
    return JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );
  } catch {
    return {};
  }
}


function saveState(listings) {
  const snapshot = JSON.stringify(listings);

  const state = {
    version: 3,
    updated_at: new Date().toISOString(),
    count: listings.length,
    hash: hash(snapshot),
    listings: listings
  };

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2) + '\n'
  );
}


/* -------------------------------------------------------
   ntfy
------------------------------------------------------- */

async function sendNtfy(title, message, tags = ['house']) {

  if (!NTFY_TOPIC) {
    console.log('NTFY_TOPIC is missing.');
    console.log(title);
    console.log(message);
    return;
  }

  const response = await fetch(NTFY_SERVER, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json'
    },

    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title: title,
      message: message,
      priority: 4,
      tags: tags,
      click: TARGET_URL
    })
  });

  if (!response.ok) {
    throw new Error(
      `ntfy error ${response.status}: ${await response.text()}`
    );
  }
}


/*
   ntfy messages have a size limit.

   If there are many apartments,
   divide the current list into several notifications.
*/

async function sendListingNotifications(title, listings, tags) {

  const MAX_LENGTH = 2800;

  const formatted = listings.map(
    (listing, index) =>
      `${index + 1}. ${listing}`
  );

  const chunks = [];

  let current =
    `Current listings: ${listings.length}\n\n`;

  for (const listing of formatted) {

    const candidate =
      current + listing + '\n\n';

    if (
      candidate.length > MAX_LENGTH &&
      current.trim()
    ) {
      chunks.push(current.trim());
      current = listing + '\n\n';
    } else {
      current = candidate;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }


  for (let i = 0; i < chunks.length; i++) {

    const suffix =
      chunks.length > 1
        ? ` (${i + 1}/${chunks.length})`
        : '';

    await sendNtfy(
      title + suffix,
      chunks[i],
      tags
    );
  }
}


/* -------------------------------------------------------
   DAB listing parser
------------------------------------------------------- */

/*
   DAB currently uses Danish:

   Husleje:
   Indskud:
   Udlejningsperiode:

   But English alternatives are included too
   in case DAB changes language.
*/

const RENT =
  /^(?:Husleje|Rent)\s*:/i;

const DEPOSIT =
  /^(?:Indskud|Depositum|Deposit)\s*:/i;

const PERIOD =
  /^(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i;


/*
   Example from the actual DAB page:

   Rødovre Parkvej 229 7. sal
   2610 Rødovre
   Husleje: 7.180 kr.
   Indskud: 23.304 kr.
   Etagebolig, 3 rums, 85 kvm
   Udlejningsperiode: 15-09-2026 - 15-03-2027

   We use "Husleje:" as the anchor.

   The two lines immediately before it are normally:
   address
   postcode/city

   Then we collect everything until
   Udlejningsperiode.
*/

function extractListings(pageText) {

  const lines =
    normalize(pageText)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);


  const listings = [];


  for (let i = 0; i < lines.length; i++) {

    if (!RENT.test(lines[i])) {
      continue;
    }


    /*
       Find rental period after this rent line.
       Usually it is within 3-5 lines.
    */

    let periodIndex = -1;

    for (
      let j = i + 1;
      j <= Math.min(i + 8, lines.length - 1);
      j++
    ) {

      if (PERIOD.test(lines[j])) {
        periodIndex = j;
        break;
      }
    }


    /*
       If there's no rental period,
       don't consider this a valid housing listing.
    */

    if (periodIndex === -1) {
      continue;
    }


    /*
       Address + postcode/city.
    */

    const start =
      Math.max(0, i - 2);


    const listingLines =
      lines.slice(
        start,
        periodIndex + 1
      );


    /*
       Require a rent and either deposit or period.
    */

    const joined =
      listingLines.join('\n');


    if (!RENT.test(listingLines.find(x => RENT.test(x)) || '')) {
      continue;
    }


    if (
      !listingLines.some(x => DEPOSIT.test(x)) &&
      !listingLines.some(x => PERIOD.test(x))
    ) {
      continue;
    }


    listings.push(joined);
  }


  /*
     Remove duplicate listings.
  */

  const unique =
    [...new Set(listings)];


  /*
     Sort them so a simple change in website order
     does NOT trigger a notification.
  */

  unique.sort((a, b) =>
    a.localeCompare(b, 'da')
  );


  return unique;
}


/* -------------------------------------------------------
   Load DAB
------------------------------------------------------- */

async function getCurrentListings(page) {

  console.log('Opening DAB...');

  await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });


  /*
     DAB inserts housing data with JavaScript.

     Check once every second for up to 30 seconds.
  */

  let pageText = '';

  for (let attempt = 1; attempt <= 30; attempt++) {

    pageText =
      await page
        .locator('main')
        .innerText()
        .catch(() => '');


    if (
      /(?:Husleje|Rent)\s*:/i.test(pageText) &&
      /(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i.test(pageText)
    ) {
      console.log(
        `Housing data appeared after ${attempt} second(s).`
      );

      break;
    }


    await page.waitForTimeout(1000);
  }


  if (!pageText) {
    pageText =
      await page
        .locator('body')
        .innerText()
        .catch(() => '');
  }


  const listings =
    extractListings(pageText);


  console.log(
    `Detected ${listings.length} housing listing(s).`
  );


  /*
     Safety:
     Never overwrite state with zero listings.

     If DAB temporarily fails to load,
     we don't want dozens of false notifications.
  */

  if (listings.length === 0) {

    console.log('\n--- DEBUG PAGE TEXT ---\n');

    console.log(
      pageText.slice(0, 8000)
    );

    console.log('\n--- END DEBUG ---\n');


    throw new Error(
      'No DAB housing listings detected. State was NOT changed.'
    );
  }


  return listings;
}


/* -------------------------------------------------------
   Compare
------------------------------------------------------- */

async function compareListings(currentListings) {

  const previous =
    loadState();


  const currentHash =
    hash(
      JSON.stringify(currentListings)
    );


  /*
     FIRST SUCCESSFUL RUN

     Send all current housing listings.
  */

  if (
    previous.version !== 3 ||
    !previous.hash ||
    !Array.isArray(previous.listings)
  ) {

    saveState(currentListings);


    await sendListingNotifications(
      `🏠 DAB CURRENT LISTINGS`,
      currentListings,
      [
        'house',
        'white_check_mark'
      ]
    );


    console.log(
      `Baseline created with ${currentListings.length} listings.`
    );

    console.log(
      'Current listings sent to ntfy.'
    );


    return;
  }


  /*
     NO CHANGE
  */

  if (previous.hash === currentHash) {

    console.log(
      `No changes. Still ${currentListings.length} listings.`
    );

    return;
  }


  /*
     SOMETHING CHANGED

     Could be:
     - new apartment
     - removed apartment
     - rent changed
     - deposit changed
     - dates changed
     - rooms/size changed

     User requested the COMPLETE CURRENT LIST
     whenever something changes.
  */

  const oldCount =
    previous.listings.length;

  const newCount =
    currentListings.length;


  console.log(
    `Housing changed: ${oldCount} → ${newCount} listings.`
  );


  saveState(currentListings);


  await sendListingNotifications(
    `🔄 DAB LISTINGS UPDATED`,
    currentListings,
    [
      'house',
      'arrows_counterclockwise'
    ]
  );


  console.log(
    'Updated complete housing list sent to ntfy.'
  );
}


/* -------------------------------------------------------
   Main
------------------------------------------------------- */

async function main() {

  if (!fs.existsSync(CHROME_PATH)) {

    throw new Error(
      `Chrome not found: ${CHROME_PATH}`
    );
  }


  const browser =
    await chromium.launch({

      executablePath: CHROME_PATH,

      headless: true,

      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });


  const context =
    await browser.newContext({

      locale: 'da-DK',

      viewport: {
        width: 1280,
        height: 1200
      },

      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    });


  /*
     We don't need images/videos/fonts.
     This makes each check faster and cheaper.
  */

  await context.route(
    '**/*',

    async route => {

      const type =
        route.request().resourceType();


      if (
        [
          'image',
          'font',
          'media'
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
      let check = 1;
      check <= CHECKS_PER_RUN;
      check++
    ) {

      const started =
        Date.now();


      console.log(
        `\n==============================`
      );

      console.log(
        `Check ${check}/${CHECKS_PER_RUN}`
      );

      console.log(
        new Date().toISOString()
      );

      console.log(
        `==============================`
      );


      const listings =
        await getCurrentListings(page);


      await compareListings(
        listings
      );


      /*
         Wait until approximately the next minute.
      */

      if (check < CHECKS_PER_RUN) {

        const elapsed =
          Date.now() - started;


        const wait =
          Math.max(
            1000,
            INTERVAL_SECONDS * 1000 - elapsed
          );


        console.log(
          `Waiting ${Math.round(wait / 1000)} seconds...`
        );


        await sleep(wait);
      }
    }

  } finally {

    await browser.close();
  }
}


/* -------------------------------------------------------
   Start
------------------------------------------------------- */

main().catch(error => {

  console.error(
    '\nMONITOR ERROR:\n'
  );

  console.error(
    error?.stack || error
  );

  process.exitCode = 1;
});
