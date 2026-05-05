FROM node:22-alpine
WORKDIR /workspace
RUN corepack enable
CMD ["sh", "-c", "pnpm install && pnpm --filter @sdl/api dev"]
