import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createNotebookStore, parseEntry, serializeEntry } from "../build/local-notebook-service.mjs";

const projectRoot = process.cwd();

test("portable Markdown frontmatter round-trips", () => {
  const meta = {
    id: "entry-0001", sequence: 1, author: "A. Writer", date: null, date_text: "Friday",
    page: null, source_image: "image-0001", region: [0, 0, 1, 1], status: "needs-review",
    transcription_provider: null, transcribed_at: null,
  };
  const parsed = parseEntry(serializeEntry(meta, "# Friday\n\nA faithful line — [unclear: word]\n"));
  assert.deepEqual(parsed.meta, meta);
  assert.match(parsed.body, /faithful line/);
});

async function fixture() {
  const libraryDir = await mkdtemp(join(tmpdir(), "notebook-digitizer-library-"));
  const sourceDir = await mkdtemp(join(tmpdir(), "notebook-digitizer-source-"));
  const imagePath = join(sourceDir, "sample.png");
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#f4ecd8" } }).png().toFile(imagePath);
  let codexCalls = 0;
  const store = createNotebookStore(projectRoot, {
    libraryDir,
    visionRunner: async () => "Noisy line suggestion",
    codexRunner: async ({ mode, onProgress }) => {
      codexCalls += 1;
      onProgress?.({ stage: "codex", message: `Test ${mode} pass completed.` });
      return {
        markdown: mode === "extra-careful" ? "# Verified\n\nFaithful transcription.\n" : "# Draft\n\nFaithful transcription.\n",
        date_text: "Friday", date_iso: null, warnings: [],
      };
    },
    revealFile: async () => {},
  });
  return { store, imagePath, libraryDir, getCodexCalls: () => codexCalls };
}

test("import archives an original and creates one Markdown file per page", async () => {
  const { store, imagePath, libraryDir } = await fixture();
  const first = await store.importFile(imagePath, "Notebook page.png", "spread");
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.image.entryIds, ["entry-0001", "entry-0002"]);
  const index = await store.list();
  assert.equal(index.images.length, 1);
  assert.equal(index.entries.length, 2);
  assert.deepEqual(index.entries.map((entry) => entry.page), ["left", "right"]);
  assert.match(await readFile(join(libraryDir, "entries", "entry-0001.md"), "utf8"), /source_image: "image-0001"/);
  const duplicate = await store.importFile(imagePath, "Second name.png", "single");
  assert.equal(duplicate.duplicate, true);
  assert.equal((await store.list()).entries.length, 2);
});

test("one page per photo is the default and does not require a left/right side", async () => {
  const { store, imagePath, libraryDir } = await fixture();
  const imported = await store.importFile(imagePath, "loose notebook page.png");
  assert.deepEqual(imported.image.entryIds, ["entry-0001"]);
  assert.equal(imported.image.layout, "single");
  const opened = await store.get("entry-0001");
  assert.equal(opened.meta.page, null);
  assert.match(await readFile(join(libraryDir, "entries", "entry-0001.md"), "utf8"), /page: null/);
});

test("an existing photo can switch between one and two pages without losing transcription text", async () => {
  const { store, imagePath } = await fixture();
  const imported = await store.importFile(imagePath, "adjustable page.png");
  const original = await store.get("entry-0001");
  await store.update("entry-0001", {
    revision: original.revision, meta: { ...original.meta, author: "Writer", status: "reviewed" }, body: "Original whole-page draft\n",
  });

  const split = await store.changeImageLayout(imported.image.id, "spread");
  assert.equal(split.status, 200);
  assert.deepEqual(split.data.image.entryIds, ["entry-0001", "entry-0002"]);
  const left = await store.get("entry-0001");
  const right = await store.get("entry-0002");
  assert.equal(left.meta.page, "left");
  assert.equal(left.meta.status, "needs-review");
  assert.match(left.body, /Original whole-page draft/);
  assert.equal(right.meta.page, "right");
  assert.equal(right.body, "");

  const savedLeft = await store.update("entry-0001", {
    revision: left.revision, meta: { ...left.meta, status: "reviewed" }, body: "Left half\n",
  });
  assert.equal(savedLeft.status, 200);
  const savedRight = await store.update("entry-0002", {
    revision: right.revision, meta: { ...right.meta, author: "Writer", status: "reviewed" }, body: "Right half\n",
  });
  assert.equal(savedRight.status, 200);

  const combined = await store.changeImageLayout(imported.image.id, "single");
  assert.equal(combined.status, 200);
  assert.deepEqual(combined.data.image.entryIds, ["entry-0001"]);
  const merged = await store.get("entry-0001");
  assert.equal(merged.meta.page, null);
  assert.equal(merged.meta.status, "reviewed");
  assert.match(merged.body, /Left half\n\nRight half/);
  assert.equal(await store.get("entry-0002"), null);
  assert.match(await readFile(join(combined.data.archivePath, "entry-0002.md"), "utf8"), /Right half/);

  await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#e2d6bd" } }).png().toFile(imagePath);
  const next = await store.importFile(imagePath, "another page.png");
  assert.deepEqual(next.image.entryIds, ["entry-0003"]);
});

test("saves are atomic, protect revisions, and preserve immutable source metadata", async () => {
  const { store, imagePath } = await fixture();
  await store.importFile(imagePath, "sample.png", "single");
  const opened = await store.get("entry-0001");
  const saved = await store.update("entry-0001", {
    revision: opened.revision,
    meta: { ...opened.meta, author: "Writer", date: "2020-01-02", date_text: "2 January", status: "reviewed", source_image: "image-9999" },
    body: "Corrected body\n",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.meta.source_image, "image-0001");
  assert.equal(saved.data.meta.status, "reviewed");
  assert.equal((await store.update("entry-0001", { revision: opened.revision, meta: saved.data.meta, body: "stale" })).status, 409);
});

test("extra-careful Codex transcription runs two passes and remains needs-review", async () => {
  const { store, imagePath, getCodexCalls } = await fixture();
  await store.importFile(imagePath, "sample.png", "single");
  const progress = [];
  const result = await store.transcribe("entry-0001", "extra-careful", (event) => progress.push(event));
  assert.equal(result.status, 200);
  assert.equal(getCodexCalls(), 2);
  assert.equal(result.data.meta.status, "needs-review");
  assert.equal(result.data.meta.transcription_provider, "codex-extra-careful");
  assert.match(result.data.body, /Verified/);
  assert.ok(progress.some((event) => /pass 1 of 2/i.test(event.message)));
  assert.ok(progress.some((event) => /pass 2 of 2/i.test(event.message)));
  assert.ok(progress.some((event) => /Test extra-careful pass completed/.test(event.message)));
  assert.ok(progress.some((event) => /saving Markdown/i.test(event.message)));
});

test("the real provider invokes Codex non-interactively with a schema and read-only sandbox", async () => {
  if (process.platform === "win32") return;
  const libraryDir = await mkdtemp(join(tmpdir(), "notebook-digitizer-cli-library-"));
  const sourceDir = await mkdtemp(join(tmpdir(), "notebook-digitizer-cli-source-"));
  const imagePath = join(sourceDir, "sample.png");
  await sharp({ create: { width: 600, height: 400, channels: 3, background: "#eee6d3" } }).png().toFile(imagePath);
  const fakeCodex = join(sourceDir, "fake-codex");
  await writeFile(fakeCodex, `#!${process.execPath}\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (!args.includes("--sandbox") || args[args.indexOf("--sandbox") + 1] !== "read-only") process.exit(12);\nif (!args.includes("--output-schema") || !args.includes("--ephemeral") || !args.includes("--image") || !args.includes("--json")) process.exit(13);\nconst output = args[args.indexOf("--output-last-message") + 1];\nprocess.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Comparing each handwritten line." } }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 42 } }) + "\\n");\nfs.writeFileSync(output, JSON.stringify({ markdown: "# CLI draft\\n", date_text: null, date_iso: null, warnings: [] }));\n`, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = fakeCodex;
  try {
    const store = createNotebookStore(projectRoot, { libraryDir, visionRunner: async () => "hint" });
    await store.importFile(imagePath, "sample.png", "single");
    const progress = [];
    const result = await store.transcribe("entry-0001", "careful", (event) => progress.push(event));
    assert.equal(result.status, 200);
    assert.match(result.data.body, /CLI draft/);
    assert.ok(progress.some((event) => /Codex session started/.test(event.message)));
    assert.ok(progress.some((event) => /Comparing each handwritten line/.test(event.message)));
    assert.ok(progress.some((event) => /42 output tokens/.test(event.message)));
  } finally {
    if (previous == null) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
});

test("rotation and asset resolution reject unsafe values", async () => {
  const { store, imagePath } = await fixture();
  const imported = await store.importFile(imagePath, "sample.png", "single");
  assert.equal((await store.rotateImage(imported.image.id, 90)).status, 200);
  assert.equal((await store.rotateImage(imported.image.id, 45)).status, 400);
  assert.equal((await store.changeImageLayout(imported.image.id, "booklet")).status, 400);
  assert.equal((await store.changeImageLayout("image-9999", "spread")).status, 404);
  assert.equal(store.assetPath("pages", "../private.jpg"), null);
  assert.equal(store.assetPath("unknown", "image-0001.jpg"), null);
});
