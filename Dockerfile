FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3002
ENV THREADS_HEADLESS=true
ENV THREADS_MANUAL_LOGIN=false
ENV THREADS_SESSION_PATH=/app/data/threads-session.json

COPY package.json yarn.lock ./
COPY prisma ./prisma

RUN yarn install --frozen-lockfile
RUN npx prisma generate

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN yarn build
RUN mkdir -p /app/data

EXPOSE 3002
CMD ["sh", "-c", "npx prisma db push && yarn start:prod"]
