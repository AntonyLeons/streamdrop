# Use the official Bun image
FROM oven/bun:alpine

WORKDIR /app

# Set production environment
ENV NODE_ENV="production"
ENV PORT=3000

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --frozen-lockfile --production

# Copy application code
COPY src ./src
COPY public ./public
COPY templates ./templates

# Expose the application port
EXPOSE 3000

# Start the server
CMD ["bun", "run", "src/server.ts"]