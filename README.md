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

Threads automation service that scans Indonesian news topics, generates a
caption, and posts it to Threads.

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
THREADS_HEADLESS="true"
THREADS_MANUAL_LOGIN="false"
NEWS_SOURCE_URL=""
GOOGLE_NEWS_QUERIES="berita terkini Indonesia,politik Indonesia,ekonomi Indonesia,teknologi Indonesia,cuaca ekstrem Indonesia,gempa Indonesia,viral Indonesia"
GOOGLE_NEWS_MAX_ITEMS="20"
GEMINI_API_KEY=""
GEMINI_MODEL="gemini-2.0-flash"
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

## Automatic Schedule

The bot also runs automatically every hour through `@nestjs/schedule`.

## Docker VPS Deployment

The Docker setup uses the official Playwright image, so Chromium and the Linux
browser dependencies are already available.

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

## Run tests

```bash
# unit tests
$ yarn run test

# e2e tests
$ yarn run test:e2e

# test coverage
$ yarn run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ yarn install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

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
