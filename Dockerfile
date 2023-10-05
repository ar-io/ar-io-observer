ARG NODE_VERSION=18.17.1
ARG NODE_VERSION_SHORT=18

FROM node:${NODE_VERSION}-bullseye-slim AS builder

# Build
WORKDIR /usr/src/app
COPY . .
RUN yarn && yarn build

# Extract dist
FROM gcr.io/distroless/nodejs${NODE_VERSION_SHORT}-debian11
WORKDIR /usr/src/app

# Add shell
COPY --from=busybox:1.35.0-uclibc /bin/sh /bin/sh
COPY --from=busybox:1.35.0-uclibc /bin/addgroup /bin/addgroup
COPY --from=busybox:1.35.0-uclibc /bin/adduser /bin/adduser
COPY --from=busybox:1.35.0-uclibc /bin/chown /bin/chown

# Create user
RUN addgroup -g 1000 node \
  && adduser -u 1000 -G node -s /bin/sh -D node
RUN chown -R node ./
USER node

# Copy build files
COPY --from=builder /usr/src/app/node_modules ./node_modules/
COPY --from=builder /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/docs ./docs/
COPY --from=builder /usr/src/app/dist ./dist/

# Expose port and add healthcheck
EXPOSE 3000
HEALTHCHECK CMD curl --fail http://localhost:3000/healthcheck || exit 1

# Add labels
LABEL org.opencontainers.image.title="ar.io - Observer Service"

# Start the server
CMD ["./dist/service.js"]
