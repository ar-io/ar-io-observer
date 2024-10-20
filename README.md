# ar-io-observer

An Express microservice that provides REST API and CLI tools to run randomized
observation reports against ar.io nodes.

## Getting Started

Requirements:

- `nvm`
- `yarn`

### Running Locally

#### CLI

Generating a report:

- `nvm use`
- `yarn observe` 

#### Service

Starting the service:

- `nvm use`
- `yarn service` 

You can check the service is running by running the command:

```shell
curl localhost:5050/ar-io/observer/healthcheck
{"uptime":2.555423702,"date":"2023-09-14T21:24:27.677Z","message":"Welcome to the Permaweb."}
```

The current report is accessible at the `/ar-io/observer/reports/current`
endpoint.

### Docker

Build and run the container:

```shell
docker build --build-arg NODE_VERSION=$(cat .nvmrc |cut -c2-8) --build-arg NODE_VERSION_SHORT=$(cat .nvmrc |cut -c2-3) . -t ar-io-observer
docker run -p 5050:5050 ar-io-observer
```
