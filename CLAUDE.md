# AR.IO Observer - Claude Context

## Compression Settings

Both `ArweaveReportSink` and `TurboReportSink` use gzip compression with level 9 (maximum compression) to minimize upload size when submitting reports to Arweave L1 and Turbo.

- Files: `src/store/arweave-report-sink.ts` and `src/store/turbo-report-sink.ts`
- Implementation: `await gzip(reportBuffer, { level: 9 })`

## Build Commands

- **Lint**: `yarn lint:check` - Runs ESLint
- **Fix lint issues**: `yarn lint:fix`
- **Build**: `yarn build` - Builds TypeScript project
- **Format check**: `yarn format:check`
- **Format fix**: `yarn format:fix`