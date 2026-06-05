# Thread Automation

Automation service for the `turtle.ids` Threads account. The bot scans
fresh entertainment and viral news, resolves the original publisher URL,
generates an engagement-oriented caption with OpenAI, attaches the article
image when available, and posts it to Threads through Playwright.

The current positioning is gossip, entertainment, celebrity drama, and viral
timeline topics. Captions are designed to invite comments with debate, hot-take,
dilemma, or relatable-question angles.

## Features

- Google News RSS scanning by category.
- Optional custom JSON/RSS news source.
- Freshness filter to avoid stale topics.
- Publisher URL resolution from Google News wrapper links.
- Article image extraction from Open Graph and Twitter metadata.
- OpenAI caption generation with local fallback.
- Duplicate/update detection with Prisma.
- Manual trigger endpoint with optional token auth.
- Background manual runs and scheduled posting.
- Threads login/session reuse with Playwright.
- Docker and CapRover deployment support.

## Stack

- NestJS
- Prisma
- PostgreSQL
- Playwright
- OpenAI Responses API
- Google News RSS
- Docker

## Setup

Install dependencies:

```bash
yarn install
```

Create `.env`:

```bash
cp .env.example .env
```

Generate Prisma client:

```bash
npx prisma generate
```

Run database migration/sync for local development:

```bash
npx prisma db push
```

Start the app:

```bash
yarn start
```

By default the app listens on `PORT=3002`.

## Environment

Core app variables:

```text
PORT=3002
DATABASE_URL=postgresql://...
MANUAL_TRIGGER_TOKEN=
```

Threads login:

```text
THREADS_EMAIL=
THREADS_PASSWORD=
THREADS_LOGIN_PROVIDER=threads
THREADS_INSTAGRAM_USERNAME=
THREADS_INSTAGRAM_PASSWORD=
THREADS_HEADLESS=true
THREADS_MANUAL_LOGIN=false
THREADS_BROWSER_CHANNEL=
THREADS_USER_DATA_DIR=
THREADS_SESSION_PATH=
```

Posting behavior:

```text
THREADS_AUTO_SCHEDULE=false
THREADS_SCHEDULE_MAX_POSTS=1
THREADS_SCAN_CANDIDATES_PER_CATEGORY=3
THREADS_CATEGORY_ROTATION=OTHER,INTERNATIONAL,COMEDY,ROMANCE,EVENT
THREADS_MAX_CAPTION_CHARS=900
THREADS_IMAGE_PATH=
```

News source:

```text
NEWS_SOURCE_URL=
GOOGLE_NEWS_MAX_ITEMS=20
GOOGLE_NEWS_ALLOWED_SOURCES=
GOOGLE_NEWS_EXCLUDED_TERMS=
THREADS_MAX_NEWS_AGE_DAYS=2
```

Google News category queries:

```text
GOOGLE_NEWS_QUERIES=gosip artis Indonesia terbaru,celebrity gossip terbaru,berita selebriti viral Indonesia,drama seleb internasional
GOOGLE_NEWS_NATIONAL_QUERIES=gosip artis Indonesia terbaru
GOOGLE_NEWS_INTERNATIONAL_QUERIES=celebrity gossip terbaru dunia,Hollywood celebrity gossip terbaru,K-pop idol scandal news,drama selebriti internasional terbaru
GOOGLE_NEWS_SPORT_QUERIES=gosip atlet selebriti olahraga viral
GOOGLE_NEWS_EVENT_QUERIES=gosip konser festival artis Indonesia terbaru
GOOGLE_NEWS_ZODIAC_QUERIES=zodiak selebriti ramalan bintang viral
GOOGLE_NEWS_ROMANCE_QUERIES=gosip artis pacaran nikah cerai putus terbaru
GOOGLE_NEWS_COMEDY_QUERIES=drama seleb viral lucu hiburan Indonesia
GOOGLE_NEWS_OTHER_QUERIES=gosip artis viral Indonesia terbaru,celebrity gossip viral
```

OpenAI:

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-nano
OPENAI_MAX_OUTPUT_TOKENS=220
OPENAI_DAILY_CAPTION_LIMIT=30
OPENAI_TIMEOUT_MS=20000
```

## Freshness Rules

The bot should not post stale entertainment topics. By default,
`THREADS_MAX_NEWS_AGE_DAYS=2`, so news older than two days is skipped.

Google News searches also get a `when:2d` freshness operator automatically
unless the query already contains a `when:` operator.

For custom JSON/RSS sources, include a publish date. Items without a usable
date are skipped when the max-age filter is enabled.

Supported date fields:

- Google News RSS: `pubDate`
- RSS/Atom feeds: `pubDate`, `published`, `updated`, `dc:date`, `isoDate`
- Custom JSON: `publishedAt`
- Publisher HTML metadata: `article:published_time`, `og:published_time`,
  `pubdate`, `publishdate`, `timestamp`, `datePublished`

Set `THREADS_MAX_NEWS_AGE_DAYS=0` only if you want to disable this filter.

## Caption Strategy

Captions are generated in Indonesian with a gossip/viral tone. The AI prompt
uses one of these engagement modes:

- `debate`: makes readers choose a side.
- `hot_take`: gives a safe but sharper opinion.
- `dilemma`: presents two reasonable sides.
- `relatable_question`: connects the topic to reader experience.

The bot still enforces safety rules:

- Do not invent facts outside the source title and description.
- Do not defame, accuse, or judge people.
- Do not include URLs inside the AI-generated body.
- End the main caption with a question that invites comments.
- Keep the final output within the Threads caption limit.

If OpenAI is unavailable, over the daily limit, or times out, the bot uses a
local fallback caption and still adds a comment-oriented question.

## Manual Posting

Start the app:

```bash
yarn start
```

Trigger one post and wait for completion:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3002/threads-bot/run-once?maxPosts=1&wait=true" `
  -Headers @{ "x-manual-trigger-token" = "local-manual-token" }
```

Response:

```json
{ "posted": 1 }
```

Trigger in the background:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3002/threads-bot/run-once?maxPosts=1" `
  -Headers @{ "x-manual-trigger-token" = "local-manual-token" }
```

Response:

```json
{ "started": true, "maxPosts": 1 }
```

`maxPosts` accepts values from `1` to `10`. If `MANUAL_TRIGGER_TOKEN` is empty,
the endpoint does not require the `x-manual-trigger-token` header.

## Scheduling

The scheduler runs every 2 hours, but it only posts when:

```text
THREADS_AUTO_SCHEDULE=true
```

`THREADS_SCHEDULE_MAX_POSTS` controls how many posts a scheduled scan can
publish. The category rotation starts from the category after the last
successful post, so the feed does not get stuck on one topic type.

Default category rotation:

```text
OTHER,INTERNATIONAL,COMEDY,ROMANCE,EVENT
```

## Threads Login

For the first login, visible browser mode is usually more reliable:

```powershell
$env:THREADS_HEADLESS="false"
$env:THREADS_MANUAL_LOGIN="true"
yarn start
```

Complete the login in the opened browser. The app stores the session so later
runs can use headless mode.

Use direct Threads login:

```text
THREADS_LOGIN_PROVIDER=threads
THREADS_EMAIL=...
THREADS_PASSWORD=...
```

Use Instagram login:

```text
THREADS_LOGIN_PROVIDER=instagram
THREADS_INSTAGRAM_USERNAME=...
THREADS_INSTAGRAM_PASSWORD=...
```

If Instagram credentials are empty, the bot falls back to `THREADS_EMAIL` and
`THREADS_PASSWORD`.

Browser options:

```text
THREADS_BROWSER_CHANNEL=msedge
THREADS_USER_DATA_DIR=.playwright/edge-profile
THREADS_SESSION_PATH=data/threads-session.json
```

## Images

For Google News RSS items, the bot resolves the original publisher URL and
tries to download the article image from `og:image` or `twitter:image`.

If image download fails, the post continues without an attachment.

To attach the same local image to every post:

```text
THREADS_IMAGE_PATH=assets/post.jpg
```

## Custom News Source

Set `NEWS_SOURCE_URL` to use your own JSON or RSS feed instead of Google News.

JSON array example:

```json
[
  {
    "title": "Contoh headline viral",
    "description": "Ringkasan singkat sumber berita.",
    "sourceUrl": "https://example.com/article",
    "imageUrl": "https://example.com/image.jpg",
    "category": "OTHER",
    "publishedAt": "2026-06-02T08:00:00.000Z"
  }
]
```

Valid categories:

```text
NATIONAL, INTERNATIONAL, SPORT, EVENT, ZODIAC, ROMANCE, COMEDY, OTHER
```

## Docker

Build and run:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f thread-automation
```

The Docker setup uses the official Playwright image, so Chromium and required
Linux browser dependencies are already available.

## CapRover

Deploy:

```bash
yarn deploy:vps
```

The deploy script targets the CapRover app `turtle-threads`.
`captain-definition` points to `./Dockerfile`. On startup, the container runs:

```bash
npx prisma db push && yarn start:prod
```

Recommended production env:

```text
DATABASE_URL=postgresql://...
PORT=3002
MANUAL_TRIGGER_TOKEN=...
THREADS_HEADLESS=true
THREADS_MANUAL_LOGIN=false
THREADS_SESSION_PATH=/app/data/threads-session.json
THREADS_BROWSER_CHANNEL=
THREADS_LOGIN_PROVIDER=instagram
THREADS_INSTAGRAM_USERNAME=...
THREADS_INSTAGRAM_PASSWORD=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-nano
OPENAI_MAX_OUTPUT_TOKENS=220
OPENAI_DAILY_CAPTION_LIMIT=30
THREADS_MAX_NEWS_AGE_DAYS=2
```

For VPS/CapRover, keep `THREADS_HEADLESS=true`, `THREADS_MANUAL_LOGIN=false`,
and leave `THREADS_BROWSER_CHANNEL` empty. Do not use `msedge` on the VPS unless
Edge is explicitly installed in the container. The Docker image already includes
Playwright Chromium and its Linux dependencies, so no GUI is required.

Create a persistent directory or volume for `/app/data` if you want the saved
Threads session to survive redeploys. Put `threads-session.json` there as:

```text
/app/data/threads-session.json
```

## Testing

Run all unit tests:

```bash
yarn test
```

Run TypeScript checks:

```bash
yarn tsc --noEmit
```

Run e2e tests:

```bash
yarn test:e2e
```

## Notes

- Keep `THREADS_MAX_NEWS_AGE_DAYS=2` for viral/gossip content so posts do not
  feel stale.
- Use `GOOGLE_NEWS_EXCLUDED_TERMS` to block topics that do not fit the account.
- Use `GOOGLE_NEWS_ALLOWED_SOURCES` if you want to restrict the bot to trusted
  publishers only.
- Auto-reply is intentionally not implemented yet. The current focus is better
  post quality, fresher sources, and safer caption prompts.
