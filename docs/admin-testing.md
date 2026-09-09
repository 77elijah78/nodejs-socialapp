# Testing Instructions

## 1. Install dependencies
```bash
npm install
npm --prefix admin install
```

## 2. Apply Prisma migrations
```bash
npx prisma migrate dev
npx prisma generate
```

## 3. Seed data
```bash
npm run db:seed
```

Seeded admin credentials for local development:
- `admin@example.com`
- `Password123!`

## 4. Build
```bash
npm run build
npm run admin:build
```

## 5. Run services
Use the existing Docker Compose stack or local infrastructure for PostgreSQL, Redis, and Kafka, then run:
```bash
npm run dev
```

Open:
- API: `http://localhost:3000/api/v1`
- Admin: `http://localhost:3000/admin`

## 6. Validate core admin flows
- Login with seeded super admin
- Verify `/admin/auth/me` returns an admin session
- Review dashboard metrics
- Search/filter users
- Suspend/unsuspend/ban/unban a user
- Open a user detail page and verify tabs load
- Remove/restore a post, comment, and story
- Access a conversation with a reason and confirm an audit log is created
- Resolve a report and confirm audit entries are visible
- Update a platform setting
- Export audit logs
- Review analytics and system monitoring pages
