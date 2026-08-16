import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import Busboy from "busboy";
import sharp from "sharp";

const execFile = promisify(execFileCallback);
const STATUSES = new Set(["needs-review", "reviewed"]);
const PAGES = new Set(["single", "left", "right"]);
const IMAGE_EXTENSIONS = new Set([".heic", ".heif", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);

function inside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}${sep}`);
}

function revisionFor(content) {
  return createHash("sha256").update(content).digest("hex");
}

function yamlValue(value) {
  return value == null || value === "" ? "null" : JSON.stringify(value);
}

function scalar(value) {
  if (value === "null" || value === "~") return null;
  try { return JSON.parse(value); } catch { return value; }
}

export function parseEntry(content) {
  if (!content.startsWith("---\n")) throw new Error("Entry is missing YAML frontmatter");
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("Entry frontmatter is not closed");
  const meta = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([a-z_]+):(?:\s*(.*))?$/);
    if (match) meta[match[1]] = scalar(match[2] || "null");
  }
  return { meta, body: content.slice(end + 5) };
}

export function serializeEntry(meta, body) {
  return [
    "---",
    `id: ${yamlValue(meta.id)}`,
    `sequence: ${Number(meta.sequence)}`,
    `author: ${yamlValue(meta.author)}`,
    `date: ${yamlValue(meta.date)}`,
    `date_text: ${yamlValue(meta.date_text)}`,
    `page: ${yamlValue(meta.page)}`,
    `source_image: ${yamlValue(meta.source_image)}`,
    `region: ${yamlValue(meta.region)}`,
    `status: ${yamlValue(meta.status)}`,
    `transcription_provider: ${yamlValue(meta.transcription_provider)}`,
    `transcribed_at: ${yamlValue(meta.transcribed_at)}`,
    "---",
    String(body || "").replace(/^\n+/, ""),
  ].join("\n");
}

function validateMeta(meta) {
  if (!/^entry-\d{4,}$/.test(String(meta.id))) throw new Error("Invalid entry id");
  if (!Number.isInteger(Number(meta.sequence)) || Number(meta.sequence) < 1) throw new Error("Invalid sequence");
  if (meta.author != null && (typeof meta.author !== "string" || meta.author.length > 100)) throw new Error("Invalid author");
  if (meta.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(meta.date))) throw new Error("Dates must use YYYY-MM-DD");
  if (meta.date_text != null && (typeof meta.date_text !== "string" || meta.date_text.length > 160)) throw new Error("Invalid written date");
  if (meta.page != null && !PAGES.has(meta.page)) throw new Error("Invalid page position");
  if (!/^image-\d{4,}$/.test(String(meta.source_image))) throw new Error("Invalid source image");
  if (!Array.isArray(meta.region) || meta.region.length !== 4 || !meta.region.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("Invalid page region");
  if (!STATUSES.has(meta.status)) throw new Error("Invalid status");
}

function padId(prefix, value) {
  return `${prefix}-${String(value).padStart(4, "0")}`;
}

function nextEntryNumber(book, entries) {
  const ids = [
    ...entries.map((entry) => entry.meta.id),
    ...book.images.flatMap((image) => image.entryIds || []),
    ...(book.retiredEntryIds || []),
  ];
  return ids.reduce((highest, id) => Math.max(highest, Number(String(id).split("-").at(-1)) || 0), 0) + 1;
}

function safeExtension(name) {
  const extension = extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`${basename(name)} is not a supported image`);
  return extension === ".jpeg" ? ".jpg" : extension;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function atomicText(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFile(command, args, { timeout: options.timeout || 120_000, maxBuffer: 20_000_000 });
  return { stdout, stderr };
}

async function makeDerivatives(source, display, thumbnail) {
  try {
    await sharp(source, { limitInputPixels: false }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(display);
  } catch (error) {
    if (process.platform !== "darwin") throw new Error(`This system could not decode ${basename(source)}. HEIC files may require libheif. ${error.message}`);
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "2400", source, "--out", display]);
  }
  await sharp(display).resize({ width: 440, height: 440, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumbnail);
}

async function makeCrop(display, cropPath, region) {
  const metadata = await sharp(display).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const [x, y, w, h] = region;
  const left = Math.max(0, Math.min(width - 1, Math.round(x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(y * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(w * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(h * height)));
  await sharp(display).extract({ left, top, width: cropWidth, height: cropHeight }).jpeg({ quality: 95 }).toFile(cropPath);
}

async function locateCodex() {
  if (process.env.CODEX_BIN) {
    await access(process.env.CODEX_BIN);
    return process.env.CODEX_BIN;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await run(finder, ["codex"], { timeout: 5_000 });
    const path = stdout.trim().split(/\r?\n/)[0];
    if (path) return path;
  } catch {}
  const macApp = "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (process.platform === "darwin" && existsSync(macApp)) return macApp;
  return null;
}

function codexEventMessage(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "thread.started") return "Codex session started.";
  if (event.type === "turn.started") return "Codex is reading the handwriting.";
  if (event.type === "turn.completed") {
    const tokens = Number(event.usage?.output_tokens || 0);
    return tokens ? `Codex pass completed · ${tokens.toLocaleString()} output tokens.` : "Codex pass completed.";
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return event.error?.message || event.message || "Codex reported an error.";
  }
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  if (event.type === "item.started" && item.type === "reasoning") return "Analyzing the page line by line…";
  if (event.type === "item.completed" && item.type === "reasoning") {
    const text = String(item.text || item.summary || "").trim();
    return text ? `Codex: ${text.slice(0, 600)}` : "Handwriting analysis completed.";
  }
  if (event.type === "item.completed" && item.type === "agent_message") return "Codex produced a structured draft.";
  if (event.type === "item.started" && item.type === "command_execution") return "Codex is inspecting the supplied page image.";
  return null;
}

async function spawnCodex(command, args, prompt, onProgress = () => {}, timeout = 15 * 60_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const emitStdoutLines = (final = false) => {
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = final ? "" : lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = codexEventMessage(JSON.parse(line));
          if (message) onProgress({ stage: "codex", message });
        } catch {
          onProgress({ stage: "codex", message: line.trim().slice(0, 600) });
        }
      }
    };
    const emitStderrLines = (final = false) => {
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = final ? "" : lines.pop() || "";
      for (const line of lines) {
        const message = line.trim();
        if (message) onProgress({ stage: "codex", message: message.slice(0, 600) });
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error("Codex transcription timed out"));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;
      emitStdoutLines();
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrBuffer += text;
      emitStderrLines();
    });
    child.on("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (stdoutBuffer) {
        stdoutBuffer += "\n";
        emitStdoutLines(true);
      }
      if (stderrBuffer) {
        stderrBuffer += "\n";
        emitStderrLines(true);
      }
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(stderr.trim() || `Codex exited with status ${code}`));
    });
    child.stdin.end(prompt);
  });
}

function entrySummary(entry) {
  const firstLine = entry.body.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) || "Empty transcription";
  return {
    ...entry.meta,
    filename: entry.name,
    preview: firstLine.slice(0, 100),
    hasContent: Boolean(entry.body.trim()),
    uncertaintyCount: (entry.body.match(/\[(?:unclear|illegible)(?::[^\]]*)?\]/gi) || []).length,
  };
}

export function createNotebookStore(projectRoot, options = {}) {
  const libraryDir = resolve(options.libraryDir || process.env.NOTEBOOK_LIBRARY || join(homedir(), "Documents", "Notebook Digitizer Library"));
  const manifestPath = join(libraryDir, "notebook.json");
  const originalsDir = join(libraryDir, "originals");
  const displaysDir = join(libraryDir, "derivatives", "pages");
  const thumbsDir = join(libraryDir, "derivatives", "thumbnails");
  const cropsDir = join(libraryDir, "derivatives", "crops");
  const entriesDir = join(libraryDir, "entries");
  const entryArchiveDir = join(entriesDir, ".layout-archive");
  const jobsDir = join(libraryDir, ".jobs");
  const promptPath = join(projectRoot, "transcription", "prompt.md");
  const schemaPath = join(projectRoot, "transcription", "transcription.schema.json");
  let initialized = false;

  async function init() {
    if (initialized) return;
    await Promise.all([libraryDir, originalsDir, displaysDir, thumbsDir, cropsDir, entriesDir, entryArchiveDir, jobsDir].map((dir) => mkdir(dir, { recursive: true })));
    try { await access(manifestPath); }
    catch {
      await atomicJson(manifestPath, { version: 1, title: "My Notebook", createdAt: new Date().toISOString(), images: [] });
    }
    initialized = true;
  }

  async function manifest() {
    await init();
    return JSON.parse(await readFile(manifestPath, "utf8"));
  }

  async function entryFiles() {
    await init();
    return (await readdir(entriesDir)).filter((name) => /^entry-\d{4,}\.md$/.test(name)).sort();
  }

  async function allEntries() {
    const result = [];
    for (const name of await entryFiles()) {
      const content = await readFile(join(entriesDir, name), "utf8");
      result.push({ name, content, ...parseEntry(content) });
    }
    return result.sort((a, b) => Number(a.meta.sequence) - Number(b.meta.sequence));
  }

  async function findEntry(id) {
    if (!/^entry-\d{4,}$/.test(id)) return null;
    const path = join(entriesDir, `${id}.md`);
    if (!inside(entriesDir, path)) return null;
    try {
      const content = await readFile(path, "utf8");
      return { path, name: basename(path), content, ...parseEntry(content) };
    } catch { return null; }
  }

  async function codexStatus() {
    if (options.codexRunner) return { available: true, version: "test runner" };
    const path = await locateCodex();
    if (!path) return { available: false, version: null, message: "Install Codex or set CODEX_BIN." };
    try {
      const { stdout } = await run(path, ["--version"], { timeout: 8_000 });
      return { available: true, version: stdout.trim(), path };
    } catch (error) {
      return { available: false, version: null, message: error.message };
    }
  }

  async function list() {
    const [book, entries, codex] = await Promise.all([manifest(), allEntries(), codexStatus()]);
    return {
      notebook: { title: book.title, libraryPath: libraryDir },
      images: book.images.sort((a, b) => a.sequence - b.sequence),
      entries: entries.map(entrySummary),
      codex,
      visionAvailable: process.platform === "darwin" && existsSync("/usr/bin/swift"),
    };
  }

  async function get(id) {
    const entry = await findEntry(id);
    if (!entry) return null;
    return { meta: entry.meta, body: entry.body, filename: entry.name, revision: revisionFor(entry.content) };
  }

  async function update(id, payload) {
    const entry = await findEntry(id);
    if (!entry) return { status: 404, error: "Entry not found" };
    if (payload.revision !== revisionFor(entry.content)) return { status: 409, error: "This page changed on disk. Reload it before saving." };
    const meta = {
      ...entry.meta,
      author: payload.meta?.author || null,
      date: payload.meta?.date || null,
      date_text: payload.meta?.date_text || null,
      status: payload.meta?.status,
    };
    validateMeta(meta);
    const content = serializeEntry(meta, String(payload.body || ""));
    const temporary = `${entry.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, entry.path);
    return { status: 200, data: { meta, body: String(payload.body || ""), filename: entry.name, revision: revisionFor(content) } };
  }

  async function importFile(sourcePath, originalName, layout = "single") {
    await init();
    if (!inside(resolve(sourcePath, ".."), sourcePath)) throw new Error("Invalid source path");
    const extension = safeExtension(originalName);
    const checksum = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const book = await manifest();
    const duplicate = book.images.find((image) => image.checksum === checksum);
    if (duplicate) return { duplicate: true, image: duplicate };
    const entries = await allEntries();
    const imageSequence = book.images.reduce((highest, image) => Math.max(highest, image.sequence), 0) + 1;
    let entrySequence = entries.reduce((highest, entry) => Math.max(highest, Number(entry.meta.sequence)), 0) + 1;
    let entryNumber = nextEntryNumber(book, entries);
    const imageId = padId("image", imageSequence);
    const archivedName = `${imageId}${extension}`;
    const original = join(originalsDir, archivedName);
    const display = join(displaysDir, `${imageId}.jpg`);
    const thumbnail = join(thumbsDir, `${imageId}.jpg`);
    await copyFile(sourcePath, original);
    await makeDerivatives(original, display, thumbnail);
    const regions = layout === "single"
      ? [{ page: null, region: [0, 0, 1, 1] }]
      : [
          { page: "left", region: [0, 0, 0.5, 1] },
          { page: "right", region: [0.5, 0, 0.5, 1] },
        ];
    const entryIds = [];
    for (const item of regions) {
      const entryId = padId("entry", entryNumber++);
      const cropName = `${entryId}.jpg`;
      await makeCrop(display, join(cropsDir, cropName), item.region);
      const meta = {
        id: entryId, sequence: entrySequence++, author: null, date: null, date_text: null,
        page: item.page, source_image: imageId, region: item.region, status: "needs-review",
        transcription_provider: null, transcribed_at: null,
      };
      validateMeta(meta);
      await writeFile(join(entriesDir, `${entryId}.md`), serializeEntry(meta, ""), { encoding: "utf8", mode: 0o600 });
      entryIds.push(entryId);
    }
    const image = {
      id: imageId, sequence: imageSequence, originalName: basename(originalName), originalFile: archivedName,
      displayFile: `/api/notebook/assets/pages/${imageId}.jpg`, thumbnailFile: `/api/notebook/assets/thumbnails/${imageId}.jpg`,
      checksum, rotation: 0, layout: layout === "single" ? "single" : "spread", entryIds,
    };
    book.images.push(image);
    await atomicJson(manifestPath, book);
    return { duplicate: false, image };
  }

  async function rotateImage(id, rotation) {
    if (!/^image-\d{4,}$/.test(id) || ![0, 90, 180, 270].includes(rotation)) return { status: 400, error: "Invalid rotation" };
    const book = await manifest();
    const image = book.images.find((item) => item.id === id);
    if (!image) return { status: 404, error: "Image not found" };
    image.rotation = rotation;
    await atomicJson(manifestPath, book);
    return { status: 200, data: image };
  }

  async function changeImageLayout(id, layout) {
    if (!/^image-\d{4,}$/.test(id) || !["single", "spread"].includes(layout)) return { status: 400, error: "Invalid image layout" };
    const book = await manifest();
    const image = book.images.find((item) => item.id === id);
    if (!image) return { status: 404, error: "Image not found" };
    if (image.layout === layout) return { status: 200, data: { image, archived: false } };
    const linked = [];
    for (const entryId of image.entryIds) {
      const entry = await findEntry(entryId);
      if (!entry) return { status: 409, error: `Linked entry ${entryId} is missing` };
      linked.push(entry);
    }
    if ((image.layout === "single" && linked.length !== 1) || (image.layout === "spread" && linked.length !== 2)) {
      return { status: 409, error: "This photo has an unexpected entry layout and was not changed" };
    }

    const archiveName = `${new Date().toISOString().replace(/[:.]/g, "-")}--${image.id}--to-${layout}`;
    const archivePath = join(entryArchiveDir, archiveName);
    await mkdir(archivePath, { recursive: true });
    for (const entry of linked) await copyFile(entry.path, join(archivePath, entry.name));

    const displayPath = join(displaysDir, `${image.id}.jpg`);
    const primary = linked[0];
    if (layout === "spread") {
      const entries = await allEntries();
      const nextSequence = entries.reduce((highest, entry) => Math.max(highest, Number(entry.meta.sequence)), 0) + 1;
      const nextNumericId = nextEntryNumber(book, entries);
      const rightId = padId("entry", nextNumericId);
      const primaryMeta = {
        ...primary.meta, page: "left", region: [0, 0, 0.5, 1],
        status: primary.body.trim() ? "needs-review" : primary.meta.status,
      };
      const rightMeta = {
        id: rightId, sequence: nextSequence, author: null, date: null, date_text: null,
        page: "right", source_image: image.id, region: [0.5, 0, 0.5, 1], status: "needs-review",
        transcription_provider: null, transcribed_at: null,
      };
      validateMeta(primaryMeta);
      validateMeta(rightMeta);
      await makeCrop(displayPath, join(cropsDir, `${primary.meta.id}.jpg`), primaryMeta.region);
      await makeCrop(displayPath, join(cropsDir, `${rightId}.jpg`), rightMeta.region);
      await atomicText(primary.path, serializeEntry(primaryMeta, primary.body));
      await writeFile(join(entriesDir, `${rightId}.md`), serializeEntry(rightMeta, ""), { encoding: "utf8", mode: 0o600, flag: "wx" });
      image.layout = "spread";
      image.entryIds = [primary.meta.id, rightId];
    } else {
      const secondary = linked[1];
      const bodyParts = linked.map((entry) => entry.body.trim()).filter(Boolean);
      const mergedBody = bodyParts.length ? `${bodyParts.join("\n\n")}\n` : "";
      const sharedValue = (key) => {
        const values = [...new Set(linked.map((entry) => entry.meta[key]).filter((value) => value != null && value !== ""))];
        return values.length === 1 ? values[0] : null;
      };
      const primaryMeta = {
        ...primary.meta,
        author: sharedValue("author"), date: sharedValue("date"), date_text: sharedValue("date_text"),
        page: null, region: [0, 0, 1, 1],
        status: linked.every((entry) => entry.meta.status === "reviewed") ? "reviewed" : "needs-review",
      };
      validateMeta(primaryMeta);
      await makeCrop(displayPath, join(cropsDir, `${primary.meta.id}.jpg`), primaryMeta.region);
      await atomicText(primary.path, serializeEntry(primaryMeta, mergedBody));
      image.layout = "single";
      image.entryIds = [primary.meta.id];
      book.retiredEntryIds = [...new Set([...(book.retiredEntryIds || []), secondary.meta.id])];
      await rm(secondary.path, { force: true });
      await rm(join(cropsDir, `${secondary.meta.id}.jpg`), { force: true });
    }
    image.layoutChangedAt = new Date().toISOString();
    await atomicJson(manifestPath, book);
    return { status: 200, data: { image, archived: true, archivePath } };
  }

  async function rawVision(cropPath) {
    if (options.visionRunner) return options.visionRunner(cropPath);
    if (process.platform !== "darwin" || !existsSync("/usr/bin/swift")) return null;
    try {
      const { stdout } = await run("/usr/bin/swift", [join(projectRoot, "scripts", "vision-ocr.swift"), cropPath], { timeout: 180_000 });
      const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
      return parsed.lines.map((line) => line.text).join("\n");
    } catch { return null; }
  }

  async function actualCodexRunner({ cropPath, displayPath, prompt, jobDir, onProgress }) {
    const codex = await locateCodex();
    if (!codex) throw new Error("Codex was not found. Install Codex or set CODEX_BIN.");
    const resultPath = join(jobDir, "result.json");
    const args = [
      "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--json",
      "-C", jobDir, "--image", cropPath, "--image", displayPath,
      "--output-schema", schemaPath, "--output-last-message", resultPath, "-",
    ];
    await spawnCodex(codex, args, prompt, onProgress);
    return JSON.parse(await readFile(resultPath, "utf8"));
  }

  async function transcribe(id, mode = "careful", onProgress = () => {}) {
    const entry = await findEntry(id);
    if (!entry) return { status: 404, error: "Entry not found" };
    const book = await manifest();
    const image = book.images.find((item) => item.id === entry.meta.source_image);
    if (!image) return { status: 404, error: "Source image not found" };
    const cropPath = join(cropsDir, `${id}.jpg`);
    const displayPath = join(displaysDir, `${image.id}.jpg`);
    onProgress({ stage: "prepare", message: "Preparing the page images…" });
    onProgress({ stage: "ocr", message: "Running optional on-device OCR for extra hints…" });
    const rawOcr = await rawVision(cropPath);
    onProgress({ stage: "ocr", message: rawOcr ? "On-device OCR hint ready." : "Continuing with image reading; no OCR hint is available." });
    const basePrompt = await readFile(promptPath, "utf8");
    const jobDir = await mkdtemp(join(jobsDir, `${id}-`));
    const runner = options.codexRunner || actualCodexRunner;
    try {
      onProgress({ stage: "pass", message: mode === "extra-careful" ? "Starting transcription pass 1 of 2…" : "Starting the careful transcription pass…" });
      const firstPrompt = `${basePrompt}\n\nPAGE POSITION: ${entry.meta.page || "not specified"}\nCURRENT MARKDOWN:\n${entry.body || "(empty)"}\n\nNOISY APPLE VISION OCR:\n${rawOcr || "(unavailable)"}`;
      let result = await runner({ cropPath, displayPath, prompt: firstPrompt, jobDir, mode: "careful", onProgress });
      if (!result || typeof result.markdown !== "string") throw new Error("Codex returned an invalid transcription");
      if (mode === "extra-careful") {
        onProgress({ stage: "pass", message: "Starting independent verification pass 2 of 2…" });
        const verifyPrompt = `${basePrompt}\n\nThis is an independent verification pass. Re-read every handwritten line in the images and correct the proposed transcription. Do not preserve a proposed word merely because it appears below.\n\nPROPOSED RESULT:\n${JSON.stringify(result)}\n\nNOISY APPLE VISION OCR:\n${rawOcr || "(unavailable)"}`;
        result = await runner({ cropPath, displayPath, prompt: verifyPrompt, jobDir, mode: "extra-careful", onProgress });
        if (!result || typeof result.markdown !== "string") throw new Error("Codex returned an invalid verification result");
      }
      onProgress({ stage: "save", message: "Validating the draft and saving Markdown…" });
      const meta = {
        ...entry.meta,
        date_text: entry.meta.date_text || result.date_text || null,
        date: entry.meta.date || (/^\d{4}-\d{2}-\d{2}$/.test(result.date_iso || "") ? result.date_iso : null),
        status: "needs-review",
        transcription_provider: mode === "extra-careful" ? "codex-extra-careful" : "codex-careful",
        transcribed_at: new Date().toISOString(),
      };
      validateMeta(meta);
      const content = serializeEntry(meta, result.markdown);
      const temporary = `${entry.path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, entry.path);
      return {
        status: 200,
        data: { meta, body: result.markdown, filename: entry.name, revision: revisionFor(content), warnings: result.warnings || [], visionUsed: Boolean(rawOcr) },
      };
    } catch (error) {
      return { status: 500, error: error instanceof Error ? error.message : "Transcription failed" };
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  }

  async function revealEntry(id) {
    const entry = await findEntry(id);
    if (!entry) return { status: 404, error: "Entry not found" };
    if (options.revealFile) await options.revealFile(entry.path);
    else if (process.platform === "darwin") await run("/usr/bin/open", ["-R", entry.path], { timeout: 8_000 });
    else if (process.platform === "win32") await run("explorer.exe", ["/select,", entry.path], { timeout: 8_000 });
    else await run("xdg-open", [entriesDir], { timeout: 8_000 });
    return { status: 200, data: { filename: entry.name } };
  }

  function assetPath(kind, name) {
    if (!/^[a-z0-9-]+\.jpg$/.test(name)) return null;
    const parent = kind === "pages" ? displaysDir : kind === "thumbnails" ? thumbsDir : kind === "crops" ? cropsDir : null;
    if (!parent) return null;
    const path = join(parent, name);
    return inside(parent, path) ? path : null;
  }

  return { list, get, update, importFile, rotateImage, changeImageLayout, transcribe, revealEntry, assetPath, init, libraryDir };
}

async function readBody(request, limit = 2_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch { return false; }
}

async function receiveUploads(request) {
  const directory = await mkdtemp(join(tmpdir(), "notebook-digitizer-upload-"));
  const uploads = [];
  const writes = [];
  let uploadError = null;
  const busboy = Busboy({ headers: request.headers, limits: { files: 100, fileSize: 120 * 1024 * 1024, fields: 10 } });
  busboy.on("file", (_field, stream, info) => {
    let extension;
    try { extension = safeExtension(info.filename); }
    catch (error) { uploadError = error; stream.resume(); return; }
    const path = join(directory, `${randomUUID()}${extension}`);
    uploads.push({ path, originalName: basename(info.filename) });
    const output = createWriteStream(path, { mode: 0o600 });
    stream.pipe(output);
    writes.push(new Promise((resolvePromise, rejectPromise) => {
      output.on("finish", resolvePromise);
      output.on("error", rejectPromise);
      stream.on("limit", () => rejectPromise(new Error(`${info.filename} is too large`)));
    }));
  });
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      busboy.on("close", resolvePromise);
      busboy.on("error", rejectPromise);
      request.pipe(busboy);
    });
    await Promise.all(writes);
    if (uploadError) throw uploadError;
    return { directory, uploads };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function localNotebookPlugin(projectRoot = process.cwd()) {
  const store = createNotebookStore(projectRoot);
  const middleware = async (request, response, next) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/notebook")) return next();
    try {
      if (request.method !== "GET" && !sameOrigin(request)) return send(response, 403, { error: "Cross-origin request rejected" });
      if (request.method === "GET" && url.pathname === "/api/notebook") return send(response, 200, await store.list());
      if (request.method === "POST" && url.pathname === "/api/notebook/import") {
        const layout = url.searchParams.get("layout") === "spread" ? "spread" : "single";
        const received = await receiveUploads(request);
        try {
          const results = [];
          for (const upload of received.uploads) results.push(await store.importFile(upload.path, upload.originalName, layout));
          return send(response, 200, { results, index: await store.list() });
        } finally { await rm(received.directory, { recursive: true, force: true }); }
      }
      const asset = url.pathname.match(/^\/api\/notebook\/assets\/(pages|thumbnails|crops)\/([a-z0-9-]+\.jpg)$/);
      if (request.method === "GET" && asset) {
        const path = store.assetPath(asset[1], asset[2]);
        if (!path) return send(response, 404, { error: "Asset not found" });
        await access(path);
        response.statusCode = 200;
        response.setHeader("Content-Type", "image/jpeg");
        response.setHeader("Cache-Control", "private, max-age=3600");
        return createReadStream(path).pipe(response);
      }
      const entry = url.pathname.match(/^\/api\/notebook\/entries\/(entry-\d{4,})$/);
      if (entry && request.method === "GET") {
        const result = await store.get(entry[1]);
        return result ? send(response, 200, result) : send(response, 404, { error: "Entry not found" });
      }
      if (entry && request.method === "PUT") {
        const result = await store.update(entry[1], await readBody(request));
        return send(response, result.status, result.data || { error: result.error });
      }
      const transcribe = url.pathname.match(/^\/api\/notebook\/entries\/(entry-\d{4,})\/transcribe$/);
      if (transcribe && request.method === "POST") {
        const body = await readBody(request);
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.flushHeaders?.();
        const writeEvent = (value) => {
          if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(value)}\n`);
        };
        const result = await store.transcribe(
          transcribe[1],
          body.mode === "extra-careful" ? "extra-careful" : "careful",
          (progress) => writeEvent({ type: "progress", ...progress }),
        );
        writeEvent(result.status === 200
          ? { type: "complete", data: result.data }
          : { type: "error", error: result.error || "Transcription failed" });
        return response.end();
      }
      const reveal = url.pathname.match(/^\/api\/notebook\/entries\/(entry-\d{4,})\/reveal$/);
      if (reveal && request.method === "POST") {
        const result = await store.revealEntry(reveal[1]);
        return send(response, result.status, result.data || { error: result.error });
      }
      const layout = url.pathname.match(/^\/api\/notebook\/images\/(image-\d{4,})\/layout$/);
      if (layout && request.method === "PATCH") {
        const body = await readBody(request);
        const result = await store.changeImageLayout(layout[1], body.layout);
        return send(response, result.status, result.data || { error: result.error });
      }
      const image = url.pathname.match(/^\/api\/notebook\/images\/(image-\d{4,})$/);
      if (image && request.method === "PATCH") {
        const result = await store.rotateImage(image[1], Number((await readBody(request)).rotation));
        return send(response, result.status, result.data || { error: result.error });
      }
      return send(response, 404, { error: "Not found" });
    } catch (error) {
      return send(response, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
    }
  };
  return {
    name: "local-notebook-service",
    apply: "serve",
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
