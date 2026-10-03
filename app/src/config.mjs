import path from 'node:path';

export function configuration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const config = {
    production, host: env.HOST || '127.0.0.1', port: Number(env.PORT || 4317),
    origin: env.PUBLIC_ORIGIN || 'http://127.0.0.1:4317',
    dataDir: path.resolve(env.DATA_DIR || 'data'), adminPassword: env.ADMIN_PASSWORD || '',
    aiMode: env.AI_MODE || 'demo', aiBase: env.AI_BASE_URL || '',
    aiKey: env.AI_API_KEY || '', aiModel: env.AI_MODEL || '',
    paymentMode: env.PAYMENT_MODE || 'demo', razorKey: env.RAZORPAY_KEY_ID || '',
    razorSecret: env.RAZORPAY_KEY_SECRET || '', webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    retentionDays: Number(env.RETENTION_DAYS || 30), freeTurns: 3, amount: 4900,
  };
  if (config.adminPassword.length < 16) throw new Error('Set ADMIN_PASSWORD to at least 16 characters in .env.');
  if (!['demo', 'live'].includes(config.aiMode) || !['demo', 'razorpay'].includes(config.paymentMode)) throw new Error('Invalid provider mode.');
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 365) throw new Error('RETENTION_DAYS must be 1–365.');
  if (config.aiMode === 'live' && (!config.aiKey || !config.aiModel || !config.aiBase.startsWith('https://'))) throw new Error('Live AI requires an HTTPS AI_BASE_URL, AI_API_KEY and AI_MODEL.');
  if (config.paymentMode === 'razorpay' && (!config.razorKey || !config.razorSecret || !config.webhookSecret)) throw new Error('Razorpay requires all three credentials.');
  if (production && (!config.origin.startsWith('https://') || config.aiMode === 'demo' || config.paymentMode === 'demo')) throw new Error('Production requires HTTPS and configured live providers; demo modes are disabled.');
  if (production && !config.razorKey.startsWith('rzp_live_')) throw new Error('Production requires a Razorpay live key.');
  return config;
}
