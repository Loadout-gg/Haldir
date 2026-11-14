// Package-owned activation record. No environment, browser, model, file locator,
// module loader or default credentials. Replace ONLY after owner review of the
// complete immutable binding and live gates; absence/partial data never activates.
export const PRODUCTION_BINDING = Object.freeze({
  schemaVersion: 'haldir.production-binding.v1', state: 'closed',
});
