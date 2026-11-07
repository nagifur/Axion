import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { checkSubmissionZip } from "../scripts/import-submission.mjs";

const enc = (text) => new TextEncoder().encode(text);
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0);

async function zipOf(entries) {
  const zip = new JSZip();
  for (const [path, data] of Object.entries(entries)) zip.file(path, data);
  return zip.generateAsync({ type: "uint8array" });
}

test("accepts a well-formed submission", async () => {
  const { files, problems } = await checkSubmissionZip(
    await zipOf({
      "src/content/entities/new-entity.md": enc("---\ntitle: T\n---\nHello"),
      "src/assets/images/new-entity/profile.png": png,
      "src/assets/images/new-entity/1.jpeg": Uint8Array.of(0xff, 0xd8, 0xff, 0),
    }),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(files.map((file) => file.path), [
    "src/content/entities/new-entity.md",
    "src/assets/images/new-entity/profile.png",
    "src/assets/images/new-entity/1.jpeg",
  ]);
});

test("rejects paths outside the expected layout", async () => {
  const { problems } = await checkSubmissionZip(
    await zipOf({
      "src/content/entities/x.md": "ok",
      "../../evil.md": "x",
      "src/pages/index.astro": "x",
      "src/assets/images/x/run.sh": "x",
      ".github/workflows/deploy.yml": "x",
    }),
  );
  assert.equal(problems.length, 4);
});

test("rejects unsafe markdown and fake images", async () => {
  const { problems } = await checkSubmissionZip(
    await zipOf({
      "src/content/entities/x.md": "<script>alert(1)</script>",
      "src/assets/images/x/1.png": "not really a png",
    }),
  );
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /HTML is not allowed/);
  assert.match(problems.join("\n"), /not a png image/);
});

test("requires exactly one markdown file", async () => {
  const { problems } = await checkSubmissionZip(await zipOf({ "src/assets/images/x/1.png": png }));
  assert.deepEqual(problems, ["The zip must contain exactly one markdown file."]);
});

test("refuses to overwrite an existing page without --overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "import-test-"));
  try {
    const zipPath = join(dir, "a-071.zip");
    await writeFile(zipPath, await zipOf({ "src/content/entities/a-071.md": "Replaced bio" }));
    assert.throws(
      () => execFileSync("node", ["scripts/import-submission.mjs", zipPath], { stdio: "pipe" }),
      (error) => /already exist[\s\S]*src\/content\/entities\/a-071\.md/.test(error.stderr.toString()),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
