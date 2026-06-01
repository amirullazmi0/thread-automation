FROM mcr.microsoft.com/playwright:v1.52.0-noble AS deps

WORKDIR /app
COPY package.json yarn.lock ./
COPY prisma ./prisma
RUN yarn install --frozen-lockfile
RUN npx prisma generate

FROM deps AS build

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM mcr.microsoft.com/playwright:v1.52.0-noble AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV THREADS_HEADLESS=true
ENV THREADS_MANUAL_LOGIN=false
ENV THREADS_SESSION_PATH=/app/data/threads-session.json

COPY package.json yarn.lock ./
COPY prisma ./prisma
RUN yarn install --frozen-lockfile --production
RUN npx prisma generate

COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data

EXPOSE 3002
CMD ["node", "dist/main.js"]
