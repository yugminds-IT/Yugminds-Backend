import { createHmac } from 'crypto';
import { CommerceService } from './commerce.service';
import { RazorpayService, safeEqualHex } from './razorpay.service';

describe('CommerceService.fulfil', () => {
  const order = {
    id: 'o1',
    accountId: 'acc-7',
    amountInPaise: 49900,
    product: {
      type: 'COURSE',
      courseId: 'c1',
      sessionCount: null,
      sessionMinutes: null,
    },
  };

  const build = (claimCount: number) => {
    const tx = {
      academyOrder: {
        updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      },
      academyEnrollment: { upsert: jest.fn() },
      academySessionCredit: { create: jest.fn() },
    };
    const db = {
      academyOrder: { findUnique: jest.fn().mockResolvedValue(order) },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    return { service: new CommerceService(db as never, {} as never, {} as never), tx };
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

  const build = (alreadyClaimed: boolean) => {
    const tx = {
      academyOrder: { create: jest.fn().mockResolvedValue({ id: 'o-free' }) },
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

  it('can be claimed only once per learner', async () => {
    const { service, tx } = build(true);
    await expect(service.createCheckout('acc-1', 'p0')).rejects.toThrow(
      /already claimed/,
    );
    expect(tx.academyOrder.create).not.toHaveBeenCalled();
  });
});
