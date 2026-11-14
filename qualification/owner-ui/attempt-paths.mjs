export function ownerAttemptPaths(root, selection = 'legacy') {
  const allowed = {
    legacy: '.hermes/proposals/',
    'owner-qualification-02': '.hermes/proposals/attempts/owner-qualification-02/',
  };
  if (typeof selection !== 'string' || !Object.hasOwn(allowed, selection)) {
    throw new Error('Unsupported owner qualification attempt.');
  }
  const directory = new URL(allowed[selection], root);
  return {
    generated: new URL('owner-intent-generated.json', directory),
    approved: new URL('owner-qualification.json', directory),
    signature: new URL('owner-signature.json', directory),
  };
}
