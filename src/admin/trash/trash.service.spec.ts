import { NotFoundException } from '@nestjs/common';
import { TrashService } from './trash.service';
import { DatabaseService } from '../../database/database.service';
import { AdminSchoolsService } from '../schools/schools.service';

describe('TrashService', () => {
  let service: TrashService;
  let db: {
    user: { findFirst: jest.Mock; delete: jest.Mock };
    teacherReport: { deleteMany: jest.Mock };
    teacherLeave: { deleteMany: jest.Mock };
  };
  let schoolsService: { purge: jest.Mock };

  beforeEach(() => {
    db = {
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 5, deletedAt: new Date() }),
        delete: jest.fn().mockResolvedValue({}),
      },
      teacherReport: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      teacherLeave: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    schoolsService = { purge: jest.fn().mockResolvedValue({}) };
    service = new TrashService(
      db as unknown as DatabaseService,
      schoolsService as unknown as AdminSchoolsService,
    );
  });

  describe('purge("teachers", id)', () => {
    it('deletes the teacher-owned TeacherReport rows before hard-deleting the user', async () => {
      const callOrder: string[] = [];
      db.teacherReport.deleteMany.mockImplementation(async () => {
        callOrder.push('teacherReport.deleteMany');
        return { count: 2 };
      });
      db.user.delete.mockImplementation(async () => {
        callOrder.push('user.delete');
        return {};
      });

      await service.purge('teachers', '5');

      expect(db.teacherReport.deleteMany).toHaveBeenCalledWith({
        where: { teacherId: 5 },
      });
      expect(db.user.delete).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(callOrder).toEqual(['teacherReport.deleteMany', 'user.delete']);
    });

    it('throws when the user is not in trash (not soft-deleted)', async () => {
      db.user.findFirst.mockResolvedValue(null);

      await expect(service.purge('teachers', '5')).rejects.toThrow(
        NotFoundException,
      );
      expect(db.teacherReport.deleteMany).not.toHaveBeenCalled();
      expect(db.user.delete).not.toHaveBeenCalled();
    });
  });
});
