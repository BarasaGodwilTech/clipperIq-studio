[OPEN]

# Debug Session: clips-generation-error

## Symptom
- Clips are not being generated; user reports errors during generation.

## Expected
- Clips generate successfully (local or cloud processing) and appear in the Clips view.

## Environment
- PWA frontend
- Node/Express backend (ngrok/VPS possible)

## Hypotheses
- H1: Cloud processing URLs are blocked or unreachable (mixed content / wrong base URL / CORS).
- H2: Cloud upload fails mid-chunk (Content-Range/body mismatch or server limit) causing analyze/job to fail.
- H3: Cloud job completes but clip download fails (bad clip URL, 404, blocked by mixed content, or network error).
- H4: Local generation fails due to MediaRecorder/captureStream limitations or tab throttling, producing empty blobs.
- H5: FFmpeg/ffprobe is missing or failing on the backend, causing analyze/job endpoints to error.

## Evidence Log
- Logs collected via Debug Server: `.dbg/trae-debug-log-clips-generation-error.ndjson`

## Next Actions
- Start Debug Server and add runtime instrumentation to frontend + backend error paths.
- Reproduce the issue and collect logs for analysis.

