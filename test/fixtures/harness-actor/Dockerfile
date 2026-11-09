FROM apify/actor-node:22

COPY package*.json ./
# `packages/` would hold tarballs pinned by `ActorSource.pin`; this fixture has none.
RUN npm --quiet set progress=false && npm install --omit=dev --no-audit

COPY . ./

CMD npm start --silent
