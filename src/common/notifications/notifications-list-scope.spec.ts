import { NotificationsService } from './notifications.service';

/**
 * Notification has no schoolId and the tenant extension skips it, so the where
 * clause built here IS the isolation boundary. A search must narrow within the
 * caller's own notifications, never widen to everyone's.
 */
describe('NotificationsService.listWithProfiles keeps ownership when searching', () => {
  const make = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const svc: any = Object.create(NotificationsService.prototype);
    svc.db = { notification: { findMany, count } };
    return { svc: svc as NotificationsService, findMany };
  };
  const whereOf = (findMany: jest.Mock) => findMany.mock.calls[0][0].where;

  it("'all' mode + search still restricts to recipient-or-sender, and ANDs the search", async () => {
    const { svc, findMany } = make();
    await svc.listWithProfiles(7, { mode: 'all', limit: 20, search: 'grade' });
    const where = whereOf(findMany);
    expect(where.OR).toEqual([{ userId: 7 }, { senderId: 7 }]); // ownership kept
    expect(where.AND).toEqual([
      {
        OR: [
          { title: { contains: 'grade', mode: 'insensitive' } },
          { message: { contains: 'grade', mode: 'insensitive' } },
        ],
      },
    ]);
    expect(where.deletedAt).toBeNull();
  });

  it("'received' and 'sent' stay pinned to the caller with a search", async () => {
    const a = make();
    await a.svc.listWithProfiles(7, {
      mode: 'received',
      limit: 20,
      search: 'x',
    });
    expect(whereOf(a.findMany).userId).toBe(7);
    const b = make();
    await b.svc.listWithProfiles(7, { mode: 'sent', limit: 20, search: 'x' });
    expect(whereOf(b.findMany).senderId).toBe(7);
  });
});
