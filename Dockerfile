# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Certificates are rendered SVG -> JPEG by sharp, which draws text with system
# fonts. Alpine ships none, so without these every letter becomes a box.
RUN apk add --no-cache fontconfig ttf-dejavu font-liberation && fc-cache -f
# The schema + config must exist before `npm ci`: its postinstall runs `prisma generate`.
COPY package.json package-lock.json prisma.config.ts ./
COPY --from=build /app/prisma ./prisma
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 3001
# prisma.config.ts sits at the project root, so tsc emits to dist/src/*.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
