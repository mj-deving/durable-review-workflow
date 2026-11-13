// Writes results/tests.junit.xml. Bun's junit reporter records the machine's hostname, which does
// not belong in a committed file, so it is blanked.
const out = "results/tests.junit.xml";
const proc = Bun.spawnSync(["bun", "test", "--reporter=junit", `--reporter-outfile=${out}`], { stdout: "inherit", stderr: "inherit" });
const xml = await Bun.file(out).text();
await Bun.write(out, xml.replace(/hostname="[^"]*"/g, 'hostname=""'));
process.exit(proc.exitCode ?? 1);

export {};
