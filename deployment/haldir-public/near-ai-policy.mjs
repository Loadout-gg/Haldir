export const NEAR_AI_ENDPOINT = 'https://cloud-api.near.ai/v1/chat/completions';
export const NEAR_AI_MODEL = 'z-ai/glm-5.3-flash';
export const NEAR_AI_PROFILE = 'near-ai-glm53-thinking512-v1';
export const NEAR_AI_RELEASE = Object.freeze({
  key: 'haldir-near-ai-demo-20261113', maxCostMicros: '1000000',
});
// Expiry is trusted caller input, not a rolling lease or a qualification date.
export function modelAuthorization(authorizationId, expiresAt) {
  return { authorizationId, endpoint: NEAR_AI_ENDPOINT, model: NEAR_AI_MODEL,
    credentialSource: 'application-runtime', billingApproved: true, dataApproved: true,
    expiresAt, maxCalls: 2, maxPromptBytes: 98304,
    maxCompletionTokens: 2048, maxTotalTokens: 210000, timeoutMs: 25000,
    inputRateMicrosPerMillion: '80000', outputRateMicrosPerMillion: '500000',
    maxCostMicros: '50000' };
}
