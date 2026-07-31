import { ForbiddenException } from '@nestjs/common';
import { SchoolAdminSchoolService } from './school.service';
import { DatabaseService } from '../../database/database.service';

describe('SchoolAdminSchoolService', () => {
  let service: SchoolAdminSchoolService;
  let db: {
    schoolAdmin: { findFirst: jest.Mock };
    grade: { findMany: jest.Mock };
  };

  beforeEach(() => {
    db = {
      schoolAdmin: {
        findFirst: jest.fn().mockResolvedValue({
          school: {
            id: 'school-1',
            name: 'Test School',
            schoolCode: 'TS1',
            isActive: true,
            createdAt: new Date('2026-01-01'),
            updatedAt: new Date('2026-01-01'),
          },
        }),
      },
      grade: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'grade-5',
            name: 'Grade 5',
            sections: [
              { id: 'sec-a', name: 'Section A' },
              { id: 'sec-b', name: 'Section B' },
            ],
          },
          {
            id: 'grade-6',
            name: 'Grade 6',
            sections: [{ id: 'sec-c', name: 'Section C' }],
          },
        ]),
      },
    };
    service = new SchoolAdminSchoolService(db as unknown as DatabaseService);
  });

  it('returns a per-grade section breakdown alongside the flat sections_offered list', async () => {
    const result = await service.get({ id: 1 });

    expect(result.school.sections_offered).toEqual(['Section A', 'Section B', 'Section C']);
    // The flat list above is what let the Add/Edit student forms offer a
    // section that doesn't exist for the selected grade (e.g. "Section C"
    // while editing a Grade 5 student) — grades must carry the real
    // per-grade mapping so the UI can scope correctly.
    expect(result.school.grades).toEqual([
      {
        id: 'grade-5',
        name: 'Grade 5',
        sections: [
          { id: 'sec-a', name: 'Section A' },
          { id: 'sec-b', name: 'Section B' },
        ],
      },
      {
        id: 'grade-6',
        name: 'Grade 6',
        sections: [{ id: 'sec-c', name: 'Section C' }],
      },
    ]);
  });

  it('throws when the caller has no school-admin assignment', async () => {
    db.schoolAdmin.findFirst.mockResolvedValue(null);
    await expect(service.get({ id: 1 })).rejects.toThrow(ForbiddenException);
  });
});
