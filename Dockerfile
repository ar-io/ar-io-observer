ARG NODE_VERSION=22.13.0

FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Build
WORKDIR /app
RUN apt-get update && apt-get install build-essential python3 -y
COPY . .
RUN yarn install \
    && yarn build \
    && rm -rf node_modules \
    && yarn install --production

# Runtime
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /app

# Copy build files
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docs ./docs/
COPY --from=builder /app/dist ./dist/
COPY ./healthcheck.sh /app/healthcheck.sh

# Expose port and add healthcheck
EXPOSE 5050
HEALTHCHECK CMD /bin/sh healthcheck.sh

# Add labels
LABEL org.opencontainers.image.title="ar.io - Observer Service"

# Start the server
CMD ["./dist/service.js"]
