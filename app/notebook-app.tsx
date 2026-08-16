"use client";
/* eslint-disable @next/next/no-img-element -- images are served by the loopback-only notebook service */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Status = "needs-review" | "reviewed";
type Page = "single" | "left" | "right" | null;
type EntrySummary = {
  id: string; sequence: number; author: string | null; date: string | null; date_text: string | null;
  page: Page; source_image: string; region: number[]; status: Status; transcription_provider: string | null;
  transcribed_at: string | null; filename: string; preview: string; hasContent: boolean; uncertaintyCount: number;
};
type NotebookImage = {
  id: string; sequence: number; originalName: string; originalFile: string; displayFile: string;
  thumbnailFile: string; checksum: string; rotation: number; layout: "single" | "spread"; entryIds: string[];
};
type EntryDetail = { meta: EntrySummary; body: string; filename: string; revision: string; warnings?: string[]; visionUsed?: boolean };
type Index = {
  notebook: { title: string; libraryPath: string };
  images: NotebookImage[]; entries: EntrySummary[];
  codex: { available: boolean; version: string | null; message?: string };
  visionAvailable: boolean;
};
type TranscriptionProgress = { stage: string; message: string };

const emptyIndex: Index = {
  notebook: { title: "My Notebook", libraryPath: "" }, images: [], entries: [],
  codex: { available: false, version: null }, visionAvailable: false,
};

async function valueOf(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "The local notebook service returned an error.");
  return value;
}

const api = {
  index: () => fetch("/api/notebook", { cache: "no-store" }).then(valueOf) as Promise<Index>,
  entry: (id: string) => fetch(`/api/notebook/entries/${id}`, { cache: "no-store" }).then(valueOf) as Promise<EntryDetail>,
  save: (detail: EntryDetail) => fetch(`/api/notebook/entries/${detail.meta.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: detail.revision, meta: detail.meta, body: detail.body }),
  }).then(valueOf) as Promise<EntryDetail>,
  import: (files: FileList, layout: "single" | "spread") => {
    const form = new FormData();
    Array.from(files).forEach((file) => form.append("photos", file));
    return fetch(`/api/notebook/import?layout=${layout}`, { method: "POST", body: form }).then(valueOf);
  },
  rotate: (id: string, rotation: number) => fetch(`/api/notebook/images/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotation }),
  }).then(valueOf),
  layout: (id: string, layout: "single" | "spread") => fetch(`/api/notebook/images/${id}/layout`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }),
  }).then(valueOf) as Promise<{ image: NotebookImage; archived: boolean; archivePath?: string }>,
  transcribe: async (id: string, mode: "careful" | "extra-careful", onProgress: (event: TranscriptionProgress) => void) => {
    const response = await fetch(`/api/notebook/entries/${id}/transcribe`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
    });
    if (!response.ok) return valueOf(response) as Promise<EntryDetail>;
    if (!response.body) throw new Error("This browser could not read the transcription progress stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed: EntryDetail | null = null;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "progress") onProgress({ stage: String(event.stage || "codex"), message: String(event.message || "Working…") });
      else if (event.type === "complete") completed = event.data as EntryDetail;
      else if (event.type === "error") throw new Error(event.error || "Transcription failed");
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(consume);
      if (done) break;
    }
    consume(buffer);
    if (!completed) throw new Error("The transcription stream ended before a draft was returned.");
    return completed as EntryDetail;
  },
  reveal: (id: string) => fetch(`/api/notebook/entries/${id}/reveal`, { method: "POST" }).then(valueOf),
};

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

export default function NotebookApp() {
  const [index, setIndex] = useState<Index>(emptyIndex);
  const [imageIndex, setImageIndex] = useState(0);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptionLog, setTranscriptionLog] = useState<TranscriptionProgress[]>([]);
  const [notice, setNotice] = useState("Opening your local library…");
  const [layout, setLayout] = useState<"single" | "spread">("single");
  const [mode, setMode] = useState<"careful" | "extra-careful">("extra-careful");
  const [consent, setConsent] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [railOpen, setRailOpen] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const transcriptionTail = useRef<HTMLDivElement>(null);
  const detailRef = useRef<EntryDetail | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentImage = index.images[imageIndex] || null;
  const imageEntries = useMemo(() => currentImage
    ? currentImage.entryIds.map((id) => index.entries.find((entry) => entry.id === id)).filter(Boolean) as EntrySummary[]
    : [], [currentImage, index.entries]);
  const reviewed = index.entries.filter((entry) => entry.status === "reviewed").length;
  const progress = index.entries.length ? Math.round(reviewed / index.entries.length * 100) : 0;

  const refresh = useCallback(async () => {
    const value = await api.index();
    setIndex(value);
    return value;
  }, []);

  useEffect(() => {
    let active = true;
    api.index().then((value) => {
      if (!active) return;
      setIndex(value);
      setEntryId(value.images[0]?.entryIds[0] || null);
      setNotice("");
    }).catch((error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => { detailRef.current = detail; }, [detail]);
  useEffect(() => {
    if (transcriptionTail.current) transcriptionTail.current.scrollTop = transcriptionTail.current.scrollHeight;
  }, [transcriptionLog]);
  useEffect(() => {
    if (!entryId) return;
    let active = true;
    api.entry(entryId).then((value) => {
      if (!active) return;
      setDetail(value); setDirty(false); setNotice("");
    }).catch((error) => { if (active) setNotice(error.message); });
    return () => { active = false; };
  }, [entryId]);

  const save = useCallback(async (override?: EntryDetail) => {
    const value = override || detailRef.current;
    if (!value || saving) return value;
    setSaving(true); setNotice("Saving…");
    try {
      const saved = await api.save(value);
      setDetail(saved); detailRef.current = saved; setDirty(false);
      await refresh(); setNotice("Saved");
      window.setTimeout(() => setNotice((current) => current === "Saved" ? "" : current), 1200);
      return saved;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed");
      return value;
    } finally { setSaving(false); }
  }, [refresh, saving]);

  const changeDetail = useCallback((change: (value: EntryDetail) => EntryDetail) => {
    setDetail((value) => {
      if (!value) return value;
      const next = change(value); detailRef.current = next; return next;
    });
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(detailRef.current || undefined), 900);
  }, [save]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const selectImage = async (next: number) => {
    if (dirty) await save();
    const bounded = Math.max(0, Math.min(index.images.length - 1, next));
    setImageIndex(bounded); setEntryId(index.images[bounded]?.entryIds[0] || null); setZoom(1);
  };

  const selectEntry = async (id: string) => {
    if (dirty) await save();
    setEntryId(id);
  };

  const importPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true); setNotice(`Importing ${files.length} ${files.length === 1 ? "photograph" : "photographs"}…`);
    try {
      const result = await api.import(files, layout);
      setIndex(result.index);
      const firstAdded = result.results.find((item: { duplicate: boolean }) => !item.duplicate)?.image;
      if (firstAdded) {
        const nextIndex = result.index.images.findIndex((image: NotebookImage) => image.id === firstAdded.id);
        setImageIndex(nextIndex); setEntryId(firstAdded.entryIds[0]);
      }
      const duplicates = result.results.filter((item: { duplicate: boolean }) => item.duplicate).length;
      setNotice(duplicates ? `Imported with ${duplicates} duplicate ${duplicates === 1 ? "photo" : "photos"} skipped.` : "Import complete");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Import failed"); }
    finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const rotate = async (delta: number) => {
    if (!currentImage) return;
    const rotation = (currentImage.rotation + delta + 360) % 360;
    try {
      await api.rotate(currentImage.id, rotation);
      setIndex((value) => ({ ...value, images: value.images.map((image) => image.id === currentImage.id ? { ...image, rotation } : image) }));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Rotation failed"); }
  };

  const changeImageLayout = async (nextLayout: "single" | "spread") => {
    if (!currentImage || currentImage.layout === nextLayout || busy) return;
    const affected = imageEntries.some((entry) => entry.hasContent || entry.status === "reviewed");
    if (affected) {
      const message = nextLayout === "spread"
        ? "Change this photo to left and right pages? Existing text stays on the new left page and will be marked for review. A backup is archived locally."
        : "Combine the left and right pages? Their Markdown text will be joined into one entry. Both original files are archived locally for recovery.";
      if (!window.confirm(message)) return;
    }
    if (dirty) await save();
    const imageId = currentImage.id;
    setBusy(true);
    setNotice(nextLayout === "spread" ? "Splitting this photo into left and right pages…" : "Combining this photo into one page…");
    try {
      const result = await api.layout(imageId, nextLayout);
      const nextIndex = await refresh();
      const position = nextIndex.images.findIndex((image) => image.id === imageId);
      const updatedImage = nextIndex.images[position];
      if (position >= 0) setImageIndex(position);
      setEntryId(updatedImage?.entryIds[0] || result.image.entryIds[0] || null);
      setTranscriptionLog([]);
      setNotice(`${nextLayout === "spread" ? "Now using left and right pages" : "Now using one page"}${result.archived ? " · previous Markdown archived" : ""}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Page layout change failed");
    } finally { setBusy(false); }
  };

  const transcribe = async () => {
    if (!detail || !consent) return;
    if (dirty) await save();
    const targetEntryId = detail.meta.id;
    setBusy(true); setTranscribing(true); setTranscriptionLog([{ stage: "start", message: "Starting local transcription job…" }]);
    setNotice(mode === "extra-careful" ? "Codex is transcribing and then verifying this page…" : "Codex is carefully transcribing this page…");
    try {
      const result = await api.transcribe(targetEntryId, mode, (event) => {
        setTranscriptionLog((current) => {
          if (current.at(-1)?.message === event.message) return current;
          return [...current.slice(-49), event];
        });
      });
      setTranscriptionLog((current) => [...current.slice(-49), { stage: "complete", message: "Draft saved locally and ready for review." }]);
      if (detailRef.current?.meta.id === targetEntryId) {
        setDetail(result); detailRef.current = result; setDirty(false);
      }
      await refresh();
      setNotice(result.warnings?.length ? `Draft ready · ${result.warnings.join(" ")}` : "Codex draft ready for review");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Transcription failed";
      setTranscriptionLog((current) => [...current.slice(-49), { stage: "error", message: `Stopped: ${message}` }]);
      setNotice(message);
    }
    finally { setBusy(false); setTranscribing(false); }
  };

  const markReviewed = async () => {
    if (!detail) return;
    const next = { ...detail, meta: { ...detail.meta, status: "reviewed" as Status } };
    setDetail(next); detailRef.current = next; setDirty(true);
    await save(next);
    const position = imageEntries.findIndex((entry) => entry.id === detail.meta.id);
    if (position >= 0 && position < imageEntries.length - 1) setEntryId(imageEntries[position + 1].id);
    else if (imageIndex < index.images.length - 1) await selectImage(imageIndex + 1);
  };

  const updateConsent = (checked: boolean) => {
    setConsent(checked);
  };

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand">
        <button className="round-button" onClick={() => setRailOpen((value) => !value)} aria-label="Toggle photograph list"><Icon>☰</Icon></button>
        <div><p className="eyebrow">PRIVATE LOCAL ARCHIVE</p><h1>Notebook Digitizer</h1></div>
      </div>
      <div className="progress" aria-label={`${reviewed} of ${index.entries.length} pages reviewed`}>
        <div><span>{reviewed} of {index.entries.length} pages reviewed</span><strong>{progress}%</strong></div>
        <i><span style={{ width: `${progress}%` }} /></i>
      </div>
      <div className="top-actions">
        <select value={layout} onChange={(event) => setLayout(event.target.value as "single" | "spread")} aria-label="Page layout for imported photos">
          <option value="single">One page per photo</option><option value="spread">Two-page spread · left + right</option>
        </select>
        <input ref={fileInput} hidden type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.tif,.tiff" onChange={(event) => importPhotos(event.target.files)} />
        <button className="primary-button" onClick={() => fileInput.current?.click()} disabled={busy}><Icon>＋</Icon>Add photos</button>
      </div>
    </header>

    <div className={`workspace ${railOpen ? "rail-open" : ""}`}>
      <aside className="photo-rail">
        <div className="rail-heading"><span>Photographs</span><span>{index.images.length}</span></div>
        <div className="thumb-list">
          {index.images.map((image, position) => {
            const linked = image.entryIds.map((id) => index.entries.find((entry) => entry.id === id)).filter(Boolean) as EntrySummary[];
            const reviewedPages = linked.filter((entry) => entry.status === "reviewed").length;
            const done = linked.length > 0 && reviewedPages === linked.length;
            const label = done ? "Reviewed" : reviewedPages ? `${reviewedPages}/${linked.length} reviewed` : "Needs review";
            return <button key={image.id} className={`thumb ${position === imageIndex ? "active" : ""}`} onClick={() => selectImage(position)}>
              <span className="thumb-image"><img src={image.thumbnailFile} alt="" style={{ transform: `rotate(${image.rotation}deg)` }} /><i className={done ? "done" : ""}>{done ? "✓" : linked.length}</i></span>
              <span className="thumb-copy"><strong>{image.originalName}</strong><small>{linked.length} {linked.length === 1 ? "page" : "pages"}</small><em className={done ? "reviewed" : reviewedPages ? "partial" : ""}>{label}</em></span>
            </button>;
          })}
        </div>
      </aside>

      {currentImage ? <section className="review-area">
        <div className="image-panel">
          <div className="panel-bar"><div><p className="eyebrow">SOURCE PHOTOGRAPH</p><strong>{currentImage.originalName}</strong></div><div className="panel-actions"><label><span>Pages in photo</span><select aria-label="Pages in this photograph" value={currentImage.layout} disabled={busy} onChange={(event) => changeImageLayout(event.target.value as "single" | "spread")}><option value="single">One page</option><option value="spread">Left + right</option></select></label><span>{imageIndex + 1} / {index.images.length}</span></div></div>
          <div className="image-viewer"><img src={currentImage.displayFile} alt={`Source photograph ${currentImage.originalName}`} style={{ transform: `scale(${zoom}) rotate(${currentImage.rotation}deg)` }} /></div>
          <div className="viewer-controls">
            <div><button onClick={() => rotate(-90)} aria-label="Rotate left">↶</button><button onClick={() => rotate(90)} aria-label="Rotate right">↷</button></div>
            <div><button onClick={() => setZoom((value) => Math.max(.55, value - .15))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((value) => Math.min(3, value + .15))}>+</button></div>
          </div>
        </div>

        <div className={`editor-panel ${transcribing || transcriptionLog.length > 0 ? "has-activity" : ""}`}>
          <div className="entry-tabs" role="tablist">
            {imageEntries.map((entry) => <button key={entry.id} role="tab" aria-selected={entry.id === entryId} className={entry.id === entryId ? "active" : ""} onClick={() => selectEntry(entry.id)}>
              {entry.page === "left" ? "Left page" : entry.page === "right" ? "Right page" : "Page"}{entry.uncertaintyCount > 0 && <i>{entry.uncertaintyCount}</i>}
            </button>)}
          </div>
          {detail ? <>
            <div className="metadata">
              <label><span>Written by</span><input value={detail.meta.author || ""} placeholder="Unknown" onChange={(event) => changeDetail((value) => ({ ...value, meta: { ...value.meta, author: event.target.value || null } }))} /></label>
              <label><span>Written date</span><input value={detail.meta.date_text || ""} placeholder="Exactly as written" onChange={(event) => changeDetail((value) => ({ ...value, meta: { ...value.meta, date_text: event.target.value || null } }))} /></label>
              <label><span>ISO date</span><input type="date" value={detail.meta.date || ""} onChange={(event) => changeDetail((value) => ({ ...value, meta: { ...value.meta, date: event.target.value || null } }))} /></label>
            </div>
            <div className="transcription-bar">
              <div><p className="eyebrow">CODEX-ASSISTED TRANSCRIPTION</p><span className={`connection ${index.codex.available ? "connected" : ""}`}>{index.codex.available ? `Codex ready · ${index.codex.version}` : "Codex not found"}</span></div>
              <div className="transcription-actions">
                <select value={mode} onChange={(event) => setMode(event.target.value as "careful" | "extra-careful")} aria-label="Transcription quality"><option value="careful">Careful</option><option value="extra-careful">Extra careful · two passes</option></select>
                <button onClick={transcribe} disabled={busy || !index.codex.available || !consent}>{busy ? "Working…" : detail.body.trim() ? "Retranscribe" : "Transcribe page"}</button>
              </div>
            </div>
            <label className="consent"><input type="checkbox" checked={consent} onChange={(event) => updateConsent(event.target.checked)} /><span>Allow selected page images to be processed through my Codex account. Originals and Markdown remain local.</span></label>
            {(transcribing || transcriptionLog.length > 0) && <section className={`transcription-live ${transcribing ? "running" : "finished"}`} aria-label="Transcription activity">
              <header><div><span className="live-dot" /><strong>{transcribing ? "Transcribing now" : "Last transcription run"}</strong></div><button onClick={() => setTranscriptionLog([])} disabled={transcribing}>Clear</button></header>
              <div className="transcription-tail" ref={transcriptionTail} aria-live="polite">
                {transcriptionLog.map((event, position) => <p key={`${position}-${event.message}`} className={event.stage}><i>{position + 1}</i><span>{event.message}</span></p>)}
              </div>
            </section>}
            <div className="editor-heading"><div><p className="eyebrow">MARKDOWN TRANSCRIPTION</p><span className={`status ${detail.meta.status}`}>{detail.meta.status === "reviewed" ? "Reviewed" : "Needs review"}</span></div><button className="finder" onClick={() => api.reveal(detail.meta.id).then(() => setNotice("Shown in your file manager")).catch((error) => setNotice(error.message))}>Show file</button></div>
            <textarea className="markdown-editor" spellCheck={false} value={detail.body} placeholder="Transcribe manually, or use the Codex-assisted draft above…" onChange={(event) => changeDetail((value) => ({ ...value, body: event.target.value }))} />
            <div className="editor-footer"><span><kbd>⌘</kbd><kbd>S</kbd> saves · use <code>[unclear: …]</code> where needed</span><button onClick={markReviewed}>Mark reviewed &amp; next <Icon>→</Icon></button></div>
          </> : <div className="empty-editor">Select a page to begin.</div>}
        </div>
      </section> : <section className="welcome">
        <div className="welcome-card"><p className="eyebrow">A QUIET HOME FOR HANDWRITTEN PAGES</p><h2>Turn a photographed notebook into an archive you can trust.</h2><p>Import source photographs, create one local Markdown file per page, and use Codex to prepare careful drafts that always remain marked for review.</p><div className="welcome-steps"><span><b>1</b> Choose one page per photo, or opt into left/right splitting for spreads.</span><span><b>2</b> Add JPEG, PNG, WebP, TIFF or HEIC images.</span><span><b>3</b> Watch Codex transcribe, then correct and review each page.</span></div><button className="primary-button large" onClick={() => fileInput.current?.click()} disabled={busy}>Add your first photographs</button></div>
      </section>}
    </div>

    <footer className="footer"><span className={dirty ? "dirty" : ""}>{saving ? "Saving…" : dirty ? "Unsaved changes" : notice || "All changes saved"}</span><span title={index.notebook.libraryPath}>Library · {index.notebook.libraryPath || "preparing…"}</span><span>{index.visionAvailable ? "Apple Vision available" : "Apple Vision unavailable"}</span></footer>
  </main>;
}
