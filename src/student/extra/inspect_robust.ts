import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'likithkarnekota@gmail.com' },
  });
  if (!user) {
    console.log('User not found');
    return;
  }
  const progress = await prisma.courseProgress.findMany({
    where: {
      studentId: user.id,
      courseId: '0476cdb3-b014-497d-9ec0-ec79606805ee',
    },
  });
  console.log('Progress records count:', progress.length);
  progress.forEach((p) => {
    console.log(
      `ID: ${p.id}, ChapterId: ${p.chapterId}, ContentId: ${p.contentId}, Progress: ${p.progress}, CompletedAt: ${p.completedAt}`,
    );
  });
}

main().finally(() => prisma.$disconnect());
