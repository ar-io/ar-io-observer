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

## IPFS-target ArNS names

ArNS names can point at IPFS content (`AntRecord.target_protocol = 1`, a CID). The
observer assesses these **trustlessly**: a name whose reference-resolved
`resolvedId` is a valid CID is fetched from the target gateway's `?format=raw`
endpoint and the returned block is verified against the CID's multihash — no trust
in a reference gateway's bytes.

Scoring per IPFS name:

- **PASS** — the served raw block hashes to the CID.
- **FAIL** — the gateway serves 200 bytes that do **not** hash to the CID (a
  proven-wrong answer). The decision never trusts the gateway's own
  `x-arns-resolved-id` header.
- **NEUTRAL** (excluded from the pass/fail denominator) — not served / non-200 /
  timeout / non-`application/vnd.ipld.raw` / empty body / unverifiable multihash.
  A gateway is never failed for availability, and a non-IPFS gateway (which 404s
  the name) is neutral, not failed.

This runs on the live `ContinuousObserver → GatewayAssessor` path; the report
`formatVersion` is `3` (adds `protocol` + `outcome`). On-chain submission is
unchanged (still a per-gateway pass/fail bitmap) — no contract change.

Relevant configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `IPFS_ASSESSMENT_TIMEOUT_MS` | `35000` | Request/response deadline for the `?format=raw` fetch. Set `>=` the gateway's IPFS retrieval budget so slow-but-valid cold-IPFS content isn't misclassified. |
| `IPFS_ASSESSMENT_LOCAL_ONLY` | `false` | Holding-probe ramp. When `true`, the `?format=raw` probe sends `X-Ar-Io-Local-Only: true`, so a PASS proves the gateway **holds** the content locally (a proxy 404s → NEUTRAL, never FAIL). This is the serving→holding lever — it rewards holding without penalising a not-yet-holding gateway. Requires the gateway fleet to support local-only serve (ar-io-node IPFS peer-fetch). Flipping it on is a governance/ramp decision; ships dark. |
| `REFERENCE_GATEWAY_HOSTS` | `turbo-gateway.com,ar-io.net` | Gateways used to resolve the name→CID binding. **Recommended:** point this at your **own** co-located gateway configured to resolve ArNS **on-demand** (from chain) — then the binding is authoritative (chain-derived) and local rather than trusting external gateways. When deployed via the ar-io-node compose this defaults to the node's `ARNS_ROOT_HOST`. |

Multi-block (UnixFS/dag-pb) CIDs are verified at the **DAG root block** today; full
leaf/DAG sampling (the analog of Arweave chunk/offset proofs) is a planned
follow-up.

### Docker

Build and run the container:

```shell
docker build --build-arg NODE_VERSION=$(cat .nvmrc |cut -c2-8) --build-arg NODE_VERSION_SHORT=$(cat .nvmrc |cut -c2-3) . -t ar-io-observer
docker run -p 5050:5050 ar-io-observer
```
