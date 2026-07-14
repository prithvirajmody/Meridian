# Recordings

Live-recorded gateway response fixtures for the replay path (`node evals/run.mjs
--replay`). Keyed by `(providerId, model, promptVersion, inputHash)` per
ADR-0030. The physical store key also separates prompt ids, completion vs
embedding, and primary vs repair attempts.

`services.recording.json` is written atomically by the record path
(`node evals/run.mjs --record … --task … --consent-live`, needs the matching
key). Summarize and cluster runs replace their own entries and preserve the
other, allowing the two tasks to use different providers. It is intentionally
absent until a human records both tasks; `--replay` fails clearly when the file
or either required entry is missing. Automated tests prove the same format using
temporary fake-provider recordings and never write here.

Do not hand-edit recordings; regenerate them with `--record`.
