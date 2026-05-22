/**
 * Subprocess entry point for loading a circuit file as JSON.
 *
 * Spawned by the CLI with the project root as cwd so that the circuit file's
 * imports resolve from its own location via standard node_modules traversal.
 * The CLI then receives the serialized workflow on stdout.
 *
 * Usage: bun <this-file> <absoluteCircuitPath>
 */
const circuitPath = process.argv[2];
if (!circuitPath) {
  process.stderr.write("Usage: circuit-loader.ts <circuitPath>\n");
  process.exit(1);
}

const m = await import(circuitPath);
const raw = m.default ?? m.workflow;
if (!raw) {
  process.stderr.write(`No default export or 'workflow' export in ${circuitPath}\n`);
  process.exit(1);
}

const wf = typeof raw.build === "function" ? raw.build() : raw;
process.stdout.write(JSON.stringify(wf));
