import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';

const TARGET_URL =
  process.env.TARGET_URL ||
  'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/';

const NTFY_SERVER =
  (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const STATE_FILE = 'state.json';
const MAX_POSTCODE = 3000;


/* ---------- helpers ---------- */

function clean(text = '') {
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

function money(value = '') {
  return value
    .replace(/\s*(kr\.?|kroner)\s*$/i, ' DKK')
    .replace(/^(\d{1,3})\.(\d{3})(?!\d)/, '$1,$2')
    .trim();
}

function propertyType(text = '') {
  const t = text.toLowerCase();

  if (t.includes('etagebolig')) return 'Apartment';
  if (t.includes('rækkehus') || t.includes('raekkehus')) return 'Townhouse';
  if (t.includes('ungdomsbolig')) return 'Youth housing';
  if (t.includes('ældrebolig')) return 'Senior housing';
  if (t.includes('familiebolig')) return 'Family housing';

  return text;
}


/* ---------- parse one listing ---------- */

function parseListing(text, url = TARGET_URL) {
  const lines = clean(text)
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

  const rentIndex = lines.findIndex(x =>
    /^(Husleje|Rent)\s*:/i.test(x)
  );

  if (rentIndex === -1) return null;

  let postcodeIndex = -1;

  for (
    let i = rentIndex - 1;
    i >= Math.max(0, rentIndex - 5);
    i--
  ) {
    if (/^\d{4}\s+.+/.test(lines[i])) {
      postcodeIndex = i;
      break;
    }
  }

  if (postcodeIndex === -1) return null;

  const postcodeMatch =
    lines[postcodeIndex].match(/^(\d{4})\s+(.+)$/);

  if (!postcodeMatch) return null;

  const postcode = Number(postcodeMatch[1]);
  const city = postcodeMatch[2].trim();

  // Ignore homes outside the requested area.
  if (postcode > MAX_POSTCODE) return null;

  const address =
    lines[postcodeIndex - 1] || 'Unknown address';

  const rentLine =
    lines.find(x => /^(Husleje|Rent)\s*:/i.test(x)) || '';

  const depositLine =
    lines.find(x =>
      /^(Indskud|Depositum|Deposit)\s*:/i.test(x)
    ) || '';

  const periodLine =
    lines.find(x =>
      /^(Udlejningsperiode|Lejeperiode|Rental period)\s*:/i.test(x)
    ) || '';

  const detailsLine =
    lines.find(x =>
      /\d+\s*rums?|rooms?|kvm|m²|m2/i.test(x)
    ) || '';

  const rent = money(
    rentLine.replace(/^(Husleje|Rent)\s*:\s*/i, '')
  );

  const deposit = money(
    depositLine.replace(
      /^(Indskud|Depositum|Deposit)\s*:\s*/i,
      ''
    )
  );

  const period = periodLine.replace(
    /^(Udlejningsperiode|Lejeperiode|Rental period)\s*:\s*/i,
    ''
  );

  const roomsMatch =
    detailsLine.match(/(\d+)\s*(?:rums?|rooms?)/i);

  const areaMatch =
    detailsLine.match(/(\d+(?:[.,]\d+)?)\s*(?:kvm|m²|m2)/i);

  const type =
    detailsLine.includes(',')
      ? propertyType(detailsLine.split(',')[0].trim())
      : '';

  const listing = {
    id: `${address}|${postcode}|${city}`.toLowerCase(),
    address,
    postcode,
    city,
    rent,
    deposit,
    type,
    rooms: roomsMatch?.[1] || '',
    area: areaMatch
      ? `${areaMatch[1].replace(',', '.')} m²`
      : '',
    period,
    url
  };

  listing.signature = hash(
    JSON.stringify({
      address: listing.address,
      postcode: listing.postcode,
      city: listing.city,
      rent: listing.rent,
      deposit: listing.deposit,
      type: listing.type,
      rooms: listing.rooms,
      area: listing.area,
      period: listing.period
    })
  );

  return listing;
}


/* ---------- state ---------- */

function loadState() {
  try {
    const state =
      JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    return state.version === 5 &&
      state.listings &&
      typeof state.listings === 'object'
      ? state.listings
      : null;
  } catch {
    return null;
  }
}

function saveState(listings) {
  const map = {};

  for (const item of listings) {
    map[item.id] = item;
  }

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      version: 5,
      updated_at: new Date().toISOString(),
      postcode_limit: MAX_POSTCODE,
      listings: map
    }, null, 2) + '\n'
  );
}


/* ---------- ntfy ---------- */

function notificationText(home) {
  const lines = [
    home.address,
    `${home.postcode} ${home.city}`
  ];

  if (home.rent)
    lines.push(`Rent: ${home.rent}`);

  if (home.deposit)
    lines.push(`Deposit: ${home.deposit}`);

  const details = [];

  if (home.type)
    details.push(home.type);

  if (home.rooms)
    details.push(
      `${home.rooms} ${home.rooms === '1' ? 'room' : 'rooms'}`
    );

  if (home.area)
    details.push(home.area);

  if (details.length)
    lines.push(details.join(' • '));

  if (home.period)
    lines.push(`Rental period: ${home.period}`);

  lines.push('');
  lines.push(
    home.url !== TARGET_URL
      ? 'Tap to open this exact home.'
      : 'Tap to open DAB.'
  );

  return lines.join('\n');
}

async function notify(title, home, tags) {
  if (!NTFY_TOPIC) {
    throw new Error('NTFY_TOPIC is missing.');
  }

  const response = await fetch(NTFY_SERVER, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      topic: NTFY_TOPIC,
      title,
      message: notificationText(home),
      priority: 5,
      tags,
      click: home.url || TARGET_URL
    })
  });

  if (!response.ok) {
    throw new Error(
      `ntfy error ${response.status}: ${await response.text()}`
    );
  }
}


/* ---------- extract DAB cards + links ---------- */

async function extractCards(page) {
  return await page.evaluate(() => {
    const tidy = text =>
      (text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();

    const roots = [document];
    const anchors = [];
    const visited = new Set();

    // Search normal DOM + open shadow DOM.
    while (roots.length) {
      const root = roots.pop();

      if (!root || visited.has(root))
        continue;

      visited.add(root);

      try {
        anchors.push(...root.querySelectorAll('a[href]'));

        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot)
            roots.push(el.shadowRoot);
        }
      } catch {}
    }

    const results = [];

    for (const anchor of anchors) {
      let node = anchor;

      for (let depth = 0; node && depth < 15; depth++) {
        const text = tidy(
          node.innerText || node.textContent || ''
        );

        const looksLikeHome =
          /(?:Husleje|Rent)\s*:/i.test(text) &&
          /(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i.test(text) &&
          /(?:^|\n)\d{4}\s+\S+/m.test(text);

        if (
          looksLikeHome &&
          text.length > 40 &&
          text.length < 3000
        ) {
          let url = '';

          try {
            url = new URL(
              anchor.getAttribute('href'),
              location.href
            ).href;
          } catch {}

          results.push({
            text,
            url
          });

          break;
        }

        node =
          node.parentElement ||
          node.getRootNode()?.host ||
          null;
      }
    }

    return results;
  });
}


/* ---------- fallback parser ---------- */

function parsePageText(text) {
  const lines = clean(text)
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

  const homes = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^(Husleje|Rent)\s*:/i.test(lines[i]))
      continue;

    let end = -1;

    for (
      let j = i + 1;
      j <= Math.min(i + 10, lines.length - 1);
      j++
    ) {
      if (
        /^(Udlejningsperiode|Lejeperiode|Rental period)\s*:/i
          .test(lines[j])
      ) {
        end = j;
        break;
      }
    }

    if (end === -1)
      continue;

    const block = lines
      .slice(Math.max(0, i - 4), end + 1)
      .join('\n');

    const home =
      parseListing(block, TARGET_URL);

    if (home)
      homes.push(home);
  }

  return homes;
}


/* ---------- get current listings ---------- */

async function getListings(page) {
  console.log('Opening DAB...');

  await page.goto(TARGET_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  let renderedText = '';

  // Wait up to 30 seconds for JavaScript housing data.
  for (let i = 1; i <= 30; i++) {
    renderedText = await page
      .locator('main')
      .innerText()
      .catch(() => '');

    if (
      /(?:Husleje|Rent)\s*:/i.test(renderedText) &&
      /(?:Udlejningsperiode|Rental period)\s*:/i
        .test(renderedText)
    ) {
      console.log(`Housing loaded after ${i}s.`);
      break;
    }

    await page.waitForTimeout(1000);
  }

  const cards =
    await extractCards(page);

  const homes = [];

  for (const card of cards) {
    const home =
      parseListing(card.text, card.url || TARGET_URL);

    if (home)
      homes.push(home);
  }

  // If card/link extraction fails, still monitor via text.
  if (!homes.length) {
    console.log('Using text fallback.');
    homes.push(...parsePageText(renderedText));
  }

  // Deduplicate by address.
  const map = new Map();

  for (const home of homes) {
    const old = map.get(home.id);

    // Prefer version containing an exact property URL.
    if (
      !old ||
      (
        old.url === TARGET_URL &&
        home.url !== TARGET_URL
      )
    ) {
      map.set(home.id, home);
    }
  }

  const result = [...map.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'da'));

  if (!result.length) {
    throw new Error(
      'No DAB homes with postcode 0000-3000 were detected.'
    );
  }

  console.log(
    `Tracking ${result.length} homes with postcode ≤ ${MAX_POSTCODE}.`
  );

  for (const home of result) {
    console.log(
      `${home.address}, ${home.postcode} ${home.city}`
    );

    if (home.url !== TARGET_URL)
      console.log(`Exact link: ${home.url}`);
  }

  return result;
}


/* ---------- compare ---------- */

async function compare(currentHomes) {
  const previous = loadState();

  // First run with this compact version:
  // create baseline without sending dozens of NEW alerts.
  if (!previous) {
    saveState(currentHomes);

    console.log(
      `Baseline created with ${currentHomes.length} homes.`
    );

    return;
  }

  let newCount = 0;
  let updatedCount = 0;

  for (const home of currentHomes) {
    const old = previous[home.id];

    if (!old) {
      newCount++;

      await notify(
        '🏠 NEW DAB HOME',
        home,
        ['house', 'new']
      );

      continue;
    }

    if (old.signature !== home.signature) {
      updatedCount++;

      await notify(
        '🔄 DAB HOME UPDATED',
        home,
        ['house', 'arrows_counterclockwise']
      );
    }
  }

  // Removed homes are deliberately ignored.
  saveState(currentHomes);

  console.log(`New homes: ${newCount}`);
  console.log(`Updated homes: ${updatedCount}`);

  if (!newCount && !updatedCount)
    console.log('No relevant changes.');
}


/* ---------- main ---------- */

async function main() {
  if (!fs.existsSync(CHROME_PATH))
    throw new Error(`Chrome not found: ${CHROME_PATH}`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    locale: 'da-DK',
    viewport: {
      width: 1280,
      height: 1200
    }
  });

  // We only need text and links.
  await context.route('**/*', async route => {
    const type = route.request().resourceType();

    if (['image', 'font', 'media'].includes(type))
      return route.abort();

    return route.continue();
  });

  const page = await context.newPage();

  try {
    const homes =
      await getListings(page);

    await compare(homes);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('\nMONITOR ERROR:\n');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
