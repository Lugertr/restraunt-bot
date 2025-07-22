FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci --include=dev

COPY src ./src

RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

RUN npm ci --omit=dev

CMD ["node", "dist/index.js"]