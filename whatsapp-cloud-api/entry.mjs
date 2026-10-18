import worker from './worker.mjs';
import qr from './qr-data.mjs';
export { FunnelConversation, CloudApiControl } from './worker.mjs';

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/assets/qr-shahrukh-20261018.png' && ['GET', 'HEAD'].includes(request.method)) {
      const bytes = Uint8Array.from(atob(qr), c => c.charCodeAt(0));
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength), 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }
      });
    }
    return worker.fetch(request, env, ctx);
  }
};
