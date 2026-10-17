import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const legacy = 'require("WAWebAltDeviceLinkingApi").PairingType';
const current = 'require("WAWebPairingType").PairingType';
const originalHash = '4f6d35569c62eecea87947f3e2946a2460f84df3aa23f8193839a66d95eead49';
const digest = text => createHash('sha256').update(text).digest('hex');
export function repairPairingAsset(source) {
  // Gate this narrow compatibility fix to the pinned, reviewed launch asset.
  const restored = source.replaceAll(current, legacy);
  if (digest(restored) !== originalHash) throw Error('Unrecognized OpenWA pairing asset; review its compatibility before connecting.');
  return source.replaceAll(legacy, current);
}
export function ensurePairingCompatibility() {
  const require = createRequire(import.meta.url);
  const file = path.join(path.dirname(require.resolve('@open-wa/core')), 'transport/assets/launch.js');
  const source = fs.readFileSync(file,'utf8'), repaired = repairPairingAsset(source);
  if (source !== repaired) fs.writeFileSync(file,repaired);
}
