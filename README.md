# ar-io-observer

Express microservice that provides REST API to run randomized observation reports against ar.io nodes.

## Getting Started

Requirements:

- `nvm`
- `yarn`

### Running Locally

Starting the service:

- `nvm use`
- `yarn`
- `yarn server`

You can check the service is running by running the command:

```shell
curl localhost:3000/healthcheck
{"uptime":2.555423702,"date":"2023-09-14T21:24:27.677Z","message":"Welcome to the Permaweb."}
```

### Docker

Build and run the container:

```shell
docker build --build-arg NODE_VERSION=$(cat .nvmrc |cut -c2-8) --build-arg NODE_VERSION_SHORT=$(cat .nvmrc |cut -c2-3) . -t ar-io-observer
docker run -p 3000:3000 ar-io-observer
```
