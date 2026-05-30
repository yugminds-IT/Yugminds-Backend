import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const submission = await prisma.assignmentSubmission.findFirst({
    orderBy: { submittedAt: 'desc' },
    include: {
      assignment: {
        include: {
          questions: true,
        },
      },
    },
  });

  console.log('--- Latest Submission ---');
  console.log('ID:', submission?.id);
  console.log('Status:', submission?.status);
  console.log('Score:', submission?.score, '/', submission?.maxScore);
  console.log('Answers (JSON):', JSON.stringify(submission?.answers, null, 2));

  if (submission?.assignment.questions) {
    console.log('\n--- Questions ---');
    submission.assignment.questions.forEach((q) => {
      console.log(`Q: ${q.questionText}`);
      console.log(`Type: ${q.questionType}`);
      console.log(`Correct Answer: ${q.correctAnswer}`);
      console.log(`Options: ${JSON.stringify(q.options)}`);
    });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
