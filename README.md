# DAB-Lejerbo housing monitor → ntfy

This project watches:

`https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/`

It opens the page in a real headless Chrome browser, waits for the JavaScript-rendered temporary housing listings, compares each listing with the previous state, and sends Android push notifications through **ntfy**.

It is designed for a **public GitHub repository**, where standard GitHub-hosted Actions are free. The ntfy topic is kept in a GitHub Actions secret and is not written into the repository.

## What it detects

- 🏠 New temporary housing listing
- 🔄 Existing listing changed (rent, deposit, rooms, area, rental period, etc.)
- ❌ Removed listing is supported but disabled by default
- First run saves a baseline instead of sending one alert for every existing property

## Why it uses a browser

The raw DAB-Lejerbo HTML does not contain the housing cards. The page has an empty `<bex-page-content>` element and JavaScript fills the content later. A normal `curl`/HTML checker can therefore miss the listings. This monitor uses the Chrome already installed on GitHub's Ubuntu runner and blocks images/fonts/media to reduce load.

## Setup (works from a phone)

1. Install **ntfy** on Android.
2. In ntfy, subscribe to a long random topic, for example `dab-a8K4pQ2m7Vx91tZ5`.
3. Create a **PUBLIC** GitHub repository. Public is important if you want to avoid private-repository Actions minute limits for this always-running monitor.
4. Upload all files from this project to the repository, including the `.github/workflows/monitor.yml` file.
5. In GitHub open **Settings → Secrets and variables → Actions → New repository secret**.
6. Name the secret exactly `NTFY_TOPIC`.
7. Put only your ntfy topic name in the value (for example `dab-a8K4pQ2m7Vx91tZ5`). Do not put it directly in the code.
8. Open the **Actions** tab → **DAB Housing Monitor** → **Run workflow** once manually.
9. The first successful run should send one notification saying that the baseline was saved.

After that, the scheduled workflow starts every five minutes. Inside each job it performs five checks roughly 60 seconds apart, giving approximately one-minute monitoring while the job is running.

## Important limitation

GitHub scheduled workflows are **not real-time guarantees**. GitHub can delay a scheduled job when their service is busy. Therefore this is approximately one-minute monitoring, not a guaranteed check at exactly every 60 seconds.

For a truly fixed 1-minute cron without GitHub scheduling delays, the better long-term version is a Cloudflare Worker that calls DAB's underlying housing-data API directly. To build that version we need the DAB XHR/fetch endpoint used by the page.

## Privacy

Keep `NTFY_TOPIC` as a GitHub secret. A public ntfy.sh topic can be subscribed to by anyone who guesses its name, so use a long random topic name.

## Removed-listing alerts

In `.github/workflows/monitor.yml`, change:

```yaml
NOTIFY_REMOVED: 'false'
```

to:

```yaml
NOTIFY_REMOVED: 'true'
```

if you also want notifications when a listing disappears.

## If DAB changes its page

The monitor intentionally refuses to replace the saved state when it cannot detect any housing cards. This prevents a temporary website error from looking like every apartment was removed. Check the GitHub Actions log if a run fails.
