import { requireAccess } from '../xj-dev/src/enrollment-protocol.mjs';

// #131 consumes this same proof and live revocation check, then applies its
// package ownership/quota rules. No storage SDK is part of device identity.
export function authenticateDevice(store, envelope, path, capability) {
  const device = store.authenticateProof(envelope, path);
  requireAccess(device.state === 'active', 'DEVICE_NOT_READY', 409);
  const identity = store.identity(device.id);
  if (capability) requireAccess(identity.capabilities.includes(capability), 'CAPABILITY_DENIED', 403);
  return identity;
}
