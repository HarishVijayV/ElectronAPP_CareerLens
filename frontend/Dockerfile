# Not wired into infra/docker-compose.yml's default services on purpose — for day-to-day
# development, `npm run dev` (hot reload) is faster than rebuilding a container on every
# change. This Dockerfile is what Phase 7's CI/CD (docs/ROADMAP.md) builds and ships.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# NEXT_PUBLIC_* is inlined by `next build`, not read at runtime, so the API URL has to be
# known HERE — a container env var set later is ignored. The default matches compose (the
# browser talks to the host's mapped gateway port); Kubernetes overrides it with the
# ingress host, because in-cluster the gateway is behind careerlens.local/api instead.
#   docker build --build-arg NEXT_PUBLIC_API_BASE_URL=http://careerlens.local:8080/api .
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
CMD ["npm", "start"]
