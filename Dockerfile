FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .
RUN npm run build

USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "cloudrun/server.mjs"]
