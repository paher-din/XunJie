import type { Transaction } from '../db/transaction.ts';
import { ApiError } from '../app/errors.ts';
import { readCurrentInTransaction as readStoredCurrent,readState } from './storage.ts';
import { createEvidenceResolver } from './evidence.ts';
import { projectedClaimSchema,type LearnerScope } from '../../contracts/review/index.ts';

/** Read-time availability never rewrites an original claim or guesses missing/private content. */
export function readCurrentInTransaction(tx: Transaction,scope: LearnerScope) {
  const current = readStoredCurrent(tx,scope),state = readState(tx,scope);
  const readEvidence=createEvidenceResolver(tx,scope,state);
  return {...current,claims: current.claims.map(claim => {
    const references = claim.refs.map(ref => {
      try {readEvidence(ref);return {ref,status: 'available' as const};}
      catch (error) {
        if (!(error instanceof ApiError) || !['INVALID_REFERENCE','FORBIDDEN','VERSION_CONFLICT','STATE_CONFLICT'].includes(error.code)) throw error;
        return {ref,status: 'unavailable' as const};
      }
    });
    return projectedClaimSchema.parse({...claim,references,basisAvailable: ['active','contested'].includes(claim.validity)
      && references.every(value => value.status === 'available')});
  })};
}
