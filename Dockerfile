FROM oven/bun:latest

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./

# Install all dependencies (needed for build and migrations)
RUN bun install --frozen-lockfile

# Copy codebase
COPY . .

# Build NestJS and engagement scripts
RUN bun run build

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["sh", "-c", "bun scripts/clean-database.ts && bun run db:migrate:all && bun dist/src/main.js"]
