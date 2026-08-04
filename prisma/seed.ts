import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  const passwordHash = await bcrypt.hash('Password123!', 12);

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: { avatarUrl: 'https://i.pravatar.cc/150?u=alice' },
    create: {
      username: 'alice',
      email: 'alice@example.com',
      passwordHash,
      displayName: 'Alice Wonder',
      bio: 'Full-stack developer & coffee lover ☕',
      avatarUrl: 'https://i.pravatar.cc/150?u=alice',
    },
  });

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: { avatarUrl: 'https://i.pravatar.cc/150?u=bob' },
    create: {
      username: 'bob',
      email: 'bob@example.com',
      passwordHash,
      displayName: 'Bob Builder',
      bio: 'Building things one commit at a time 🔨',
      avatarUrl: 'https://i.pravatar.cc/150?u=bob',
    },
  });

  // Alice follows Bob
  await prisma.follow.upsert({
    where: { followerId_followingId: { followerId: alice.id, followingId: bob.id } },
    update: {},
    create: { followerId: alice.id, followingId: bob.id },
  });

  // Alice creates a post
  await prisma.post.create({
    data: {
      content: 'Hello world! First post 🚀',
      authorId: alice.id,
    },
  });

  console.log('✅ Seed complete!');
  console.log(`   Users: alice@example.com / Password123!`);
  console.log(`          bob@example.com   / Password123!`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
