# ─── Stage 1: Builder ─────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run db:generate
RUN npm --prefix admin ci
RUN npm --prefix admin run build
RUN npm run build

# ─── Stage 2: Production runner ───────────────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache vips dumb-init

WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && \
    adduser  -S nodejs -u 1001

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/admin/dist ./admin/dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

RUN mkdir -p uploads/images uploads/videos uploads/audio && \
    chown -R nodejs:nodejs uploads

USER nodejs

EXPOSE 3000

VOLUME ["/app/uploads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
