import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';


/* =========================================================
   CONFIGURATION
========================================================= */

const TARGET_URL =
  process.env.TARGET_URL ||
  'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/';

const NTFY_SERVER =
  (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');

const NTFY_TOPIC =
  process.env.NTFY_TOPIC || '';

const STATE_FILE =
  process.env.STATE_FILE || 'state.json';

const CHROME_PATH =
  process.env.CHROME_PATH || '/usr/bin/google-chrome';

const MAX_POSTCODE = 3000;


/* =========================================================
   BASIC HELPERS
========================================================= */

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


function normalizeMoney(value = '') {
  if (!value) {
    return '';
  }

  let text = value
    .replace(/\s+/g, ' ')
    .trim();

  /*
    Danish:
    7.180 kr.
    becomes:
    7,180 DKK
  */

  text = text
    .replace(/\./g, ',')
    .replace(/\s*(?:kr\.?|kroner)\s*$/i, ' DKK')
    .trim();

  return text;
}


function translatePropertyType(value = '') {
  const lower = value.toLowerCase();

  if (lower.includes('etagebolig')) {
    return 'Apartment';
  }

  if (
    lower.includes('rækkehus') ||
    lower.includes('raekkehus')
  ) {
    return 'Townhouse';
  }

  if (
    lower.includes('parcelhus') ||
    lower.includes('enfamiliehus')
  ) {
    return 'House';
  }

  if (lower.includes('ungdomsbolig')) {
    return 'Youth housing';
  }

  if (lower.includes('ældrebolig')) {
    return 'Senior housing';
  }

  if (lower.includes('familiebolig')) {
    return 'Family housing';
  }

  /*
    Unknown type:
    keep original wording.
  */

  return value;
}


/* =========================================================
   PARSE ONE HOUSING LISTING
========================================================= */

function parseListing(text, url = '') {

  const lines =
    normalize(text)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);


  const rentIndex =
    lines.findIndex(line =>
      /^(?:Husleje|Rent)\s*:/i.test(line)
    );


  if (rentIndex === -1) {
    return null;
  }


  /*
    Find postcode/city before Rent.

    Example:
    Rødovre Parkvej 229 7. sal
    2610 Rødovre
    Husleje: ...
  */

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


  if (postcodeIndex === -1) {
    return null;
  }


  const postcodeMatch =
    lines[postcodeIndex].match(
      /^(\d{4})\s+(.+)$/
    );


  if (!postcodeMatch) {
    return null;
  }


  const postcode =
    Number(postcodeMatch[1]);

  const city =
    postcodeMatch[2].trim();


  /*
    Ignore everything above postcode 3000.
  */

  if (
    postcode < 0 ||
    postcode > MAX_POSTCODE
  ) {
    return null;
  }


  const address =
    postcodeIndex > 0
      ? lines[postcodeIndex - 1]
      : 'Unknown address';


  const rentLine =
    lines.find(line =>
      /^(?:Husleje|Rent)\s*:/i.test(line)
    ) || '';


  const depositLine =
    lines.find(line =>
      /^(?:Indskud|Depositum|Deposit)\s*:/i.test(line)
    ) || '';


  const periodLine =
    lines.find(line =>
      /^(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i.test(line)
    ) || '';


  const rent =
    normalizeMoney(
      rentLine
        .replace(
          /^(?:Husleje|Rent)\s*:\s*/i,
          ''
        )
    );


  const deposit =
    normalizeMoney(
      depositLine
        .replace(
          /^(?:Indskud|Depositum|Deposit)\s*:\s*/i,
          ''
        )
    );


  const period =
    periodLine
      .replace(
        /^(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:\s*/i,
        ''
      )
      .trim();


  /*
    Example:
    Etagebolig, 3 rums, 85 kvm
  */

  let detailsLine = '';

  for (const line of lines) {

    if (
      /(?:\d+\s*(?:rums?|rooms?))|(?:\d+(?:[.,]\d+)?\s*(?:kvm|m²|m2))/i
        .test(line)
    ) {
      detailsLine = line;
      break;
    }
  }


  let rooms = '';

  const roomsMatch =
    detailsLine.match(
      /(\d+)\s*(?:rums?|rooms?)/i
    );

  if (roomsMatch) {
    rooms = roomsMatch[1];
  }


  let area = '';

  const areaMatch =
    detailsLine.match(
      /(\d+(?:[.,]\d+)?)\s*(?:kvm|m²|m2)/i
    );

  if (areaMatch) {
    area =
      `${areaMatch[1].replace(',', '.')} m²`;
  }


  let propertyType = '';

  if (detailsLine.includes(',')) {
    propertyType =
      translatePropertyType(
        detailsLine.split(',')[0].trim()
      );
  }


  /*
    Address is used as stable identity.

    This means:
    - rent changing doesn't create a "new" home
    - deposit changing doesn't create a "new" home
    - rental period changing doesn't create a "new" home
  */

  const id =
    `${address}|${postcode}|${city}`
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();


  const listing = {
    id,
    address,
    postcode,
    city,
    rent,
    deposit,
    propertyType,
    rooms,
    area,
    period,
    url: url || TARGET_URL
  };


  /*
    URL is intentionally excluded from signature.

    If DAB changes its internal URL format,
    we don't want a false "property updated" alert.
  */

  listing.signature =
    sha256(
      JSON.stringify({
        address: listing.address,
        postcode: listing.postcode,
        city: listing.city,
        rent: listing.rent,
        deposit: listing.deposit,
        propertyType: listing.propertyType,
        rooms: listing.rooms,
        area: listing.area,
        period: listing.period
      })
    );


  return listing;
}


/* =========================================================
   STATE MANAGEMENT
========================================================= */

function loadRawState() {

  try {
    return JSON.parse(
      fs.readFileSync(
        STATE_FILE,
        'utf8'
      )
    );
  } catch {
    return {};
  }
}


function saveState(listings) {

  const map = {};

  for (const listing of listings) {
    map[listing.id] = listing;
  }


  const state = {
    version: 4,
    updated_at: new Date().toISOString(),
    postcode_limit: MAX_POSTCODE,
    count: listings.length,
    listings: map
  };


  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2) + '\n'
  );
}


/*
  Convert older state.json versions to the
  new address-based format.

  This is important because you already have
  a working baseline.

  We don't want all existing homes to suddenly
  appear as "NEW".
*/

function migrateOldState(rawState) {

  const result = {};


  /*
    Already version 4.
  */

  if (
    rawState.version === 4 &&
    rawState.listings &&
    !Array.isArray(rawState.listings)
  ) {

    for (
      const [id, listing]
      of Object.entries(rawState.listings)
    ) {

      if (
        Number(listing.postcode) <= MAX_POSTCODE
      ) {
        result[id] = listing;
      }
    }


    return result;
  }


  /*
    Previous version:
    listings = array of text strings.
  */

  if (
    Array.isArray(rawState.listings)
  ) {

    for (const oldText of rawState.listings) {

      if (typeof oldText !== 'string') {
        continue;
      }


      const parsed =
        parseListing(
          oldText,
          TARGET_URL
        );


      if (parsed) {
        result[parsed.id] = parsed;
      }
    }


    return result;
  }


  /*
    Even older version:
    one big snapshot string.
  */

  if (
    typeof rawState.snapshot === 'string'
  ) {

    const oldListings =
      extractListingsFromPlainText(
        rawState.snapshot
      );


    for (const listing of oldListings) {
      result[listing.id] = listing;
    }
  }


  return result;
}


/* =========================================================
   FALLBACK TEXT PARSER
========================================================= */

function extractListingsFromPlainText(text) {

  const lines =
    normalize(text)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);


  const results = [];


  for (let i = 0; i < lines.length; i++) {

    if (
      !/^(?:Husleje|Rent)\s*:/i.test(lines[i])
    ) {
      continue;
    }


    let periodIndex = -1;

    for (
      let j = i + 1;
      j <= Math.min(i + 10, lines.length - 1);
      j++
    ) {

      if (
        /^(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i
          .test(lines[j])
      ) {

        periodIndex = j;
        break;
      }
    }


    if (periodIndex === -1) {
      continue;
    }


    /*
      Include enough lines before rent
      for address + postcode.
    */

    const start =
      Math.max(0, i - 4);


    const block =
      lines
        .slice(
          start,
          periodIndex + 1
        )
        .join('\n');


    const parsed =
      parseListing(
        block,
        TARGET_URL
      );


    if (parsed) {
      results.push(parsed);
    }
  }


  return deduplicateListings(results);
}


/* =========================================================
   DEDUPLICATION
========================================================= */

function deduplicateListings(listings) {

  const map = new Map();


  for (const listing of listings) {

    const existing =
      map.get(listing.id);


    if (!existing) {
      map.set(
        listing.id,
        listing
      );

      continue;
    }


    /*
      Prefer the listing that has
      a specific property URL.
    */

    const existingSpecific =
      existing.url &&
      existing.url !== TARGET_URL;


    const newSpecific =
      listing.url &&
      listing.url !== TARGET_URL;


    if (
      newSpecific &&
      !existingSpecific
    ) {
      map.set(
        listing.id,
        listing
      );
    }
  }


  return [...map.values()]
    .sort((a, b) =>
      a.id.localeCompare(
        b.id,
        'da'
      )
    );
}


/* =========================================================
   FIND PROPERTY CARDS + EXACT LINKS
========================================================= */

async function extractListingsWithLinks(page) {

  /*
    This JavaScript runs inside the DAB page.

    DAB uses Web Components, so some content
    can be inside Shadow DOM.

    We recursively search both:
    - normal document
    - open Shadow DOM
  */

  const candidates =
    await page.evaluate(() => {

      function clean(text = '') {
        return text
          .replace(/\u00a0/g, ' ')
          .replace(/\r/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }


      function getParent(node) {

        if (node.parentElement) {
          return node.parentElement;
        }


        const root =
          node.getRootNode?.();


        if (
          root &&
          root.host
        ) {
          return root.host;
        }


        return null;
      }


      /*
        Collect all links from document
        and all open shadow roots.
      */

      const roots =
        [document];


      const anchors =
        [];


      const visitedRoots =
        new Set();


      while (roots.length > 0) {

        const root =
          roots.pop();


        if (
          !root ||
          visitedRoots.has(root)
        ) {
          continue;
        }


        visitedRoots.add(root);


        try {

          for (
            const anchor
            of root.querySelectorAll('a[href]')
          ) {
            anchors.push(anchor);
          }


          for (
            const element
            of root.querySelectorAll('*')
          ) {

            if (element.shadowRoot) {
              roots.push(
                element.shadowRoot
              );
            }
          }

        } catch {
          // Ignore inaccessible roots.
        }
      }


      const results =
        [];


      for (const anchor of anchors) {

        let node =
          anchor;


        /*
          Walk upward until we find the
          smallest element that looks like
          one complete housing card.
        */

        for (
          let depth = 0;
          node && depth < 18;
          depth++
        ) {

          const text =
            clean(
              node.innerText ||
              node.textContent ||
              ''
            );


          const hasRent =
            /(?:^|\n)\s*(?:Husleje|Rent)\s*:/i
              .test(text);


          const hasPeriod =
            /(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i
              .test(text);


          const hasPostcode =
            /(?:^|\n)\d{4}\s+\S+/m
              .test(text);


          /*
            Avoid accidentally selecting
            the entire webpage.
          */

          if (
            hasRent &&
            hasPeriod &&
            hasPostcode &&
            text.length >= 40 &&
            text.length <= 3000
          ) {

            let href = '';

            try {
              href =
                new URL(
                  anchor.getAttribute('href'),
                  location.href
                ).href;
            } catch {
              href =
                anchor.href || '';
            }


            if (
              href &&
              !href.startsWith('javascript:')
            ) {

              results.push({
                text,
                url: href
              });
            }


            break;
          }


          node =
            getParent(node);
        }
      }


      return results;
    });


  const parsed = [];


  for (const candidate of candidates) {

    const listing =
      parseListing(
        candidate.text,
        candidate.url
      );


    if (listing) {
      parsed.push(listing);
    }
  }


  return deduplicateListings(parsed);
}


/* =========================================================
   GET CURRENT DAB LISTINGS
========================================================= */

async function getCurrentListings(page) {

  console.log(
    'Opening DAB temporary housing page...'
  );


  await page.goto(
    TARGET_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    }
  );


  /*
    DAB loads listings using JavaScript.

    Wait up to 30 seconds.
  */

  let renderedText = '';


  for (
    let attempt = 1;
    attempt <= 30;
    attempt++
  ) {

    renderedText =
      await page
        .locator('main')
        .innerText()
        .catch(() => '');


    const hasRent =
      /(?:Husleje|Rent)\s*:/i
        .test(renderedText);


    const hasPeriod =
      /(?:Udlejningsperiode|Lejeperiode|Rental period)\s*:/i
        .test(renderedText);


    if (
      hasRent &&
      hasPeriod
    ) {

      console.log(
        `DAB housing data loaded after ${attempt} second(s).`
      );

      break;
    }


    await page.waitForTimeout(1000);
  }


  /*
    First try DOM-based extraction because
    this gives us the exact property links.
  */

  let listings =
    await extractListingsWithLinks(page);


  console.log(
    `Listings found with property links: ${listings.length}`
  );


  /*
    If DOM extraction fails,
    fall back to rendered text.

    Notifications will still work,
    but those particular listings may
    open the general DAB page.
  */

  if (listings.length === 0) {

    console.log(
      'Exact-link extraction failed. Trying text fallback...'
    );


    listings =
      extractListingsFromPlainText(
        renderedText
      );
  }


  /*
    Safety:
    never save an empty list.
  */

  if (listings.length === 0) {

    console.log(
      '\n--- DAB DEBUG OUTPUT ---\n'
    );

    console.log(
      renderedText.slice(
        0,
        8000
      )
    );

    console.log(
      '\n--- END DEBUG ---\n'
    );


    throw new Error(
      'No eligible DAB housing listings were detected. State was NOT changed.'
    );
  }


  console.log(
    `Tracking ${listings.length} home(s) with postcode 0000-${MAX_POSTCODE}.`
  );


  for (const listing of listings) {

    console.log(
      `- ${listing.address}, ${listing.postcode} ${listing.city}`
    );

    if (
      listing.url &&
      listing.url !== TARGET_URL
    ) {

      console.log(
        `  Exact link: ${listing.url}`
      );
    }
  }


  return listings;
}


/* =========================================================
   ENGLISH NOTIFICATION TEXT
========================================================= */

function buildNotificationMessage(listing) {

  const lines = [
    `${listing.address}`,
    `${listing.postcode} ${listing.city}`
  ];


  if (listing.rent) {
    lines.push(
      `Rent: ${listing.rent}`
    );
  }


  if (listing.deposit) {
    lines.push(
      `Deposit: ${listing.deposit}`
    );
  }


  const propertyDetails = [];


  if (listing.propertyType) {
    propertyDetails.push(
      listing.propertyType
    );
  }


  if (listing.rooms) {

    propertyDetails.push(
      `${listing.rooms} ${
        listing.rooms === '1'
          ? 'room'
          : 'rooms'
      }`
    );
  }


  if (listing.area) {
    propertyDetails.push(
      listing.area
    );
  }


  if (propertyDetails.length) {

    lines.push(
      propertyDetails.join(' • ')
    );
  }


  if (listing.period) {

    lines.push(
      `Rental period: ${listing.period}`
    );
  }


  if (
    listing.url &&
    listing.url !== TARGET_URL
  ) {

    lines.push('');
    lines.push(
      'Tap this notification to open this exact home.'
    );

  } else {

    lines.push('');
    lines.push(
      'Tap to open the DAB temporary housing page.'
    );
  }


  return lines.join('\n');
}


/* =========================================================
   SEND NTFY
========================================================= */

async function sendNtfy(
  title,
  message,
  clickUrl,
  tags
) {

  if (!NTFY_TOPIC) {

    console.log(
      'NTFY_TOPIC is missing.'
    );

    return;
  }


  const response =
    await fetch(
      NTFY_SERVER,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body: JSON.stringify({
          topic: NTFY_TOPIC,
          title,
          message,
          priority: 5,
          tags,
          click:
            clickUrl ||
            TARGET_URL
        })
      }
    );


  if (!response.ok) {

    throw new Error(
      `ntfy returned HTTP ${response.status}: ${await response.text()}`
    );
  }
}


/* =========================================================
   COMPARE CURRENT VS PREVIOUS
========================================================= */

async function compareAndNotify(
  currentListings
) {

  const rawPrevious =
    loadRawState();


  const previous =
    migrateOldState(
      rawPrevious
    );


  const current = {};


  for (const listing of currentListings) {
    current[listing.id] = listing;
  }


  const previousIds =
    Object.keys(previous);


  /*
    Completely fresh installation.
  */

  if (previousIds.length === 0) {

    saveState(
      currentListings
    );


    await sendNtfy(
      '✅ DAB Housing Monitor Ready',

      `Monitoring ${currentListings.length} current home(s) with postcode 0000-${MAX_POSTCODE}.\n\nYou will be notified when a new home appears or an existing home changes.`,

      TARGET_URL,

      [
        'white_check_mark',
        'house'
      ]
    );


    console.log(
      'New baseline created.'
    );


    return;
  }


  const newHomes =
    [];


  const updatedHomes =
    [];


  for (
    const listing
    of currentListings
  ) {

    const old =
      previous[
        listing.id
      ];


    /*
      NEW PROPERTY
    */

    if (!old) {

      newHomes.push(
        listing
      );

      continue;
    }


    /*
      UPDATED PROPERTY
    */

    if (
      old.signature &&
      old.signature !== listing.signature
    ) {

      updatedHomes.push(
        listing
      );

      continue;
    }


    /*
      Older migrated state may not
      contain a signature.

      Calculate it from the old values.
    */

    if (!old.signature) {

      const oldSignature =
        sha256(
          JSON.stringify({
            address: old.address || '',
            postcode: old.postcode || '',
            city: old.city || '',
            rent: old.rent || '',
            deposit: old.deposit || '',
            propertyType: old.propertyType || '',
            rooms: old.rooms || '',
            area: old.area || '',
            period: old.period || ''
          })
        );


      if (
        oldSignature !==
        listing.signature
      ) {

        updatedHomes.push(
          listing
        );
      }
    }
  }


  console.log(
    `New homes: ${newHomes.length}`
  );


  console.log(
    `Updated homes: ${updatedHomes.length}`
  );


  /*
    NEW HOME NOTIFICATIONS
  */

  for (
    const listing
    of newHomes
  ) {

    await sendNtfy(
      '🏠 NEW DAB HOME',

      buildNotificationMessage(
        listing
      ),

      listing.url,

      [
        'house',
        'new'
      ]
    );


    console.log(
      `NEW: ${listing.address}`
    );
  }


  /*
    UPDATED HOME NOTIFICATIONS
  */

  for (
    const listing
    of updatedHomes
  ) {

    await sendNtfy(
      '🔄 DAB HOME UPDATED',

      buildNotificationMessage(
        listing
      ),

      listing.url,

      [
        'house',
        'arrows_counterclockwise'
      ]
    );


    console.log(
      `UPDATED: ${listing.address}`
    );
  }


  /*
    Removed homes are intentionally ignored.

    We still save the latest state,
    so if a removed home later comes back,
    it will correctly count as NEW.
  */

  saveState(
    currentListings
  );


  if (
    newHomes.length === 0 &&
    updatedHomes.length === 0
  ) {

    console.log(
      'No relevant housing changes.'
    );
  }
}


/* =========================================================
   MAIN
========================================================= */

async function main() {

  if (
    !fs.existsSync(
      CHROME_PATH
    )
  ) {

    throw new Error(
      `Chrome not found at ${CHROME_PATH}`
    );
  }


  console.log(
    `Watching DAB postcodes 0000-${MAX_POSTCODE}.`
  );


  const browser =
    await chromium.launch({

      executablePath:
        CHROME_PATH,

      headless: true,

      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });


  const context =
    await browser.newContext({

      /*
        Danish page gives us predictable
        Husleje / Indskud / Udlejningsperiode
        labels.

        Notifications are translated to English.
      */

      locale: 'da-DK',

      viewport: {
        width: 1280,
        height: 1200
      },

      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    });


  /*
    Images, videos and fonts are unnecessary.
  */

  await context.route(
    '**/*',

    async route => {

      const type =
        route
          .request()
          .resourceType();


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

    const listings =
      await getCurrentListings(
        page
      );


    await compareAndNotify(
      listings
    );

  } finally {

    await browser.close();
  }
}


/* =========================================================
   START
========================================================= */

main().catch(error => {

  console.error(
    '\nMONITOR ERROR:\n'
  );


  console.error(
    error?.stack ||
    error
  );


  process.exitCode = 1;
});
