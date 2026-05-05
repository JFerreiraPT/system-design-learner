FROM node:22-alpine
WORKDIR /workspace
RUN corepack enable
CMD ["sh", "-c", "pnpm install && pnpm --filter @sdl/web dev --host 0.0.0.0"]
