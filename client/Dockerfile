# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine AS production
WORKDIR /usr/src/app
ENV NODE_ENV=production

# node:20-alpine already ships a non-root "node" user (uid 1000) - run
# as that instead of root, matching app/Dockerfile's hardening.
RUN chown -R node:node /usr/src/app
USER node

COPY --chown=node:node --from=builder /usr/src/app/public ./public
COPY --chown=node:node --from=builder /usr/src/app/.next/standalone ./
COPY --chown=node:node --from=builder /usr/src/app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
