# Official Node supplier image; Linux amd64 manifest, not a Haldir image digest.
FROM node:26.13.1-bookworm-slim@sha256:18a166e2d50578afe933434857ed2d9059bd1aa398a223e9c89eb4302354f079
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN node --input-type=module -e "import assert from 'node:assert/strict'; assert.equal(process.versions.node,'26.13.1'); assert.equal(process.platform,'linux'); assert.equal(process.arch,'x64')" \
 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY src/server/wallet-auth-http.mjs src/server/wallet-session.mjs src/server/near-owner-keys.mjs ./src/server/
COPY deployment/haldir-preview/main.mjs deployment/haldir-preview/server.mjs deployment/haldir-preview/firestore-repository.mjs ./deployment/haldir-preview/
COPY deployment/haldir-preview/ui-build-receipt.json ./deployment/haldir-preview/
COPY deployment/haldir-preview/ui/ ./deployment/haldir-preview/ui/
USER node
EXPOSE 8080
CMD ["node", "deployment/haldir-preview/main.mjs"]
