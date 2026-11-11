import { TeacherReportsController } from './reports.controller';

describe('TeacherReportsController', () => {
  it('passes the subject the teacher chose through to the service', () => {
    const service = { create: jest.fn().mockResolvedValue({}) };
    const controller = new TeacherReportsController(service as never);
    controller.create(
      { id: 7 },
      {
        school_id: 's1',
        date: '2026-11-11',
        period_id: 'p1',
        subject: 'Robotics',
        topics_taught: 'Sensors',
      },
    );
    expect(service.create).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ subject: 'Robotics', period_id: 'p1' }),
    );
  });
});
