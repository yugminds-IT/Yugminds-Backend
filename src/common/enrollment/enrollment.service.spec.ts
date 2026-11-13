import { Test, TestingModule } from '@nestjs/testing';
import { EnrollmentService, CourseGradeGrant } from './enrollment.service';
import { DatabaseService } from '../../database/database.service';

describe('EnrollmentService.shouldEnroll', () => {
  let service: EnrollmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentService,
        { provide: DatabaseService, useValue: {} },
      ],
    }).compile();
    service = module.get<EnrollmentService>(EnrollmentService);
  });

  it('no grants → whole school (always enroll)', () => {
    expect(service.shouldEnroll([], 'Grade 4', 'A')).toBe(true);
    expect(service.shouldEnroll([], null, null)).toBe(true);
  });

  it('grade match with no sections → grade-wide (any section enrolls)', () => {
    const grants: CourseGradeGrant[] = [
      { gradeName: 'Grade 4', sectionNames: [] },
    ];
    expect(service.shouldEnroll(grants, 'Grade 4', 'A')).toBe(true);
    expect(service.shouldEnroll(grants, 'Grade 4', 'Z')).toBe(true);
    expect(service.shouldEnroll(grants, 'Grade 4', null)).toBe(true);
  });

  it('grade match with sections → only listed sections enroll', () => {
    const grants: CourseGradeGrant[] = [
      { gradeName: 'Grade 4', sectionNames: ['A', 'B'] },
    ];
    expect(service.shouldEnroll(grants, 'Grade 4', 'A')).toBe(true);
    expect(service.shouldEnroll(grants, 'Grade 4', 'B')).toBe(true);
  });

  it('grade match but student in a different section → excluded', () => {
    const grants: CourseGradeGrant[] = [
      { gradeName: 'Grade 4', sectionNames: ['A', 'B'] },
    ];
    expect(service.shouldEnroll(grants, 'Grade 4', 'C')).toBe(false);
    // Section-restricted grant + student with no section → excluded.
    expect(service.shouldEnroll(grants, 'Grade 4', null)).toBe(false);
  });

  it('no matching grade → excluded even if section would match another grade', () => {
    const grants: CourseGradeGrant[] = [
      { gradeName: 'Grade 5', sectionNames: ['A'] },
    ];
    expect(service.shouldEnroll(grants, 'Grade 4', 'A')).toBe(false);
    expect(service.shouldEnroll(grants, null, 'A')).toBe(false);
  });

  it('matches grade and section exactly', () => {
    const grants: CourseGradeGrant[] = [
      { gradeName: 'Grade 4', sectionNames: ['Section A'] },
    ];
    expect(service.shouldEnroll(grants, 'Grade 4', 'Section A')).toBe(true);
    // Non-standard grade / section spellings never match.
    expect(service.shouldEnroll(grants, 'grade4', 'Section A')).toBe(false);
    expect(service.shouldEnroll(grants, '4', 'Section A')).toBe(false);
    expect(service.shouldEnroll(grants, 'Grade 4', 'A')).toBe(false);
    expect(service.shouldEnroll(grants, 'Grade 4', 'Sec A')).toBe(false);
    expect(service.shouldEnroll(grants, 'Grade 4', 'SECTION A')).toBe(false);
    expect(service.shouldEnroll(grants, 'Grade 4', 'Section B')).toBe(false);
  });
});
