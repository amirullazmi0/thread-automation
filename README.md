<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

Threads automation service that scans Indonesian news topics, resolves the
original article URL, generates a caption, downloads the article image when
available, and posts it to Threads.

## Project setup

```bash
$ yarn install
```

## Compile and run the project

```bash
# development
$ yarn run start

# watch mode
$ yarn run start:dev

# production mode
$ yarn run start:prod
```

By default the app uses `PORT=3002` from `.env`.

## Environment

Copy `.env.example` to `.env`, then fill in the credentials and API keys.

```bash
PORT="3002"
MANUAL_TRIGGER_TOKEN="local-manual-token"
DATABASE_URL="postgresql://postgres:<password>@<host>:5432/db_thread_automation?schema=public&sslmode=disable"
THREADS_EMAIL=""
THREADS_PASSWORD=""
THREADS_LOGIN_PROVIDER="threads"
THREADS_INSTAGRAM_USERNAME=""
THREADS_INSTAGRAM_PASSWORD=""
THREADS_BROWSER_CHANNEL=""
THREADS_USER_DATA_DIR=""
THREADS_IMAGE_PATH=""
THREADS_MAX_CAPTION_CHARS="900"
THREADS_HEADLESS="true"
THREADS_MANUAL_LOGIN="false"
THREADS_AUTO_SCHEDULE="false"
THREADS_SCHEDULE_MAX_POSTS="1"
NEWS_SOURCE_URL=""
GOOGLE_NEWS_QUERIES="berita terkini Indonesia,politik Indonesia,ekonomi Indonesia,teknologi Indonesia,cuaca ekstrem Indonesia,gempa Indonesia,viral Indonesia"
GOOGLE_NEWS_MAX_ITEMS="20"
GOOGLE_NEWS_ALLOWED_SOURCES=""
GOOGLE_NEWS_EXCLUDED_TERMS=""
OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4.1-nano"
OPENAI_MAX_OUTPUT_TOKENS="220"
OPENAI_DAILY_CAPTION_LIMIT="30"
```

## Manual Threads Post

Start the app:

```bash
yarn start
```

Trigger one manual post:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3002/threads-bot/run-once?maxPosts=1" `
  -Headers @{ "x-manual-trigger-token" = "local-manual-token" }
```

The endpoint returns:

```json
{ "posted": 1 }
```

`maxPosts` defaults to `1` and accepts values from `1` to `10`. If
`MANUAL_TRIGGER_TOKEN` is empty, the manual endpoint does not require the
`x-manual-trigger-token` header.

If Threads asks for verification, run once with a visible browser:

```powershell
$env:THREADS_HEADLESS="false"
$env:THREADS_MANUAL_LOGIN="true"
yarn start
```

Complete the login in the opened browser using any supported Threads flow,
including Instagram or Meta/Facebook verification. The app saves the session to
`threads-session.json`, so later runs can use headless mode again.

If the Threads account signs in through Instagram, set:

```bash
THREADS_LOGIN_PROVIDER="instagram"
THREADS_INSTAGRAM_USERNAME="<instagram username/email>"
THREADS_INSTAGRAM_PASSWORD="<instagram password>"
```

If `THREADS_INSTAGRAM_USERNAME` or `THREADS_INSTAGRAM_PASSWORD` is empty, the
bot falls back to `THREADS_EMAIL` and `THREADS_PASSWORD`. Instagram often asks
for verification on new machines, so the first run is usually more reliable with
`THREADS_HEADLESS=false` and `THREADS_MANUAL_LOGIN=true`; after the session file
is saved, switch back to headless mode.

Set `THREADS_BROWSER_CHANNEL="msedge"` to use Microsoft Edge, or
`THREADS_BROWSER_CHANNEL="chrome"` to use an installed Google Chrome. Leave it
empty to use Playwright's bundled Chromium.

Set `THREADS_USER_DATA_DIR=".playwright/edge-profile"` to keep a persistent
browser profile for the bot. Login once in that bot-opened browser, and later
runs can reuse the same browser cookies.

Set `THREADS_IMAGE_PATH="assets/post.jpg"` to attach a local image to every
post. `THREADS_MAX_CAPTION_CHARS` defaults to `900`, which gives the caption
room to add context while still staying readable as one main post.

For Google News RSS items, the bot tries to resolve the original article URL,
adds the full URL as `Sumber: ...`, and downloads the article `og:image` or
`twitter:image` for upload to Threads. If the source blocks image download, the
post continues without an image.

## Automatic Schedule

The hourly schedule is disabled unless `THREADS_AUTO_SCHEDULE="true"`.
`THREADS_SCHEDULE_MAX_POSTS` limits how many posts one scheduled scan can
publish.

Use `GOOGLE_NEWS_ALLOWED_SOURCES` and `GOOGLE_NEWS_EXCLUDED_TERMS` to keep the
feed aligned with the account's positioning, for example national/Jakarta
coverage instead of regional outlets.

## Docker VPS Deployment

The Docker setup uses the official Playwright image, so Chromium and the Linux
browser dependencies are already available.

This project also supports the same CapRover flow as `solana-automation`:

```bash
yarn deploy:vps
```

`captain-definition` points CapRover to `./Dockerfile`. On startup, the
container runs `npx prisma db push` and then `yarn start:prod`.

Required CapRover app env vars:

```text
DATABASE_URL=postgresql://...
PORT=3002
MANUAL_TRIGGER_TOKEN=...
THREADS_HEADLESS=true
THREADS_MANUAL_LOGIN=false
THREADS_SESSION_PATH=/app/data/threads-session.json
THREADS_LOGIN_PROVIDER=instagram
THREADS_INSTAGRAM_USERNAME=...
THREADS_INSTAGRAM_PASSWORD=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-nano
OPENAI_MAX_OUTPUT_TOKENS=220
OPENAI_DAILY_CAPTION_LIMIT=30
```

Add the other news variables from `.env.example` as needed.

For the cheapest GPT captions, use:

```text
OPENAI_MODEL=gpt-4.1-nano
OPENAI_MAX_OUTPUT_TOKENS=220
OPENAI_DAILY_CAPTION_LIMIT=30
```

If the daily OpenAI limit is reached or the API fails, the bot automatically
uses the local fallback caption.

Build and run on the VPS:

```bash
docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f thread-automation
```

Trigger one manual post from the VPS:

```bash
curl -X POST \
  "http://localhost:3002/threads-bot/run-once?maxPosts=1" \
  -H "x-manual-trigger-token: local-manual-token"
```

For production, keep `THREADS_HEADLESS=true` and
`THREADS_MANUAL_LOGIN=false`.

### Threads Session

The compose file mounts:

```text
./data:/app/data
```

Generate `threads-session.json` once on a machine where you can complete the
Threads login in a visible browser, then place that file at
`data/threads-session.json` on the VPS. After that, the container can reuse the
saved session in headless mode.

If you need to do the first login directly on a VPS, use a remote desktop/X11
setup and run with:

```bash
THREADS_HEADLESS=false THREADS_MANUAL_LOGIN=true docker compose up
```

Headless servers without a visible browser session cannot complete Meta/Facebook
login challenges reliably.

### CapRover Persistent Data

Create a persistent directory or volume for `/app/data` in CapRover if you want
the saved Threads session to survive redeploys. Put `threads-session.json` there
as `/app/data/threads-session.json`.

## Run tests

```bash
# unit tests
$ yarn run test

# e2e tests
$ yarn run test:e2e

# test coverage
$ yarn run test:cov
```

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
