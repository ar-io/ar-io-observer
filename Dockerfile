ARG NODE_VERSION=18.18.0
ARG NODE_VERSION_SHORT=18

FROM node:${NODE_VERSION}-bullseye-slim AS builder

# Build
WORKDIR /app
RUN apt-get update && apt-get install build-essential python3 -y
COPY . .
RUN yarn install \
    && yarn build \
    && rm -rf node_modules \
    && yarn install --production

# Runtime
FROM gcr.io/distroless/nodejs${NODE_VERSION_SHORT}-debian11
WORKDIR /app

# Add sh for healtcheck script
COPY --from=busybox:1.35.0-uclibc /bin/sh /bin/sh

# Copy build files
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/docs ./docs/
COPY --from=builder /app/dist ./dist/

# Expose port and add healthcheck
EXPOSE 5000
HEALTHCHECK CMD curl --fail http://localhost:5000/healthcheck || exit 1

# Add labels
LABEL org.opencontainers.image.title="ar.io - Observer Service"

# Start the server
CMD ["./dist/service.js"]
