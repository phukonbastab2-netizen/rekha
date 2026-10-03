import { createHmac, timingSafeEqual } from 'node:crypto';

export function validSignature(value, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(value).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function paymentProvider(config) {
  async function request(endpoint, body) {
    const result = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Basic ${Buffer.from(`${config.razorKey}:${config.razorSecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!result.ok) throw new Error('Payment service unavailable');
    return result.json();
  }
  return {
    create: receipt => request('orders', { amount: config.amount, currency: 'INR', receipt, partial_payment: false }),
    fetchPayment: id => request(`payments/${encodeURIComponent(id)}`),
  };
}
