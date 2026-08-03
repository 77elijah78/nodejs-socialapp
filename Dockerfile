# ─── Stage 1: Builder ─────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npm run db:generate
RUN npm run build

# ─── Stage 2: Production runner ───────────────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache vips

WORKDIR /app

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist              ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

# Upload directory — will be overridden by volume mount in prod
RUN mkdir -p uploads/images uploads/videos uploads/audio && \
    chown -R nodejs:nodejs uploads

USER nodejs

EXPOSE 3000

# uploads is mounted as a volume so files persist across deploys
VOLUME ["/app/uploads"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
