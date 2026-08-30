import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';

const TARGET_URL = process.env.TARGET_URL || 'https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/';
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const CHECKS_PER_RUN = Math.max(1, Number(process.env.CHECKS_PER_RUN || 5));
const INTERVAL_SECONDS = Math.max(30, Number(process.env.INTERVAL_SECONDS || 60));
const NOTIFY_REMOVED = /^(1|true|yes)$/i.test(process.env.NOTIFY_REMOVED || 'false');
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const FIELD_LABELS = [
  ['rent', ['husleje']],
  ['deposit', ['depositum']],
  ['type', ['boligtype']],
  ['rooms', ['værelser', 'vaerelser']],
  ['area', ['boligareal']],
  ['period', ['lejeperiode']],
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value = '') {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanUrl(url) {
  try {
    const u = new URL(url, TARGET_URL);
    u.hash = '';
    // Remove common tracking-only parameters but preserve parameters that may identify a listing.
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return url || '';
  }
}

function parseFields(text) {
  const lines = normalizeText(text).split('\n').map(s => s.trim()).filter(Boolean);
  const fields = {};
  const allLabels = FIELD_LABELS.flatMap(([, labels]) => labels);

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLocaleLowerCase('da-DK');
    for (const [key, labels] of FIELD_LABELS) {
      for (const label of labels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = lines[i].match(new RegExp(`^${escaped}\\s*[:\\-]?\\s*(.*)$`, 'i'));
        if (m) {
          let value = (m[1] || '').trim();
          if (!value && lines[i + 1]) {
            const nextLower = lines[i + 1].toLocaleLowerCase('da-DK');
            if (!allLabels.some(x => nextLower === x || nextLower.startsWith(x + ':'))) {
              value = lines[i + 1].trim();
            }
          }
          if (value) fields[key] = value;
        }
      }
    }
  }

  // Address is normally the first meaningful line containing a house number.
  const generic = /^(tidsbegr|bolig|husleje|depositum|boligtype|værelser|vaerelser|boligareal|lejeperiode|læs mere|laes mere)/i;
  const address = lines.find(line => /\d/.test(line) && !generic.test(line) && line.length < 140);
  if (address) fields.address = address;

  return fields;
}

function chooseStableId(card) {
  // A detail-link is the best ID because details can change while the listing itself remains the same.
  if (card.url) return `url:${cleanUrl(card.url)}`;
  if (card.fields.address) return `address:${card.fields.address.toLocaleLowerCase('da-DK')}`;
  // Last-resort fallback. This cannot distinguish an update from remove+add, but still detects change.
  return `text:${hash(card.text).slice(0, 24)}`;
}

function listingSignature(card) {
  return hash(JSON.stringify({ text: card.text, url: cleanUrl(card.url || '') }));
}

async function sendNtfy(title, message, clickUrl = TARGET_URL, tags = 'house') {
  if (!NTFY_TOPIC) {
    console.log(`[ntfy disabled] ${title}: ${message}`);
    return;
  }
  const endpoint = `${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': 'high',
      'Tags': tags,
      'Click': clickUrl || TARGET_URL,
    },
    body: message,
  });
  if (!response.ok) throw new Error(`ntfy returned HTTP ${response.status}: ${await response.text()}`);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(listings) {
  const payload = {
    version: 1,
    changed_at: new Date().toISOString(),
    target_url: TARGET_URL,
    listings,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2) + '\n');
}

function fieldDiff(oldItem, newItem) {
  const labels = {
    address: 'Address', rent: 'Rent', deposit: 'Deposit', type: 'Type',
    rooms: 'Rooms', area: 'Area', period: 'Rental period',
  };
  const out = [];
  for (const key of Object.keys(labels)) {
    const a = oldItem.fields?.[key] || '';
    const b = newItem.fields?.[key] || '';
    if (a !== b && (a || b)) out.push(`${labels[key]}: ${a || '—'} → ${b || '—'}`);
  }
  return out;
}

async function extractListings(page) {
  // Wait for JavaScript-rendered housing data. If the site changes, do not overwrite state with an empty result.
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(4_000);

  // Try to wait specifically for the DAB listing label, but don't fail immediately if it takes longer.
  try {
    await page.getByText('Husleje', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    // A second short wait helps with slow client-side rendering.
    await page.waitForTimeout(5_000);
  }

  let labels = await page.getByText('Husleje', { exact: true }).all();
  if (labels.length === 0) {
    // Some versions of the site may include extra whitespace or punctuation around the label.
    labels = await page.getByText(/Husleje/i).all();
  }

  const rawCards = [];
  for (const label of labels.slice(0, 200)) {
    try {
      const card = await label.evaluate((start) => {
        const names = ['husleje', 'depositum', 'boligtype', 'værelser', 'vaerelser', 'boligareal', 'lejeperiode'];
        const norm = s => (s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        const score = text => names.filter(x => text.toLocaleLowerCase('da-DK').includes(x)).length;

        function linksInside(root) {
          const found = [];
          const walk = (node) => {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'A' && node.href) found.push({ href: node.href, text: norm(node.innerText || node.textContent) });
              if (node.shadowRoot) walk(node.shadowRoot);
              for (const child of node.children || []) walk(child);
            } else if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
              for (const child of node.children || []) walk(child);
            }
          };
          walk(root);
          return found;
        }

        let el = start;
        let best = null;
        for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
          const text = norm(el.innerText || el.textContent || '');
          const hits = score(text);
          // First sufficiently complete ancestor is normally the individual listing card.
          if (hits >= 5 && text.length >= 40 && text.length <= 3500) {
            const links = linksInside(el);
            const preferred = links.find(a => /læs mere|laes mere|se billeder|bolig/i.test(a.text))
              || links.find(a => /dab-lejerbo\.dk/i.test(a.href))
              || links[0];
            best = { text, url: preferred?.href || '', depth, hits };
            break;
          }
        }
        return best;
      });
      if (card?.text) rawCards.push(card);
    } catch (error) {
      console.warn('Could not inspect one Husleje label:', error.message);
    }
  }

  // De-duplicate cards discovered from repeated label matches.
  const seen = new Set();
  const cards = [];
  for (const raw of rawCards) {
    const text = normalizeText(raw.text);
    const key = `${cleanUrl(raw.url || '')}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fields = parseFields(text);
    const item = { text, url: cleanUrl(raw.url || ''), fields };
    item.id = chooseStableId(item);
    item.signature = listingSignature(item);
    cards.push(item);
  }

  // If multiple candidates accidentally represent the same card, keep the shortest/most specific one.
  const byId = new Map();
  for (const item of cards) {
    const old = byId.get(item.id);
    if (!old || item.text.length < old.text.length) byId.set(item.id, item);
  }

  const listings = [...byId.values()];
  if (listings.length === 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await page.screenshot({ path: `debug-${stamp}.png`, fullPage: true });
      fs.writeFileSync(`debug-${stamp}.html`, await page.content());
    } catch {}
    throw new Error('No DAB housing cards were detected. State was NOT changed. Check the workflow log/debug output; the website structure may have changed.');
  }

  return listings;
}

function toMap(listings) {
  return Object.fromEntries(listings.map(x => [x.id, x]));
}

async function compareAndNotify(previous, current) {
  const oldMap = previous?.listings || {};
  const newMap = toMap(current);

  if (!previous?.version || !previous?.listings) {
    saveState(newMap);
    await sendNtfy(
      '✅ DAB housing monitor started',
      `Baseline saved with ${current.length} listing${current.length === 1 ? '' : 's'}. I will notify you about new or changed listings.`,
      TARGET_URL,
      'white_check_mark,house'
    );
    console.log(`Initialized baseline with ${current.length} listings.`);
    return true;
  }

  const newIds = Object.keys(newMap).filter(id => !oldMap[id]);
  const removedIds = Object.keys(oldMap).filter(id => !newMap[id]);
  const updatedIds = Object.keys(newMap).filter(id => oldMap[id] && oldMap[id].signature !== newMap[id].signature);

  for (const id of newIds) {
    const item = newMap[id];
    const f = item.fields || {};
    const message = [
      f.address || 'New temporary housing listing',
      f.rent && `Rent: ${f.rent}`,
      f.rooms && `Rooms: ${f.rooms}`,
      f.area && `Area: ${f.area}`,
      f.period && `Rental period: ${f.period}`,
    ].filter(Boolean).join('\n');
    await sendNtfy('🏠 NEW DAB HOME', message, item.url || TARGET_URL, 'house,new');
  }

  for (const id of updatedIds) {
    const before = oldMap[id];
    const after = newMap[id];
    const diffs = fieldDiff(before, after);
    const message = [
      after.fields?.address || before.fields?.address || 'DAB listing updated',
      ...(diffs.length ? diffs : ['Listing details changed. Tap to view the current listing.']),
    ].join('\n');
    await sendNtfy('🔄 DAB HOME UPDATED', message, after.url || TARGET_URL, 'arrows_counterclockwise,house');
  }

  if (NOTIFY_REMOVED) {
    for (const id of removedIds) {
      const item = oldMap[id];
      await sendNtfy(
        '❌ DAB HOME REMOVED',
        item.fields?.address || 'A previously listed temporary home is no longer shown.',
        TARGET_URL,
        'x,house'
      );
    }
  }

  if (newIds.length || updatedIds.length || removedIds.length) {
    saveState(newMap);
    console.log(`State changed: +${newIds.length} new, ~${updatedIds.length} updated, -${removedIds.length} removed.`);
    return true;
  }

  console.log(`No relevant changes (${current.length} listings).`);
  return false;
}

async function main() {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome not found at ${CHROME_PATH}. Set CHROME_PATH to the installed Chrome/Chromium executable.`);
  }

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const context = await browser.newContext({
    locale: 'da-DK',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 DABHousingMonitor/1.0',
    viewport: { width: 1280, height: 1000 },
  });

  // Reduce load on DAB: images, fonts and media are unnecessary for listing comparison.
  await context.route('**/*', async route => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  try {
    for (let i = 0; i < CHECKS_PER_RUN; i++) {
      const started = new Date();
      console.log(`\n[${started.toISOString()}] Check ${i + 1}/${CHECKS_PER_RUN}`);
      const listings = await extractListings(page);
      console.log(`Detected ${listings.length} listing(s).`);
      const previous = loadState();
      await compareAndNotify(previous, listings);

      if (i < CHECKS_PER_RUN - 1) {
        const elapsed = Date.now() - started.getTime();
        const wait = Math.max(1_000, INTERVAL_SECONDS * 1000 - elapsed);
        await sleep(wait);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(async error => {
  console.error('\nMONITOR ERROR:', error?.stack || error);
  process.exitCode = 1;
});
