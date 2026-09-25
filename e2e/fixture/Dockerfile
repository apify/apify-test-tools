# Shared image of the two root-context Actors (dockerContextDir is the repo root).
FROM apify/actor-node:24

# `--omit=dev` matters: apify-test-tools is a devDependency pointing at a tarball the e2e harness
# drops into vendor/, which is not part of the image. npm skips omitted packages without reading them.
COPY package*.json ./
RUN npm ci --omit=dev --audit=false --no-fund

COPY src ./src

CMD ["node", "src/main.js"]
