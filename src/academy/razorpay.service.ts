import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

const API = 'https://api.razorpay.com/v1';

/** Thin Razorpay REST client — two calls and two signature checks don't need the SDK. */
@Injectable()
export class RazorpayService {
  get keyId(): string {
    const id = process.env.RAZORPAY_KEY_ID;
    if (!id)
      throw new ServiceUnavailableException('Payments are not configured');
    return id;
  }

  private get keySecret(): string {
    const s = process.env.RAZORPAY_KEY_SECRET;
    if (!s)
      throw new ServiceUnavailableException('Payments are not configured');
    return s;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new BadGatewayException(`Razorpay ${path} failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  createOrder(
    amountInPaise: number,
    receipt: string,
    notes: Record<string, string>,
  ) {
    return this.call<{ id: string; amount: number; currency: string }>(
      '/orders',
      {
        amount: amountInPaise,
        currency: 'INR',
        receipt,
        notes,
      },
    );
  }

  refund(paymentId: string, amountInPaise: number) {
    return this.call<{ id: string }>(`/payments/${paymentId}/refund`, {
      amount: amountInPaise,
    });
  }

  /** Checkout callback: HMAC(order_id|payment_id, key_secret). */
  verifyCheckoutSignature(
    orderId: string,
    paymentId: string,
    signature: string,
  ): boolean {
    return safeEqualHex(
      createHmac('sha256', this.keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex'),
      signature,
    );
  }

  /** Webhook: HMAC(raw body, webhook secret). */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret)
      throw new ServiceUnavailableException('Payments are not configured');
    return safeEqualHex(
      createHmac('sha256', secret).update(rawBody).digest('hex'),
      signature,
    );
  }
}

export function safeEqualHex(
  expected: string,
  given: string | undefined,
): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
