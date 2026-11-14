import { createNearAiModel } from './near-ai-model.mjs';
import { publicModelReservationKey } from '../../src/server/public-journey.mjs';

const unavailable = () => { throw Object.assign(new Error('MODEL_CACHE_UNAVAILABLE'), { code: 'MODEL_CACHE_UNAVAILABLE' }); };

/** Trusted finite runner port. Normal admission retains the actual facade's
 * default atomic budget. Recovery reuses its full validators behind independent
 * read-only storage, deny-only budget and deny-only transport capabilities. */
export function createNearAiRunnerPort(options) {
  const normal = createNearAiModel(options);
  const reservationKey = options.reservationKey ?? publicModelReservationKey;
  const repository = { runTransaction: callback => options.repository.runTransaction(tx => callback({
    get: (collection, key) => tx.get(collection, key), create: unavailable, set: unavailable,
  })) };
  const cache = createNearAiModel({ ...options, repository,
    budgetFactory: ({ authorization, jobId }) => Object.freeze({
      contractVersion: 'haldir.model-budget.atomic-release.v1',
      reservationKey: phase => reservationKey(authorization.authorizationId, jobId, phase),
      reserve: async () => false,
    }),
    transportFactory: () => Object.freeze({ transport: unavailable, getReceipt: unavailable, drain: async () => {} }),
  });
  return Object.freeze({ contractVersion: 'haldir.model.runner-recovery.v1',
    propose: input => normal.propose(input),
    async recover(input) {
      try { return await cache.propose(input); }
      catch { return unavailable(); } // Cache absence never proves non-admission.
    },
  });
}
