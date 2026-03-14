FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && cp src/db/schema.sql dist/src/db/schema.sql

FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/src/index.js"]
