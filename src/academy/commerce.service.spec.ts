import { createHmac } from 'crypto';
import { CommerceService } from './commerce.service';
import { RazorpayService, safeEqualHex } from './razorpay.service';

describe('CommerceService.fulfil', () => {
  const order = {
    id: 'o1',
    accountId: 'acc-7',
    amountInPaise: 49900,
    status: 'CREATED',
    createdAt: new Date(),
    product: {
      isActive: true,
      priceInPaise: 49900,
      type: 'COURSE',
      courseId: 'c1',
      sessionCount: null,
      sessionMinutes: null,
    },
  };

  const build = (claimCount: number, over: Record<string, unknown> = {}) => {
    const tx = {
      academyOrder: {
        updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      },
      academyEnrollment: { upsert: jest.fn() },
      academySessionCredit: { create: jest.fn() },
    };
    const o = { ...order, ...over };
    const db = {
      academyOrder: {
        findUnique: jest.fn().mockResolvedValue(o),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const razorpay = { refund: jest.fn().mockResolvedValue({ id: 'rfnd_1' }) };
    return {
      service: new CommerceService(db as never, razorpay as never, {} as never),
      tx,
      db,
      razorpay,
    };
  };

  it('grants a PURCHASE enrollment once when the claim wins', async () => {
    const { service, tx } = build(1);
    expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(true);
    expect(tx.academyEnrollment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          learnerId: 'acc-7',
          courseId: 'c1',
          source: 'PURCHASE',
          orderId: 'o1',
        },
      }),
    );
  });

  it('is a no-op for a duplicate callback/webhook', async () => {
    const { service, tx } = build(0);
    expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(false);
    expect(tx.academyEnrollment.upsert).not.toHaveBeenCalled();
  });

  it('refuses a payment whose amount does not match the order', async () => {
    const { service, tx } = build(1);
    expect(await service.fulfil('rp_1', 'pay_1', 100)).toBe(false);
    expect(tx.academyOrder.updateMany).not.toHaveBeenCalled();
  });

  describe('stale checkouts are refunded, never granted at the old terms', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('refunds a payment that lands on an order older than the window', async () => {
      const { service, tx, db, razorpay } = build(1, {
        createdAt: new Date(Date.now() - 2 * DAY),
      });
      expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(false);
      expect(razorpay.refund).toHaveBeenCalledWith('pay_1', 49900);
      expect(db.academyOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'REFUNDED' }),
        }),
      );
      expect(tx.academyEnrollment.upsert).not.toHaveBeenCalled();
    });

    it('refunds when the product was deactivated since checkout', async () => {
      const { service, razorpay, tx } = build(1, {
        product: { ...order.product, isActive: false },
      });
      expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(false);
      expect(razorpay.refund).toHaveBeenCalled();
      expect(tx.academyEnrollment.upsert).not.toHaveBeenCalled();
    });

    it('refunds when the price was raised after the checkout snapshot', async () => {
      const { service, razorpay } = build(1, {
        product: { ...order.product, priceInPaise: 99900 },
      });
      expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(false);
      expect(razorpay.refund).toHaveBeenCalledWith('pay_1', 49900);
    });

    it('still grants a fresh order at the current price', async () => {
      const { service, razorpay } = build(1);
      expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(true);
      expect(razorpay.refund).not.toHaveBeenCalled();
    });

    it('does not refund an already-paid order again (duplicate webhook)', async () => {
      const { service, razorpay } = build(0, {
        status: 'PAID',
        createdAt: new Date(Date.now() - 2 * DAY),
      });
      expect(await service.fulfil('rp_1', 'pay_1', 49900)).toBe(false);
      expect(razorpay.refund).not.toHaveBeenCalled();
    });
  });
});

describe('Razorpay signatures', () => {
  beforeAll(() => {
    process.env.RAZORPAY_KEY_SECRET = 'key_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'hook_secret';
  });

  it('accepts a correct checkout signature and rejects a tampered one', () => {
    const rp = new RazorpayService();
    const sig = createHmac('sha256', 'key_secret')
      .update('order_1|pay_1')
      .digest('hex');
    expect(rp.verifyCheckoutSignature('order_1', 'pay_1', sig)).toBe(true);
    expect(rp.verifyCheckoutSignature('order_1', 'pay_2', sig)).toBe(false);
  });

  it('verifies webhook bodies byte-for-byte', () => {
    const rp = new RazorpayService();
    const body = Buffer.from('{"event":"payment.captured"}');
    const sig = createHmac('sha256', 'hook_secret').update(body).digest('hex');
    expect(rp.verifyWebhookSignature(body, sig)).toBe(true);
    expect(
      rp.verifyWebhookSignature(
        Buffer.from('{"event":"payment.captured" }'),
        sig,
      ),
    ).toBe(false);
    expect(safeEqualHex('abc', undefined)).toBe(false);
  });
});

describe('CommerceService free offers', () => {
  const freeProduct = {
    id: 'p0',
    type: 'SESSION_PACK',
    isActive: true,
    priceInPaise: 0,
    courseId: null,
    sessionCount: 1,
    sessionMinutes: 60,
  };

  const build = (alreadyClaimed: boolean, lateClaim = false) => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      academyOrder: {
        create: jest.fn().mockResolvedValue({ id: 'o-free' }),
        // the re-check under the advisory lock
        findFirst: jest
          .fn()
          .mockResolvedValue(lateClaim ? { id: 'won-race' } : null),
      },
      academyEnrollment: { upsert: jest.fn() },
      academySessionCredit: { create: jest.fn() },
    };
    const db = {
      academyProduct: { findFirst: jest.fn().mockResolvedValue(freeProduct) },
      academyOrder: {
        findFirst: jest
          .fn()
          .mockResolvedValue(alreadyClaimed ? { id: 'old' } : null),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const razorpay = { createOrder: jest.fn() };
    return {
      service: new CommerceService(db as never, razorpay as never, {} as never),
      tx,
      razorpay,
    };
  };

  it('grants a free trial class without Razorpay', async () => {
    const { service, tx, razorpay } = build(false);
    expect(await service.createCheckout('acc-1', 'p0')).toEqual({
      free: true,
      product: { type: 'SESSION_PACK', courseId: null },
    });
    expect(razorpay.createOrder).not.toHaveBeenCalled();
    expect(tx.academyOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountInPaise: 0, status: 'PAID' }),
    });
    expect(tx.academySessionCredit.create).toHaveBeenCalledWith({
      data: { learnerId: 'acc-1', orderId: 'o-free', total: 1, minutes: 60 },
    });
  });

  it('closes the race: a claim that lost the lock re-check grants nothing', async () => {
    // fast-path check passed (nothing claimed yet) but a parallel request committed first
    const { service, tx } = build(false, true);
    await expect(service.createCheckout('acc-1', 'p0')).rejects.toThrow(
      /already claimed/,
    );
    expect(tx.$executeRaw).toHaveBeenCalled(); // took the advisory lock first
    expect(tx.academyOrder.create).not.toHaveBeenCalled();
    expect(tx.academySessionCredit.create).not.toHaveBeenCalled();
  });

  it('can be claimed only once per learner', async () => {
    const { service, tx } = build(true);
    await expect(service.createCheckout('acc-1', 'p0')).rejects.toThrow(
      /already claimed/,
    );
    expect(tx.academyOrder.create).not.toHaveBeenCalled();
  });
});
