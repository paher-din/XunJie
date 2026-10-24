// Shared receipt validation used by cloud publication. Local scenario construction uses xj-dev.
function requireCondition(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }); }

/** Validate original normal-host completion identity and hash; no flattened legacy receipt fallback. */
export function verifyCompletionReceipt(receipt, expectedIdentity, fields, original, validateResult) {
  requireCondition(receipt && typeof receipt === 'object' && Object.hasOwn(receipt, 'result'), 'COMMAND_RECEIPT_REQUIRED');
  let identity;
  try { identity = original.readCommandIdentity(receipt.identity); }
  catch { throw Object.assign(new Error('COMMAND_RECEIPT_IDENTITY_REQUIRED'), { code: 'COMMAND_RECEIPT_IDENTITY_REQUIRED' }); }
  requireCondition(original.canonical(identity) === original.canonical(expectedIdentity), 'COMMAND_RECEIPT_SCOPE_MISMATCH');
  requireCondition(receipt.requestHash === original.requestHash(expectedIdentity.target, fields), 'COMMAND_RECEIPT_HASH_MISMATCH');
  requireCondition(typeof receipt.commandId === 'string' && receipt.commandId.length > 0
    && typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0
    && Number.isSafeInteger(receipt.serverSeq) && receipt.serverSeq > 0
    && typeof receipt.committedAt === 'string' && Number.isFinite(Date.parse(receipt.committedAt)), 'COMMAND_RECEIPT_METADATA_REQUIRED');
  return { commandId: receipt.commandId, receiptId: receipt.receiptId, identity, requestHash: receipt.requestHash,
    serverSeq: receipt.serverSeq, committedAt: receipt.committedAt, result: validateResult(receipt.result) };
}
