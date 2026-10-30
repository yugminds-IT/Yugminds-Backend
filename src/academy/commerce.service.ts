import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AcademyOrderStatus, AcademyRole, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { RazorpayService } from './razorpay.service';
import { SessionsService } from '../auth/sessions/sessions.service';
import type { ProductDto } from './academy.dto';

type Tx = Prisma.TransactionClient;
const { CREATED, PAID, FAILED, REFUNDED } = AcademyOrderStatus;

const PUBLIC_PRODUCT = {
  id: true,
  type: true,
  slug: true,
  title: true,
  description: true,
  thumbnailUrl: true,
  priceInPaise: true,
  mrpInPaise: true,
  courseId: true,
  sessionMinutes: true,
  sessionCount: true,
} satisfies Prisma.AcademyProductSelect;

@Injectable()
export class CommerceService {
  private readonly logger = new Logger(CommerceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly razorpay: RazorpayService,
    private readonly sessions: SessionsService,
  ) {}

  // ─── Catalog (public) ────────────────────────────────────────────────────

  listProducts() {
    return this.db.academyProduct.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: PUBLIC_PRODUCT,
    });
  }

  async getProduct(slug: string) {
    const product = await this.db.academyProduct.findFirst({
      where: { slug, isActive: true },
      select: PUBLIC_PRODUCT,
    });
    if (!product) throw new NotFoundException('Product not found');
    // Curriculum preview: titles only; preview lessons are flagged so the page can say so.
    const curriculum = product.courseId
      ? await this.db.academyModule.findMany({
          where: { courseId: product.courseId },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            title: true,
            lessons: {
              orderBy: { sortOrder: 'asc' },
              select: {
                title: true,
                type: true,
                durationMinutes: true,
                isPreview: true,
              },
            },
          },
        })
      : [];
    return { ...product, curriculum };
  }

  // ─── Checkout ────────────────────────────────────────────────────────────

  async createCheckout(accountId: string, productId: string) {
    const product = await this.db.academyProduct.findFirst({
      where: { id: productId, isActive: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.type === 'COURSE') {
      if (!product.courseId)
        throw new BadRequestException('This course is not available yet');
      const owned = await this.db.academyEnrollment.findUnique({
        where: {
          learnerId_courseId: {
            learnerId: accountId,
            courseId: product.courseId,
          },
        },
      });
      if (owned) throw new BadRequestException('You already have this course');
    }
    if (product.priceInPaise === 0) return this.claimFree(accountId, product);
    const buyer = await this.db.academyAccount.findUnique({
      where: { id: accountId },
      select: { fullName: true, phone: true, email: true },
    });
    const receiptNo = `AC-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    // Price always comes from the database, never from the client.
    const rp = await this.razorpay.createOrder(
      product.priceInPaise,
      receiptNo,
      {
        productId: product.id,
        accountId,
      },
    );
    const order = await this.db.academyOrder.create({
      data: {
        accountId,
        productId: product.id,
        amountInPaise: product.priceInPaise,
        razorpayOrderId: rp.id,
        receiptNo,
        buyerName: buyer?.fullName ?? null,
        buyerPhone: buyer?.phone ?? null,
      },
    });
    return {
      orderId: order.id,
      razorpayOrderId: rp.id,
      keyId: this.razorpay.keyId,
      amountInPaise: order.amountInPaise,
      currency: 'INR',
      productTitle: product.title,
      prefill: {
        name: buyer?.fullName ?? '',
        email: buyer?.email ?? '',
        contact: buyer?.phone ?? '',
      },
    };
  }

  /**
   * ₹0 products (free demo course, free trial class): no Razorpay, granted
   * immediately, once per learner — a PAID ₹0 order is the claim record.
   */
  private async claimFree(
    accountId: string,
    product: {
      id: string;
      type: string;
      courseId: string | null;
      sessionCount: number | null;
      sessionMinutes: number | null;
    },
  ) {
    const claimed = await this.db.academyOrder.findFirst({
      where: { accountId, productId: product.id, status: PAID },
    });
    if (claimed)
      throw new BadRequestException("You've already claimed this free offer");
    const receipt = `FREE-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    await this.db.$transaction(async (tx) => {
      const order = await tx.academyOrder.create({
        data: {
          accountId,
          productId: product.id,
          amountInPaise: 0,
          status: PAID,
          paidAt: new Date(),
          razorpayOrderId: `free_${randomUUID()}`,
          receiptNo: receipt,
        },
      });
      await this.grant(tx, accountId, order.id, product);
    });
    return {
      free: true as const,
      product: { type: product.type, courseId: product.courseId },
    };
  }

  /** Browser callback after payment. The webhook remains the source of truth. */
  async verifyCheckout(
    accountId: string,
    razorpayOrderId: string,
    paymentId: string,
    signature: string,
  ) {
    if (
      !this.razorpay.verifyCheckoutSignature(
        razorpayOrderId,
        paymentId,
        signature,
      )
    ) {
      throw new BadRequestException('Payment signature mismatch');
    }
    const order = await this.db.academyOrder.findFirst({
      where: { razorpayOrderId, accountId },
    });
    if (!order) throw new NotFoundException('Order not found');
    await this.fulfil(razorpayOrderId, paymentId, order.amountInPaise);
    return this.db.academyOrder.findUnique({
      where: { id: order.id },
      select: {
        id: true,
        status: true,
        receiptNo: true,
        product: { select: { type: true, courseId: true, title: true } },
      },
    });
  }

  /** Razorpay webhook (already signature-verified by the controller). */
  async handleWebhook(event: {
    event?: string;
    payload?: {
      payment?: {
        entity?: { id?: string; order_id?: string; amount?: number };
      };
    };
  }) {
    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id || !payment.id) return { ignored: true };
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      await this.fulfil(payment.order_id, payment.id, payment.amount);
    } else if (event.event === 'payment.failed') {
      await this.db.academyOrder.updateMany({
        where: { razorpayOrderId: payment.order_id, status: CREATED },
        data: { status: FAILED, razorpayPaymentId: payment.id },
      });
    }
    return { ok: true };
  }

  /**
   * Idempotent: the browser callback and the webhook can both arrive (in any
   * order, possibly twice). The CREATED|FAILED → PAID claim lets exactly one win.
   */
  async fulfil(
    razorpayOrderId: string,
    paymentId: string,
    paidAmount?: number,
  ) {
    const order = await this.db.academyOrder.findUnique({
      where: { razorpayOrderId },
      include: { product: true },
    });
    if (!order) {
      this.logger.warn(`Payment for unknown Razorpay order ${razorpayOrderId}`);
      return false;
    }
    if (paidAmount !== undefined && paidAmount !== order.amountInPaise) {
      this.logger.error(
        `Amount mismatch on ${order.id}: paid ${paidAmount}, expected ${order.amountInPaise}`,
      );
      return false;
    }
    return this.db.$transaction(async (tx) => {
      const claim = await tx.academyOrder.updateMany({
        where: { id: order.id, status: { in: [CREATED, FAILED] } },
        data: {
          status: PAID,
          paidAt: new Date(),
          razorpayPaymentId: paymentId,
        },
      });
      if (claim.count === 0) return false;
      await this.grant(tx, order.accountId, order.id, order.product);
      return true;
    });
  }

  private async grant(
    tx: Tx,
    learnerId: string,
    orderId: string,
    product: {
      type: string;
      courseId: string | null;
      sessionCount: number | null;
      sessionMinutes: number | null;
    },
  ) {
    if (product.type === 'COURSE' && product.courseId) {
      await tx.academyEnrollment.upsert({
        where: {
          learnerId_courseId: { learnerId, courseId: product.courseId },
        },
        create: {
          learnerId,
          courseId: product.courseId,
          source: 'PURCHASE',
          orderId,
        },
        update: { source: 'PURCHASE', orderId },
      });
    } else if (product.type === 'SESSION_PACK') {
      await tx.academySessionCredit.create({
        data: {
          learnerId,
          orderId,
          total: product.sessionCount ?? 1,
          minutes: product.sessionMinutes ?? 60,
        },
      });
    }
  }

  /** Admin refund: money back via Razorpay, then revoke what the order granted. */
  async refund(orderId: string) {
    const order = await this.db.academyOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status !== PAID || !order.razorpayPaymentId) {
      throw new BadRequestException('Only paid orders can be refunded');
    }
    await this.razorpay.refund(order.razorpayPaymentId, order.amountInPaise);
    await this.db.$transaction(async (tx) => {
      await tx.academyOrder.update({
        where: { id: order.id },
        data: { status: REFUNDED, refundedAt: new Date() },
      });
      await tx.academyEnrollment.deleteMany({
        where: { orderId: order.id, source: 'PURCHASE' },
      });
      // Unused credits are cancelled; classes already booked stay as they are.
      await tx.$executeRaw`UPDATE "AcademySessionCredit" SET "total" = "used" WHERE "orderId" = ${order.id}`;
    });
    return { ok: true };
  }

  // ─── Learner ─────────────────────────────────────────────────────────────

  myOrders(accountId: string) {
    return this.db.academyOrder.findMany({
      where: { accountId, status: { in: [PAID, REFUNDED] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        receiptNo: true,
        amountInPaise: true,
        status: true,
        paidAt: true,
        refundedAt: true,
        product: { select: { title: true, type: true } },
      },
    });
  }

  // ─── Admin ───────────────────────────────────────────────────────────────

  adminProducts() {
    return this.db.academyProduct.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async saveProduct(dto: ProductDto, id?: string) {
    if (dto.type === 'COURSE') {
      if (!dto.courseId)
        throw new BadRequestException('Pick the course this product unlocks');
      const course = await this.db.academyCourse.findUnique({
        where: { id: dto.courseId },
      });
      if (!course) throw new BadRequestException('Course not found');
      if (dto.isActive !== false && !course.isPublished) {
        throw new BadRequestException(
          'Publish the course before putting it on sale',
        );
      }
    } else if (!dto.sessionMinutes || !dto.sessionCount) {
      throw new BadRequestException(
        'Class packs need a class length and count',
      );
    }
    const data = {
      ...dto,
      courseId: dto.type === 'COURSE' ? dto.courseId : null,
      sessionMinutes: dto.type === 'SESSION_PACK' ? dto.sessionMinutes : null,
      sessionCount: dto.type === 'SESSION_PACK' ? dto.sessionCount : null,
    };
    try {
      return id
        ? await this.db.academyProduct.update({ where: { id }, data })
        : await this.db.academyProduct.create({ data });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002')
        throw new BadRequestException('That URL slug is already used');
      throw e;
    }
  }

  async adminOrders(q: {
    status?: string;
    search?: string;
    take?: number;
    skip?: number;
  }) {
    const status = Object.values(AcademyOrderStatus).includes(
      q.status as AcademyOrderStatus,
    )
      ? (q.status as AcademyOrderStatus)
      : undefined;
    const search = q.search?.trim();
    const where: Prisma.AcademyOrderWhereInput = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { receiptNo: { contains: search, mode: 'insensitive' } },
              { buyerName: { contains: search, mode: 'insensitive' } },
              { buyerPhone: { contains: search } },
              { razorpayPaymentId: { contains: search } },
            ],
          }
        : {}),
    };
    const take = Math.min(Math.max(q.take ?? 50, 1), 200);
    const [rows, total] = await Promise.all([
      this.db.academyOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip: q.skip ?? 0,
        include: { product: { select: { title: true, type: true } } },
      }),
      this.db.academyOrder.count({ where }),
    ]);
    return { rows, total };
  }

  async adminLearners(search?: string) {
    const term = search?.trim();
    const learners = await this.db.academyAccount.findMany({
      where: {
        role: AcademyRole.LEARNER,
        ...(term
          ? {
              OR: [
                { email: { contains: term, mode: 'insensitive' } },
                { fullName: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        parentName: true,
        isActive: true,
        createdAt: true,
      },
    });
    const ids = learners.map((l) => l.id);
    const [courses, paid] = await Promise.all([
      this.db.academyEnrollment.groupBy({
        by: ['learnerId'],
        where: { learnerId: { in: ids } },
        _count: true,
      }),
      this.db.academyOrder.groupBy({
        by: ['accountId'],
        where: { accountId: { in: ids }, status: PAID },
        _sum: { amountInPaise: true },
      }),
    ]);
    const courseCount = new Map(courses.map((c) => [c.learnerId, c._count]));
    const spent = new Map(
      paid.map((p) => [p.accountId, p._sum.amountInPaise ?? 0]),
    );
    return learners.map((l) => ({
      ...l,
      courseCount: courseCount.get(l.id) ?? 0,
      spentInPaise: spent.get(l.id) ?? 0,
    }));
  }

  async grantCourse(learnerId: string, courseId: string) {
    const learner = await this.db.academyAccount.findFirst({
      where: { id: learnerId, role: AcademyRole.LEARNER },
    });
    if (!learner) throw new NotFoundException('Learner not found');
    const course = await this.db.academyCourse.findUnique({
      where: { id: courseId },
    });
    if (!course) throw new NotFoundException('Course not found');
    // A purchase stays a purchase; only add a GRANT when there is no row yet.
    await this.db.academyEnrollment.upsert({
      where: { learnerId_courseId: { learnerId, courseId } },
      create: { learnerId, courseId, source: 'GRANT' },
      update: {},
    });
    return { ok: true };
  }

  async setAccountActive(id: string, isActive: boolean) {
    await this.db.academyAccount.update({
      where: { id },
      // Deactivation also revokes refresh tokens.
      data: {
        isActive,
        ...(isActive ? {} : { tokenVersion: { increment: 1 } }),
      },
    });
    if (!isActive) await this.sessions.revokeMany('academy', id);
    return { ok: true };
  }

  async overview() {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const now = new Date();
    const since = new Date(Date.now() - 30 * 86400_000);
    const sale = { status: PAID, amountInPaise: { gt: 0 } }; // free claims (₹0) aren't sales
    const [
      all,
      month,
      learners,
      recent,
      signups,
      draftCourses,
      linkless,
      upcoming,
      latest,
    ] = await Promise.all([
      this.db.academyOrder.aggregate({
        where: sale,
        _sum: { amountInPaise: true },
        _count: true,
      }),
      this.db.academyOrder.aggregate({
        where: { ...sale, paidAt: { gte: monthStart } },
        _sum: { amountInPaise: true },
        _count: true,
      }),
      this.db.academyAccount.count({ where: { role: AcademyRole.LEARNER } }),
      this.db.academyOrder.findMany({
        where: { ...sale, paidAt: { gte: since } },
        select: { paidAt: true, amountInPaise: true },
      }),
      this.db.academyAccount.findMany({
        where: { role: AcademyRole.LEARNER, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.db.academyCourse.count({ where: { isPublished: false } }),
      this.db.academyBooking.count({
        where: {
          status: 'CONFIRMED',
          meetingLink: null,
          startsAt: { gte: now, lt: new Date(now.getTime() + 2 * 86400_000) },
        },
      }),
      this.db.academyBooking.findMany({
        where: { status: 'CONFIRMED', startsAt: { gte: now } },
        orderBy: { startsAt: 'asc' },
        take: 5,
      }),
      this.db.academyOrder.findMany({
        where: { status: PAID },
        orderBy: { paidAt: 'desc' },
        take: 6,
        select: {
          id: true,
          buyerName: true,
          amountInPaise: true,
          paidAt: true,
          product: { select: { title: true } },
        },
      }),
    ]);

    // Last 30 IST days, zero-filled, so every chart has an honest series.
    const istDay = (d: Date) =>
      new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const days = Array.from({ length: 30 }, (_, i) =>
      istDay(new Date(now.getTime() - (29 - i) * 86400_000)),
    );
    const daily = new Map(
      days.map((d) => [d, { amountInPaise: 0, orders: 0, signups: 0 }]),
    );
    for (const o of recent) {
      const row = daily.get(istDay(o.paidAt!));
      if (row) {
        row.amountInPaise += o.amountInPaise;
        row.orders += 1;
      }
    }
    for (const a of signups) {
      const row = daily.get(istDay(a.createdAt));
      if (row) row.signups += 1;
    }

    const people = await this.db.academyAccount.findMany({
      where: { id: { in: upcoming.flatMap((b) => [b.learnerId, b.tutorId]) } },
      select: { id: true, fullName: true },
    });
    const nameOf = new Map(people.map((p) => [p.id, p.fullName]));

    return {
      revenueInPaise: all._sum.amountInPaise ?? 0,
      paidOrders: all._count,
      monthRevenueInPaise: month._sum.amountInPaise ?? 0,
      monthOrders: month._count,
      learners,
      daily: days.map((date) => ({ date, ...daily.get(date)! })),
      attention: { draftCourses, classesWithoutLink: linkless },
      upcomingBookings: upcoming.map((b) => ({
        id: b.id,
        startsAt: b.startsAt,
        meetingLink: b.meetingLink,
        learnerName: nameOf.get(b.learnerId) ?? 'Learner',
        tutorName: nameOf.get(b.tutorId) ?? 'Tutor',
      })),
      recentOrders: latest,
    };
  }
}
