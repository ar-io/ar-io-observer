# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AR.IO Observer is an Express microservice that provides REST API and CLI tools to run randomized observation reports against AR.IO nodes. It monitors ArNS (Arweave Name System) resolution and gateway performance across the AR.IO network.

## Development Commands

### Essential Commands
- **CLI observation**: `yarn observe` - Generate a single observation report
- **Service mode**: `yarn service` - Start the Express server on port 5050
- **Build**: `yarn build` - Compile TypeScript using `tsconfig.prod.json`
- **Clean**: `yarn clean` - Remove build artifacts

### Code Quality
- **Lint check**: `yarn lint:check` - Run ESLint without fixes
- **Lint fix**: `yarn lint:fix` - Run ESLint with auto-fixes
- **Format check**: `yarn format:check` - Check Prettier formatting
- **Format fix**: `yarn format:fix` - Apply Prettier formatting

### Testing
- **Run tests**: `yarn test` - Execute Mocha test suite
- **Test with coverage**: `yarn test:coverage` - Generate coverage reports
- **CI tests**: `yarn test:ci` - Run tests with JSON output for CI

Test files use `.test.ts` suffix and are discovered in `src/` and `test/` directories using Mocha with ts-node/esm loader.

### Development
- **Watch mode**: `yarn start:watch` - Run service with hot reload via nodemon

## Architecture Overview

### Core Components

1. **Observer** (`src/observer.ts`): Main orchestrator that performs gateway assessments
   - Conducts ownership verification via `/ar-io/info` endpoint
   - Tests ArNS name resolution with data integrity checks  
   - Runs multiple observations and selects best result based on failure rates
   - Uses deterministic shuffling for fair gateway assessment

2. **System Bootstrap** (`src/system.ts`): Dependency injection container
   - Configures all data sources (entropy, epochs, names, hosts)  
   - Sets up report sinks pipeline (filesystem, Arweave, Turbo, contract)
   - Manages wallet authentication and AO network connections

3. **Report Pipeline** (`src/store/pipeline-report-sink.ts`): Multi-stage report processing
   - Validates reports (rejects if >80% gateway failures indicate observer issues)
   - Processes through configurable sinks: logging, filesystem, Arweave/Turbo upload, contract interaction

### Data Sources Architecture

The system uses a pluggable architecture with interfaces defined in `src/types.ts`:

- **Entropy Sources**: Chain-based, cached, random, and composite entropy generation
- **Name Sources**: Contract-based ArNS names, static lists, random selection
- **Host Sources**: Contract-derived gateway lists or static configuration  
- **Epoch Sources**: Contract-based epoch timing and boundaries

### Key Patterns

- **Dependency Injection**: All components configured in `src/system.ts`
- **Interface-based Design**: Core interfaces in `src/types.ts` enable testability
- **Pipeline Processing**: Reports flow through configurable sink chains
- **Entropy-driven**: Deterministic randomness for fair, reproducible assessments
- **Multiple Observations**: Runs 2 observations per report, selects best outcome

## Configuration

Configuration is handled in `src/config.ts` using environment variables with CLI argument overrides. Key settings:

- `OBSERVER_WALLET`: Legacy AO-mode wallet label for report submission. In
  Solana mode this only serves as a display label — actual identities come
  from `SOLANA_KEYPAIR_PATH` / `OBSERVER_KEYPAIR_PATH` / etc.
- `REFERENCE_GATEWAY_HOST`: Trusted gateway for expected resolution results
- `REPORT_DATA_SINK`: Target for report uploads ('turbo' or 'arweave')
- Gateway and name assessment concurrency limits
- Epoch timing and report submission windows

### Solana wallet identities (NETWORK_SOURCE=solana)

**Four protocol-level roles**, each independently configurable. The two
on-chain roles (operator, observer) must be Solana keypairs; the
off-chain **upload** role accepts any of three chains that Turbo
supports (Arweave / Ethereum / Solana). Full resolution rules in
`src/wallet-config.ts` (covered by `wallet-config.test.ts`).

Required: `SOLANA_KEYPAIR_PATH` (operator + cranker signer).

Optional:
- `OBSERVER_KEYPAIR_PATH` — separate `save_observations` signer; must match
  on-chain `Gateway.observer_address` when set.
- `ARWEAVE_UPLOAD_KEY_FILE` / `ARWEAVE_UPLOAD_JWK` — Arweave JWK for
  report uploads. **Top precedence.**
- `ETHEREUM_UPLOAD_PRIVATE_KEY_FILE` / `ETHEREUM_UPLOAD_PRIVATE_KEY` —
  32-byte hex Ethereum key for report uploads. Mid precedence.
- `SOLANA_UPLOAD_KEYPAIR_PATH` — separate Solana key for Solana-signed
  ANS-104 bundle uploads. Lowest explicit priority; falls back to
  observer ?? operator if all upload envs are unset.

Each chain produces a different `arbundles.Signer` (`ArweaveSigner`,
`EthereumSigner`, `SolanaSigner`); `TurboReportSink` is signer-agnostic.

**Conflict policy:** setting envs from more than one upload chain at
once (e.g. `ARWEAVE_UPLOAD_*` plus `ETHEREUM_UPLOAD_*`) is a hard error
at startup — pick exactly one upload chain. Sniff validators
produce friendly errors when material is dropped into the wrong slot
(e.g. an Arweave JWK at `SOLANA_UPLOAD_KEYPAIR_PATH`).

Supported configurations (each tested in `wallet-config.test.ts`):
1. all-Solana single key
2. Solana ops + Arweave JWK upload
3. three Solana keys (op / observer / upload)
4. two Solana keys + Arweave JWK upload
5. two Solana keys + Ethereum upload

### Observation submission (`save_observations` on Solana)

When `SUBMIT_CONTRACT_INTERACTIONS=true` in Solana mode,
`SolanaContractReportSink` (`src/store/solana-contract-report-sink.ts`)
submits observation reports on-chain via `ario_gar::save_observations`.

Flow:
- A SECOND `SolanaARIOWriteable` instance is constructed in `system.ts`,
  signed by the **observer** keypair (NOT the operator/cranker). The
  cranker's `networkContract` keeps the operator signer — distinct
  identities for distinct ix surfaces.
- Each `saveReport(reportInfo)` call: read Epoch state once →
  pre-flight gate → submit if all gates pass.
- Pre-flight gates (no wasted SOL fees on bouncing simulations):
  - **Not prescribed**: observer pubkey not in `epoch.prescribed_observers`
  - **Already observed**: `has_observed` bit set at our slot
  - **Window closed**: `now >= epoch.end_timestamp`
- The on-chain `Observation.report_tx_id` field stores the **raw 32-byte
  hash** (base64url-decoded from the 43-char Arweave TX ID) — lossless
  and round-trippable, so consumers can recover the full TXID for
  permaweb audits.
- `getFailedGatewaySummaryFromReport` (shared with the AO sink) extracts
  the failed-gateway pubkey list; the SDK turns it into a 375-byte
  bitmap matching the registry order.
- After the parent epoch is fully distributed, the cranker's
  `close_observation` loop reclaims the Observation PDA's rent.

Unit tests: `src/store/solana-contract-report-sink.test.ts` covers the
happy path + all three skip gates + missing-reportTxId guard + error
propagation (9 tests).

## Compression Settings

Both `ArweaveReportSink` and `TurboReportSink` use gzip compression with level 9 (maximum compression) to minimize upload size when submitting reports to Arweave L1 and Turbo.

- Files: `src/store/arweave-report-sink.ts` and `src/store/turbo-report-sink.ts`  
- Implementation: `await gzip(reportBuffer, { level: 9 })`

## Important Implementation Details

### Data Integrity Verification
- Uses random range requests for large files (>1MB) with deterministic PRNG
- Compares SHA256 hashes of first 1MB or random byte ranges
- Validates ArNS resolution headers: `x-arns-resolved-id`, `x-arns-ttl-seconds`

### Report Timing
- Reports generated on epoch boundaries with randomized submission timing
- Uses entropy to determine report save timing within safe windows  
- Protects against epoch boundary edge cases with configurable offsets

### Error Handling  
- Pipeline continues on individual sink failures with detailed logging
- Observer failures captured in assessment results rather than throwing
- 80% gateway failure threshold prevents submitting observer-side issues