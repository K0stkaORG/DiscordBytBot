FROM oven/bun:1.1.33

WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --production

COPY . .

ENV NODE_ENV=production

CMD ["bun", "app.js"]
