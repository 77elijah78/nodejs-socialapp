# 🚀 Social Backend

A production-ready Node.js social platform backend with REST API + real-time WebSocket chat.

## ✨ Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | v22 LTS |
| Language | TypeScript | 5.8 |
| Framework | Express | 5.1 |
| ORM | Prisma | 6.8 |
| Database | PostgreSQL | 16+ |
| WebSocket | Socket.io | 4.8 |
| Auth | JWT (jsonwebtoken) | 9.0 |
| Validation | Zod | 3.24 |
| Logging | Winston | 3.17 |
| Security | Helmet + CORS + Rate Limit | latest |

---

## 📁 Folder Structure

```
social-backend/
├── prisma/
│   ├── schema.prisma         # DB models: User, Post, Follow, Message, etc.
│   └── seed.ts               # Database seeder (alice + bob)
│
├── src/
│   ├── index.ts              # Bootstrap: HTTP server + WS + graceful shutdown
│   ├── app.ts                # Express app setup (middleware, routes)
│   │
│   ├── config/
│   │   ├── database.ts       # Prisma singleton (dev-safe hot reload)
│   │   └── logger.ts         # Winston logger with daily-rotate-file
│   │
│   ├── types/
│   │   └── index.ts          # AuthRequest interface, pagination helpers
│   │
│   ├── utils/
│   │   ├── errors.ts         # AppError hierarchy (NotFound, Forbidden, etc.)
│   │   ├── jwt.ts            # signAccessToken, signRefreshToken, verifyToken
│   │   └── response.ts       # sendSuccess, sendError, buildPaginationMeta
│   │
│   ├── middlewares/
│   │   ├── authenticate.ts   # JWT auth guard + optional auth
│   │   ├── validate.ts       # Zod schema validation wrapper
│   │   ├── schemas.ts        # All Zod schemas (register, post, message, etc.)
│   │   ├── errorHandler.ts   # Global error handler (Prisma + AppError aware)
│   │   └── notFound.ts       # 404 handler
│   │
│   ├── services/             # Business logic (pure functions, no Express deps)
│   │   ├── auth.service.ts   # register, login, refresh, logout
│   │   ├── user.service.ts   # profile, follow/unfollow, followers/following
│   │   ├── post.service.ts   # CRUD, feed, like/unlike, comments
│   │   └── message.service.ts# Conversations, messages (REST layer)
│   │
│   ├── controllers/          # HTTP handlers (req → service → response)
│   │   ├── auth.controller.ts
│   │   ├── user.controller.ts
│   │   ├── post.controller.ts
│   │   └── message.controller.ts
│   │
│   ├── routes/               # Express routers
│   │   ├── index.ts          # Mounts all routers under /api/v1
│   │   ├── auth.routes.ts
│   │   ├── user.routes.ts
│   │   ├── post.routes.ts
│   │   └── message.routes.ts
│   │
│   └── socket/               # WebSocket layer
│       ├── index.ts          # Socket.io init + JWT middleware + connection
│       ├── chat.handler.ts   # message:send, typing, read receipts
│       └── presence.handler.ts # online/offline tracking
│
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🔌 REST API Reference

### Auth `POST /api/v1/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | ❌ | Create account |
| POST | `/login` | ❌ | Login, get tokens |
| POST | `/refresh` | ❌ | Refresh access token |
| POST | `/logout` | ❌ | Invalidate refresh token |
| GET | `/me` | ✅ | Current user info |

### Users `GET /api/v1/users`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/:username` | Optional | Get user profile |
| PATCH | `/me` | ✅ | Update profile |
| POST | `/:username/follow` | ✅ | Follow a user |
| DELETE | `/:username/follow` | ✅ | Unfollow a user |
| GET | `/:username/followers` | ❌ | List followers |
| GET | `/:username/following` | ❌ | List following |

### Posts `GET /api/v1/posts`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/feed` | ✅ | Personalized feed |
| POST | `/` | ✅ | Create post |
| GET | `/:id` | Optional | Get single post |
| PATCH | `/:id` | ✅ | Update post (author only) |
| DELETE | `/:id` | ✅ | Soft-delete post |
| POST | `/:id/like` | ✅ | Like a post |
| DELETE | `/:id/like` | ✅ | Unlike a post |
| POST | `/:id/comments` | ✅ | Add a comment |

### Messages `GET /api/v1/messages`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/conversations` | ✅ | List user conversations |
| POST | `/conversations` | ✅ | Start DM conversation |
| DELETE | `/conversations/:id` | ✅ | Delete (archive) a conversation for the current user |
| GET | `/conversations/:id/messages` | ✅ | Get messages (paginated) |
| POST | `/conversations/:id/messages` | ✅ | Send a REST message |

---

## ⚡ WebSocket Events

Connect with: `io('http://localhost:3000', { auth: { token: '<JWT>' } })`

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `conversation:join` | `conversationId: string` | Join a chat room |
| `conversation:leave` | `conversationId: string` | Leave a chat room |
| `conversation:delete` | `{ conversationId: string }` | Archive conversation for the current user |
| `message:send` | `{ conversationId, content, receiverId? }` | Send real-time message |
| `message:typing` | `{ conversationId, isTyping }` | Typing indicator |
| `message:read` | `conversationId: string` | Mark messages read |
| `presence:list` | callback | Get online user IDs |
| `presence:ping` | — | Heartbeat |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | `Message` | New message in conversation |
| `message:notification` | `{ conversationId, message }` | New message to personal room |
| `message:typing` | `{ userId, username, isTyping, conversationId }` | Typing indicator |
| `message:read` | `{ conversationId, userId }` | Read receipt |
| `conversation:deleted` | `{ conversationId, userId, deletedAt }` | Conversation archived by a participant |
| `presence:online` | `{ userId, username }` | User came online |
| `presence:offline` | `{ userId, lastSeen }` | User went offline |
| `presence:pong` | — | Heartbeat response |

---

## 🚀 Getting Started

### 1. Clone & Install

```bash
git clone <your-repo>
cd social-backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your PostgreSQL credentials and JWT secret
```

### 3. Setup Database

```bash
# Create the DB (if not exists)
createdb social_db

# Run Prisma migrations
npm run db:migrate

# (Optional) Generate Prisma client
npm run db:generate

# Seed with test users
npm run db:seed
```

### 4. Run

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

Server starts at: **http://localhost:3000**

---

## 🔐 Auth Flow

```
POST /api/v1/auth/register  →  { accessToken, refreshToken, user }
POST /api/v1/auth/login     →  { accessToken, refreshToken, user }

# Use accessToken in header:
Authorization: Bearer <accessToken>

# When access token expires (15m), refresh:
POST /api/v1/auth/refresh   { refreshToken }  →  { accessToken }
```

---

## 📚 Example Requests

```bash
# Register
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"john","email":"john@example.com","password":"Password123!"}'

# Create a post
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello social world! 🌍"}'

# Get feed (paginated)
curl http://localhost:3000/api/v1/posts/feed?page=1&limit=20 \
  -H "Authorization: Bearer <token>"

# Follow a user
curl -X POST http://localhost:3000/api/v1/users/alice/follow \
  -H "Authorization: Bearer <token>"
```

---

## 🏗️ Production Checklist

- [ ] Set strong `JWT_SECRET` (32+ char random string)
- [ ] Use connection pooling for PostgreSQL (PgBouncer / Prisma Accelerate)
- [ ] Replace in-memory presence store with Redis
- [ ] Add file upload middleware (Multer + S3)
- [ ] Set up Socket.io Redis adapter for horizontal scaling
- [ ] Enable HTTPS / SSL termination
- [ ] Add API versioning strategy
- [ ] Configure rate limiting per endpoint
- [ ] Set up monitoring (Prometheus + Grafana or Datadog)

---

## 📈 Scaling Notes

- **Presence tracking**: Replace `Map` in `presence.handler.ts` with Redis `HSET`
- **WebSocket clusters**: Add `@socket.io/redis-adapter` with Redis pub/sub
- **Message queues**: Add BullMQ for notifications and async jobs
- **Media uploads**: Add Multer + AWS S3 or Cloudflare R2
