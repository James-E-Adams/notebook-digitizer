# Security and privacy

Notebook Digitizer is designed to run on the loopback interface. Do not expose its development server to a public network.

- The local service rejects cross-origin mutations and confines file access to the configured library directories.
- Codex runs with a read-only sandbox and returns schema-constrained data. It does not receive write access to the notebook library.
- The app invokes Codex without a shell to prevent command injection through filenames or metadata.
- Codex transcription is opt-in in the interface. Selected images leave the device for processing according to the user's Codex account and settings.
- Apple Vision OCR runs locally on supported macOS systems.

Report security issues privately to the repository maintainer rather than opening a public issue with exploit details or private notebook data.
