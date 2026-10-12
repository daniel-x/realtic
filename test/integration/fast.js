// Fast integration suite (plan section 14.7): DIR-1 to DIR-3, REL-1 and REL-5 in the mixed
// pairing, with the library's real timings.
process.env.REALTIC_PAIRINGS ??= "mixed";
process.env.TEST_TIME_SCALE_FACTOR ??= "1";
const pattern = /DIR-[123] |REL-[15] /;
const { run } = await import("node:test");
const { spec } = await import("node:test/reporters");
const stream = run({ files: [new URL("./direct/dir.test.js", import.meta.url).pathname, new URL("./relay/rel.test.js", import.meta.url).pathname], concurrency: 1, testNamePatterns: [pattern] });
stream.on("test:fail", () => (process.exitCode = 1));
stream.compose(spec).pipe(process.stdout);
