import { gradeQuiz, LearningService, publicQuiz } from './learning.service';
import { lessonTypeFromLms } from './course-builder.service';

const quiz = [
  { question: '2+2?', options: ['3', '4'], answer: 1 },
  { question: 'Robot brain?', options: ['MCU', 'Wheel', 'Tyre'], answer: 0 },
];

describe('quiz', () => {
  it('learners never receive answers', () => {
    expect(JSON.stringify(publicQuiz(quiz))).not.toContain('answer');
    expect(publicQuiz(quiz)[1]).toEqual({
      question: 'Robot brain?',
      options: ['MCU', 'Wheel', 'Tyre'],
    });
  });

  it('grades server-side with a 60% pass mark', () => {
    expect(gradeQuiz(quiz, [1, 0])).toEqual({
      score: 100,
      passed: true,
      correct: [true, true],
    });
    expect(gradeQuiz(quiz, [1, 2])).toEqual({
      score: 50,
      passed: false,
      correct: [true, false],
    });
    expect(() => gradeQuiz([], [])).toThrow();
  });
});

describe('LearningService.afterProgress', () => {
  const build = (total: number, done: number, existing: unknown = null) => {
    const db = {
      academyLesson: { count: jest.fn().mockResolvedValue(total) },
      academyLessonProgress: { count: jest.fn().mockResolvedValue(done) },
      academyCertificate: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(data)),
      },
      academyAccount: {
        findUnique: jest.fn().mockResolvedValue({ fullName: 'Asha' }),
      },
      academyCourse: {
        findUnique: jest.fn().mockResolvedValue({ title: 'Robotics 101' }),
      },
      academyEnrollment: { updateMany: jest.fn() },
    };
    return { service: new LearningService(db as never), db };
  };

  it('does nothing until every lesson is done', async () => {
    const { service, db } = build(5, 4);
    expect(await service.afterProgress('l1', 'c1')).toEqual({
      courseCompleted: false,
      certificateId: null,
    });
    expect(db.academyCertificate.create).not.toHaveBeenCalled();
  });

  it('completes the course and issues one certificate with snapshotted names', async () => {
    const { service, db } = build(5, 5);
    const r = await service.afterProgress('l1', 'c1');
    expect(r.courseCompleted).toBe(true);
    expect(db.academyCertificate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        learnerName: 'Asha',
        courseTitle: 'Robotics 101',
        learnerId: 'l1',
      }),
    });
  });

  it('reuses an existing certificate', async () => {
    const { service, db } = build(5, 5, { shortId: 'ABC' });
    expect(await service.afterProgress('l1', 'c1')).toEqual({
      courseCompleted: true,
      certificateId: 'ABC',
    });
    expect(db.academyCertificate.create).not.toHaveBeenCalled();
  });
});

describe('LMS import type mapping', () => {
  it('maps LMS content types onto Academy lesson types', () => {
    expect(lessonTypeFromLms('video_link')).toBe('VIDEO');
    expect(lessonTypeFromLms('pdf')).toBe('PDF');
    expect(lessonTypeFromLms('html')).toBe('TEXT');
    expect(lessonTypeFromLms('audio')).toBe('LINK');
  });
});
